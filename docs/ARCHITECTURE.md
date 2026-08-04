# Architecture

Six processes, one Postgres. Every component is small enough to read in a
sitting; this file tells you where to look and why each piece is shaped the
way it is.

## Components

| Process      | Code                | Role                                                                                                                                                                                                      |
| ------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| api          | `apps/api`          | HTTP surface: payment intents behind the idempotency pipeline, webhook endpoint registration, DLQ ops, read models for the dashboard                                                                      |
| worker       | `apps/worker`       | Claims jobs from the hand-rolled Postgres queue: webhook delivery, the completer, reconciliation. Also runs the outbox fan-out and the lease sweeper                                                      |
| provider-sim | `apps/provider-sim` | The card provider, adversarial on purpose: configurable declines, latency, timeout-after-charge, duplicate callbacks. `GET /truth` is the authoritative charge list the reconciler audits against         |
| receiver     | `apps/receiver`     | Demo merchant endpoint and the reference webhook consumer: raw-body signature verification, staleness check, dedupe on event id                                                                           |
| dashboard    | `apps/dashboard`    | React + Vite SPA (react-router, Tailwind v4, shadcn-style Radix UI) built to `dist` and served by a small Fastify process with a same-origin proxy to the api. Read-only read models, plus the playground |
| postgres     | `packages/db`       | Schema, migrations (node-pg-migrate), seed. The queue, the outbox, the ledger and the idempotency keys are all plain tables here                                                                          |

Domain logic with no I/O lives in `packages/core` (ledger validation, intent
state machine, queue SQL helpers, fee math, webhook signing). That is where
the unit tests are.

## Data flow of one payment

`POST /v1/payment_intents` with an `Idempotency-Key` header. The middleware
upserts the key row; `UNIQUE(merchant_id, key)` makes exactly one concurrent
first request the owner, everyone else either replays the stored response,
gets `409 in-progress`, or `409 conflict` if the body hash differs.

The owner then runs the pipeline (`apps/api/src/pipeline.ts`) as **atomic
phases**. Each phase commits its effects and the advance of
`recovery_point` in one transaction; that pointer is the recovery trail:

```
started
  └─ phase: insert intent + outbox event ..................... intent_created
       └─ provider POST /charges (between phases, never in a TX,
          with derived key `reckon-{keyId}`) .................. provider_charged
            └─ phase: post charge + fee to the ledger ........ ledger_posted
                 └─ phase: succeed intent + store response .... finished
```

A crash anywhere leaves a resumable row. The next request with the same key —
or the background **completer** — re-enters the same loop and continues from
the recovery point instead of restarting. The provider call sits between
phases because it mutates foreign state: we can't roll it back, so we make it
idempotent instead (the derived key means our retries dedupe provider-side)
and never assume a timeout meant "didn't happen".

A declined charge is also a completed request: the failure response is stored
under the key and replays like any other.

## Sync API + completer

The API is synchronous — the happy path returns `succeeded` in one request,
because that is the API you actually want as a client. The worker's completer
is the safety net, not the main path: every few seconds it scans for keys
stuck non-finished past a grace period whose lock is free or stale, enqueues a
`complete_intent` job, and the handler drives the exact same
`runIntentPipeline` the API uses. Same code, same recovery points, different
trigger. Abandoned clients, killed processes and hung providers all converge
to `finished` this way.

## Transactional outbox

Every intent status change inserts a row into `events` in the same transaction
as the `payment_intents` update — the transactional outbox pattern. A state
change and its event cannot disagree, because they commit or roll back
together. The worker drains the outbox (claimed-flag + `SKIP LOCKED`, not a
cursor — commit order is not `created_at` order, and a cursor silently skips
late-committing rows), fans each event out to one delivery per registered
endpoint, and enqueues delivery jobs. A unique index on
`(event_id, endpoint_id)` makes fan-out exactly-once per pair.

## The hand-rolled queue

`jobs` is a table; claiming is one statement:

```sql
UPDATE jobs SET status='running', locked_at=now(), locked_by=$me
WHERE id IN (SELECT id FROM jobs WHERE status='pending' AND run_at <= now()
             ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT $n)
RETURNING *
```

`SKIP LOCKED` is what makes N workers safe: contended rows are skipped, never
waited on, so no two workers claim the same job. Liveness while working is a
heartbeat on `locked_at`; a sweeper returns jobs whose lease expired (the
visibility-timeout idea from asynq). Handlers are idempotent by design, so
at-least-once execution is safe.

I did not use BullMQ or pg-boss because demonstrating the primitive is the
point of this project — the claim loop, lease, sweep and backoff are ~200
lines I can defend line by line. pg-boss and graphile-worker were studied as
the designs to measure against (see DECISIONS.md); this engine has no Redis,
so a Postgres queue also keeps the transactional boundaries in one place: a
job can be enqueued in the same TX as the state change that needs it.

## Reconciler

Two passes, every minute (and on demand via `npm run reconcile`):

- **Internal**: recompute what the write path claims. Every ledger transaction
  balances (drift = Σ|debits − credits|), every succeeded intent has exactly
  one charge + one fee posting with the right amounts, failed intents have no
  postings, no orphaned rows. The posting function already enforces balance at
  write time; the reconciler re-verifies from cold data, because the auditor's
  job is to assume the enforcement was bypassed.
- **External**: diff provider `GET /truth` against our records by derived key.
  A charge whose key never finished is the timeout-after-charge case: the
  reconciler takes the key lock and re-drives the same pipeline (the provider
  replays the original outcome). If the provider is down but `/truth` already
  proved the charge, it applies the charge from truth and lets the pipeline
  finish the ledger locally. A succeeded intent with no provider charge is
  flagged CRITICAL — that is the "should be impossible" class.

Every pass persists a `reconciliation_reports` row, drift or not, so "zero
drift" is a queryable record. The CLI exits non-zero on any violation, which
is what the chaos run (and CI) asserts.

## Read models and dashboard

The read models stay thin: `apps/api/src/read-models.ts` exposes list and
detail queries over the same tables the engine writes (intents with the
recovery-point trail, ledger transactions with entries, derived balances, DLQ,
reconciliation reports). `apps/dashboard` is a React 19 + Vite SPA
(`react-router` routes, Tailwind v4, shadcn-style Radix primitives) that Vite
builds to `dist`; a small Fastify server serves that build with a same-origin
`/api/*` proxy and an SPA fallback, so the browser stays same-origin and the
containerized API stays reachable by service name. The UI polls those read
models and adds the `/play` playground (DECISIONS.md has the full reasoning).
