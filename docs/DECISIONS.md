# Decisions

Non-obvious choices, what was rejected, and why. Three to five lines each.

## npm workspaces (not pnpm, not a polyrepo)

The brief suggested pnpm; I used npm workspaces. One fewer tool to install,
`npm ci` works everywhere Docker and CI already have Node, and at six small
packages the performance difference is noise. Workspace protocol (`"*"`) links
`@reckon/core` and friends without a publish step. Rejected: pnpm (no gain at
this scale), a polyrepo (the packages share one schema and one lifecycle).

## node-pg-migrate for migrations

Plain SQL files, forward-only, run by a tool that does nothing else. Rejected:
Drizzle-kit — a schema DSL hides exactly the SQL this project exists to show
(triggers, partial unique indexes, a view). Migrations are numbered SQL in
`packages/db/migrations`; the migration is the documentation.

## Raw SQL through pg, no ORM

The hot paths are the point: `FOR UPDATE SKIP LOCKED`, `ON CONFLICT DO
NOTHING` upserts, CTE fan-out, `unnest` batch inserts. An ORM would abstract
away the exact things an interviewer should be able to point at. Every query
lives next to the logic that needs it; `packages/core` keeps the pure parts
free of I/O so they unit-test without a database.

## Sync API + async worker, joined by the completer

