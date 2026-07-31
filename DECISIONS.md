# Decisions

Non-obvious choices, what was rejected, and why. Three to five lines each.

## npm workspaces (not pnpm, not a polyrepo)

The brief suggested pnpm; I used npm workspaces. One fewer tool to install,
`npm ci` works everywhere Docker and CI already have Node, and at six small
packages the performance difference is noise. Workspace protocol (`"*"`) links
`@tally/core` and friends without a publish step. Rejected: pnpm (no gain at
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

## Derived provider idempotency key (`tally-{keyId}`)

The provider key is computed from our idempotency-key row id, not stored. Any
retry of the same key derives the same provider key, so provider-side dedupe
covers every crash/timeout window without coordination — and the reconciler
can map provider `/truth` charges back to keys by parsing the prefix.
Rejected: storing a generated key on the row (one more write, one more thing
to be inconsistent).

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
`@tally/core` imports, which k6 cannot do. If this ever needs distributed
load or fancier scenarios, k6 is the upgrade path.
