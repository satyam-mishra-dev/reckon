# Failure modes

What breaks, what happens, how it recovers, and which committed test or chaos
assertion proves it. If a failure mode here has no proof column, it doesn't
belong here.

## 1. Provider charges, then the response times out

**What breaks.** The provider creates the charge but the HTTP response never
arrives (provider-sim does this on purpose via `timeout_after_charge_rate`).
Money moved; we don't know it.

**What happens.** The pipeline treats the timeout as "may have landed": the
intent transitions to `requires_retry`, the key's lock is released, and the
recovery point stays at `intent_created`. Nothing is assumed either way.

**How it recovers.** Three converging paths, all through the same resume loop:
a client retry with the same key re-calls the provider with the same derived
key `tally-{keyId}` and gets the original outcome replayed; the completer does
the same for abandoned keys after a grace period; and the reconciler's
external pass finds the charge in `/truth`, takes the key lock, and drives the
key to `finished` (posting the ledger from truth if the provider is still
unreachable).

**Proof.**
`apps/api/test`: "provider charges then times out → requires_retry; retry
resumes and provider dedupes on the derived key".
`apps/worker/test`: "resolves a timeout-after-charge orphan by re-driving the
stuck key" and "applies the charge from /truth when the provider cannot be
reached". Chaos: the `timeout-after-charge` profile runs at 30% for a tenth of
the run; final assertions require 0 unresolved orphans and provider charges
exactly equal to succeeded intents.

## 2. Worker SIGKILLed between provider charge and ledger post

**What breaks.** A `complete_intent` (or any) job dies holding its lease. The
key sits at `provider_charged`: money moved, ledger not yet posted.

**What happens.** The job row stays `running` with a stale `locked_at`; the
key row stays locked by a dead process.

**How it recovers.** A surviving worker's sweeper returns the job to `pending`
once the lease passes the visibility timeout (attempts incremented). Whoever
picks it up takes over the key's stale lock (same free-or-stale rule as the
API) and resumes at `provider_charged` — the ledger post is idempotent per
`(intent_id, kind)`, so even a double-execution writes once.

**Proof.**
`apps/worker/test`: "job stuck running with stale lock → second worker sweeps
it back to pending and completes it" (real SIGKILL of a child process) and
"re-drives a key stuck at intent_created to finished with exactly one provider
charge". `apps/api/test`: "crash after intent_created → same key resumes,
completes, exactly one provider charge" (fault-hook crash seam at every
phase). Chaos: 4 SIGKILLs survived, 0 non-terminal intents, drift 0.

## 3. Same webhook delivered five times to a merchant

**What breaks.** Nothing on our side has to: at-least-once delivery plus
retries means duplicates are a certainty, not an accident. The chaos run also
injects deliberate redeliveries of already-delivered events.

**What happens.** The consumer receives the same event id repeatedly, each
delivery correctly signed.

**How it recovers.** It doesn't need to — the contract pushes dedupe to the
consumer: verify signature, then dedupe on event `id` (README, "Consuming
webhooks"). The reference receiver keeps a seen-set and answers duplicates
with an acknowledged no-op.

**Proof.**
`apps/worker/test`: "receiver dedupes a redelivery of the same event". Chaos:
21/21 injected redeliveries deduped; distinct processed events exactly equals
delivered count (no double processing).

## 4. Postgres restarts mid-flight

**What breaks.** Every in-flight transaction aborts; every process loses its
connections.

**What happens.** Atomic phases mean each aborted TX rolls back a whole phase:
effects and the recovery-point advance disappear together, never separately.
The system's entire state is the database, so after the restart the tables are
a consistent snapshot at some phase boundary per key.

**How it recovers.** Pools reconnect on next use. API requests during the
outage fail with 500 and release nothing durable (the stale-lock takeover
covers the ones that died holding a lock). Stuck keys are re-driven by the
completer; `running` jobs whose worker connection died are swept back to
pending. Serialization/deadlock errors (40001/40P01) inside a phase retry the
step in place.

**Proof.** Same machinery as modes 1–2: the crash seams and SIGKILL tests
prove resume-from-any-boundary, and the phase design (one TX per phase) is
what makes a DB restart equivalent to a process crash at a boundary. The
compose stack restarts Postgres with `restart: unless-stopped` and every app
container reconnects without intervention.

## 5. Idempotency key reused with a different body

**What breaks.** A client bug: same `Idempotency-Key`, different request.

**What happens.** The stored `request_hash` doesn't match. The request is
rejected with `409 idempotency_key_conflict` before any effect — never "your
previous response, but for different parameters", never a second charge.

**Proof.** `apps/api/test`: "409s when the same key is reused with a different
body".

## 6. Retry storms

**What breaks.** A dead endpoint or a flapping provider turns every delivery
into 10 attempts; naive retries would synchronize into a thundering herd.

**What happens.** All retry scheduling goes through one policy:
`base · 2^(n-1)` plus full jitter, capped (webhooks: 1s base, 10 attempts,
then dead-lettered to the DLQ with a requeue endpoint). Jobs carry their own
`run_at`, so a backlog drains at claim rate rather than stampeding, and the
claim statement's `SKIP LOCKED` keeps workers from contending on the same
rows.

**Proof.** `apps/worker/test`: "retries with monotonically growing
next_attempt_at, then dead-letters at the cap" and "requeue resets the
delivery and delivers once the endpoint recovers". `packages/db/test`: "fail
schedules an exponential retry, then dead-letters at maxAttempts".

## Chaos harness findings

The chaos run (`scripts/chaos.ts`) found real bugs during phase D; two
findings changed the design and are worth keeping:

- **Cron cadence vs. kill cadence.** Periodic enqueuers (reconcile, completer
  scan) are in-process timers, and SIGKILL takes the timers with the process.
  With kills every 5–15s, any cron interval longer than the shortest inter-kill
  gap may never fire during chaos: each worker generation dies before its
  first tick. The chaos config pins `RECONCILE_INTERVAL_MS=8000` so a
  generation living between two kills still enqueues a mid-run pass. The
  general rule: a "cron" that must survive chaos either needs an interval
  shorter than the expected process lifetime, or its due-ness must live in the
  data (like `run_at` on jobs) rather than in a timer.
- **Drain is part of the proof.** Asserting on a fixed timeout hides slow
  recovery. The harness instead waits until every intent is terminal, every
  key finished, jobs and deliveries settled, and only then audits — so a
  regression that merely slows recovery past the duration cap fails the run
  instead of flaking it.