The client-facing API is synchronous (a payment either succeeds in-request or
returns something actionable), but every recovery path is async: the worker
re-drives stuck keys through the same `runIntentPipeline` the API uses. One
resume loop, two entry points. Rejected: a fully async submit-then-poll API
(worse client ergonomics, and it hides the idempotent-replay behavior that is
the project's thesis).

## Hand-rolled Postgres job queue (not BullMQ / pg-boss)

Demonstrating the primitive is the point: claim via `SKIP LOCKED`, lease via
`locked_at` heartbeat, sweeper as visibility timeout, backoff with jitter —
about 200 lines, all defensible. pg-boss and graphile-worker were studied as
reference designs (their SQL informed the lifecycle columns), asynq for the
visibility-timeout vocabulary. Also structural: no Redis in this stack, and a
Postgres queue lets a job be enqueued in the same TX as domain writes.

## Recovery-point granularity

Five points: `started → intent_created → provider_charged → ledger_posted →
finished`. The rule: a new point exactly where a foreign or non-atomic effect
happens (the provider call splits the pipeline; everything else is local SQL
that can share a TX with the pointer advance). Finer granularity adds resume
cases without adding safety; coarser would re-execute the provider call inside
a TX boundary. This is rocket-rides-atomic's design, re-derived.

## Amount bounds: minimum 50, maximum 2^53−1 (minor units)

Enforced at the schema boundary on `POST /v1/payment_intents` (and mirrored on
the provider-sim). The **minimum of 50** keeps the fixed `+30` fee below the
charge — below ~30 the fee exceeds the payment and `merchant_payable` goes
negative; 50 is Stripe's $0.50 floor, re-derived. The **maximum of 2^53−1** is
the largest integer a JS number carries exactly: `amount_minor` is a JS number
on the wire, so above it the charged amount silently diverges from the
requested one, and above 2^63 the `bigint` column overflows and wedges the key
at `started` forever. Rejected: a bignum JSON codec (huge complexity for a
range no real card payment reaches). The API also rejects a _non-numeric_
`amount_minor` before ajv can coerce `true`→1 or `"100"`→100 into a real charge.

## Fee rounding: floor, in bigint

`fee = amount·29/1000 + 30`, integer division, which truncates (floor for
positive amounts). Rejected: round-half-up (needs a rule for ties, invites
float shortcuts) and floats anywhere near money (never). Floor is
deterministic, reproducible in SQL (`amount_minor * 29 / 1000 + 30`, used by
the reconciler to re-check fees), and errs sub-unit in the customer's favor.

## Append-only ledger enforced by triggers, not policy

`ledger_transactions` and `ledger_entries` reject UPDATE and DELETE with a
database trigger that raises. App-level discipline was rejected because the
auditor (reconciler) must be able to trust cold data even against buggy or
malicious writers with table access. Corrections are new compensating
transactions (`refund`, `reversal`), never edits. TRUNCATE is deliberately
not blocked: resetting a test rig is not an audit-trail edit.

## Balances as a view, never a column

`balances` is `SUM(CASE direction ...)` grouped by account. A stored balance
is a cache that can drift from the entries that justify it; a derived balance
cannot disagree with the ledger (TigerBeetle's framing). The cost is a scan at
read time, which the demo scale never notices. If it ever mattered:
materialize with a refresh, still never hand-written.

## Derived provider idempotency key (`reckon-{keyId}`)

The provider key is computed from our idempotency-key row id, not stored. Any
retry of the same key derives the same provider key, so provider-side dedupe
covers every crash/timeout window without coordination — and the reconciler
can map provider `/truth` charges back to keys by parsing the prefix.
Rejected: storing a generated key on the row (one more write, one more thing
to be inconsistent).

## Idempotency lock fencing: owner token + compare-and-swap

The lock is not just `locked_at`; every actor that takes it (API, completer,
reconciler) stamps a fresh `locked_by` uuid, and every unlock and every
`recovery_point` advance carries `AND locked_by = <owner>` (plus `AND
recovery_point = <expected>`; create also `AND intent_id IS NULL`). Why: a
stalled actor whose _stale_ lock was stolen by another must not, on resuming,
free the new owner's lock (→ two actors, duplicate webhooks) or regress the
pointer (→ double ledger post / a wedged key). A guarded update that hits 0
rows aborts the pipeline (replay-or-409) instead of proceeding. `locked_at`
alone can't tell "still mine" from "already stolen"; the token can. Rejected:
`SELECT … FOR UPDATE` held across the provider call (serializes the whole key
and pins a pooled connection through a multi-second HTTP call).

## Completer backstop: bounded re-drive, then terminal

A key that keeps failing to complete would otherwise re-enqueue a
`complete_intent` job every grace period forever, re-emitting transition events
each cycle (webhook spam + unbounded dead jobs). `completer_attempts` counts the
failures; past a cap (25) the completer walks the intent to `failed` through the
machine (`RETRY_EXHAUSTED`, the edge that had no caller before) and stores a
stable 500 on the key, so the client gets a terminal answer and the loop stops.
The real fix for the observed poison (`amount_minor` > 2^63 overflowing the
intent INSERT) is the schema maximum above; this is the defence-in-depth
backstop for any _other_ permanent stall.

## Refunds

A refund is a **new compensating ledger transaction** (`kind 'refund'`), never
an edit of the charge — the ledger stays append-only. The double-entry is the
mirror of the charge's money leg: **credit `customer_receivable`, debit
`merchant_payable`** for the refund amount. The **fee is not returned**: the
merchant bears the processing fee on a refund, so a full refund leaves that
intent's `merchant_payable` at `-fee` (charge `+amount`, fee `-fee`, refund
`-amount`) — economically correct, and it keeps the whole ledger summing to 0.

**Multiple partial refunds.** A charge can be refunded repeatedly up to the
charged amount. The old `ledger_transactions_intent_id_kind_idx UNIQUE (intent_id,
kind)` would have capped it at one refund, so it became **two partial indexes**:
`(intent_id, kind) WHERE refund_id IS NULL` still pins charge/fee to one each,
and `(refund_id) WHERE refund_id IS NOT NULL` pins one ledger transaction per
refund. `postTransactionInTx`'s `ON CONFLICT (intent_id, kind) WHERE refund_id IS
NULL` targets the first, so charge/fee idempotency is byte-identical to before.

**Idempotency + over-refund.** `refunds UNIQUE(merchant_id, idempotency_key)` is
the dedupe key: a retried POST replays the original refund (`200`) and posts no
second ledger transaction. The over-refund guard (`already_refunded + requested
≤ charge_amount`, else `400 refund_exceeds_refundable`) runs inside the refund
TX under a `SELECT … FOR UPDATE` on the intent row, so two different keys racing
on the same intent serialize instead of both slipping past the cap. Refunding a
non-`succeeded` intent is `409`; an unknown intent `404`.

**Status is unchanged.** The intent stays `succeeded`; refund state is derived
(`refunded_total_minor` in the read model). A dedicated `'refunded'` /
`'partially_refunded'` status is a **documented future extension** — it would
touch the intent state machine and the status enum, deliberately out of scope
here to avoid coupling refunds to the payment pipeline's state transitions.

## Settlement / payouts

Completing the money lifecycle: after charges settle, the platform owes each
merchant their `merchant_payable` balance (credit-normal liability = credits −
debits). A **payout sweeps that balance** as a **new append-only ledger
transaction** (`kind 'payout'`) — **debit `merchant_payable`, credit a new
`payout_clearing` counter account** — so the whole ledger keeps summing to 0 and
the charge is never edited. `payout_clearing` is seeded alongside the other four
accounts. A payout is intent-less (it spans a merchant's whole balance, not one
charge), so `ledger_transactions.intent_id` became nullable and `payout_id`
links the transaction to its `payouts` row, mirroring `refund_id` exactly
(partial unique index `(payout_id) WHERE payout_id IS NOT NULL`). The reconciler's
orphan-transaction check now ignores intent-less rows (`intent_id IS NOT NULL AND
NOT EXISTS …`) so payouts are not mistaken for orphans.

**Idempotency is balance-derived, not a stored marker.** The batch settles one
merchant per TX: lock the merchant row, **re-read the outstanding balance under
that lock**, and post a payout for exactly that amount — the balance zeroes in
the same TX. A crash mid-batch rolls back that merchant's payout (all-or-nothing
via `postTransactionInTx`); a **re-run recomputes the now-zero balance and pays
nothing extra**; a concurrent batch serializes on the merchant lock and finds
nothing left. The swept balance can be paid exactly once because paying it _is_
what zeroes it — the same reasoning as refunds (the ledger is the state), with
the `(payout_id)` unique index as the schema backstop. A merchant whose balance
is ≤ 0 (e.g. a full refund left `merchant_payable` at `−fee`) is skipped.

**Exposure** mirrors reconcile: `runSettlement` in `apps/worker/src/settlement.ts`,
a `settle_payouts` worker job (`handleSettlePayouts` + `enqueueSettlementJob`,
deduped by `jobs_settle_payouts_live_idx`), a CLI (`npm run payout`), an ops
trigger `POST /v1/settlements`, and a merchant read model `GET /v1/payouts`.

**Deviation — no timer.** Unlike reconcile (a read-only audit on a 60s cron),
settlement **moves money and drains the visible `merchant_payable` bar**, so it
is triggered on demand (CLI / ops endpoint) rather than auto-fired on a worker
loop. Ceiling: single-currency (USD), and 'paid' is synchronous in-ledger — the
`'pending'` payout status is the documented hook for a real bank-transfer step.

## Provider-config passthrough is a gated demo control

`GET/PUT /v1/provider/config` forwards to the provider-sim so the dashboard
playground can flip failure profiles. It is unauthenticated and forwards
`callback_url` (an SSRF lever), so it is **off by default** and enabled only via
`ENABLE_PROVIDER_CONFIG=1` (set in compose/dev). With the flag off both routes
404; with it on, `callback_url` is validated to a well-formed http(s) URL. It is
a demo affordance, not a product surface — rejected leaving it always-on (an
unauthenticated request-forwarding endpoint in a payments API is indefensible).

## Testcontainers over mocks for integration tests

Every integration test runs against a real Postgres container (and real child
processes where the test is about killing processes). Mocked infrastructure
was rejected because the interesting behavior lives in Postgres semantics:
`SKIP LOCKED` contention, trigger errors, unique-violation races, `40001`
retries. A mock proves the mock. Cost: ~seconds per suite; worth it.

## No-framework dashboard

Hand-written HTML/CSS/vanilla JS behind a ~100-line Fastify static server with
a same-origin `/api/*` proxy. A read-model UI (tables, counters, one form)
does not justify a build pipeline: no bundler, no framework upgrades, no CDN
assets, view-source shows everything. The proxy exists so the browser never
needs CORS and the containerized API stays reachable by service name.
Rejected: React/Vite (build step for zero interactivity gain), htmx (a
dependency to avoid ~30 lines of fetch).

## Bench driver in TypeScript, not k6

`scripts/bench.ts` is a ~300-line load driver using the repo's own toolchain:
concurrency ladder, percentiles, JSON + table output. k6 was rejected because
it adds a Go binary and a second JavaScript dialect (goja, no Node APIs) to
produce the same four percentiles — and the ledger microbench needs `pg` and
`@reckon/core` imports, which k6 cannot do. If this ever needs distributed
load or fancier scenarios, k6 is the upgrade path.
