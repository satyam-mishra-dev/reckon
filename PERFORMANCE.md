# Tally — Performance Notes

A measurement-driven optimization pass on the payment-create pipeline and the
ledger posting path. Every number here comes from a committed script
(`npm run bench`) or from Postgres itself (`log_min_duration_statement`,
`EXPLAIN`). Nothing is estimated.

**TL;DR** — The create hot path was cut from **32 to 26 sequential DB
round-trips** and **4 to 3 write transactions** per payment, with all crash-safety
and idempotency-fencing invariants preserved (83 tests green, chaos drift 0).
On a heavily-loaded shared laptop the wall-clock win is real but modest and
partly masked by noise: **create p50 −5 to −14%, throughput +7 to +32% at
concurrency 1–32; flat (within noise) at 64.** A pool-size bump was tried and
**reverted** — the box is CPU-bound, not connection-bound.

---

## Methodology

- **Driver:** the repo's `scripts/bench.ts` (`npm run bench`), unchanged. It
  measures three scenarios against the booted compose stack:
  - `create (unique key)` — fresh idempotency key per request, full pipeline
    (idempotency phases + provider call + ledger post), at concurrency 1/8/32/64,
    n = 500 each.
  - `replay (finished key)` — same finished key hammered, serves the stored
    response, same ladder.
  - `ledger post` — `postTransaction` microbench on a dedicated `tally_bench`
    DB: 1,000 sequential + 8×250 concurrent.
- **Environment:** single M-series MacBook Pro. Postgres 16 (alpine) and the API
  run in Docker (compose); the bench driver runs on the host over the published
  `5433`/`4800` ports. The provider profile is forced to zero latency/decline for
  determinism (the bench does this).
- **Single-machine caveat (important):** during this pass the box was
  **co-resident with two other full Docker stacks** (a separate `fleetline`
  project, 7 containers, and `frido-*`, 4 containers) plus the tally stack (6
  containers). It is CPU-oversubscribed. Consequence: **run-to-run RPS varies
  ±~30%.** A scenario that touches none of the changed code (`replay`) swung
  12.9 → 20.9 → 19.3 ms p50 at c64 across three runs — that is the noise floor.
  Because of this, every wall-clock comparison below is the **median of 3 runs**,
  and the baseline was re-measured **back-to-back** with the optimized build (same
  machine, same load) rather than compared against an older number taken on a
  quieter box.
- **Profiling:** to see where wall-time goes independent of noise, one create was
  run with `log_min_duration_statement = 0` and every statement counted/timed.
  Index coverage was checked with `EXPLAIN (ANALYZE)`.

---

## Where the wall-time actually goes (baseline profile)

A single create at concurrency 1 (p50 ≈ 10.5 ms) issues **~32 sequential
statements**, each a network round-trip API→Postgres. The Postgres-side execute
time is trivial — summing the logged `execute` durations gives **~3 ms of actual
DB work**; the remaining ~7 ms is round-trip latency × count. The pipeline is
**round-trip-bound, not CPU- or query-bound.** The baseline round-trips:

| # | statement | phase |
|---|-----------|-------|
| 1 | `INSERT idempotency_keys … ON CONFLICT` (upsert + lock) | handler |
| 2 | `SELECT … idempotency_keys` (loadKey) | resume loop |
| 3–7 | BEGIN · INSERT payment_intents · INSERT events · UPDATE key → intent_created · COMMIT | phase 1 |
| 8–9 | loadKey · loadIntent | resume loop |
| — | **provider HTTP call** (client released) | — |
| 10 | loadKey (re-derive after re-checkout) | resume loop |
| 11–14 | BEGIN · UPDATE intent.provider_ref · UPDATE key → provider_charged · COMMIT | phase 2 |
| 15–16 | loadKey · loadIntent | resume loop |
| 17 | `SELECT … accounts WHERE currency` | phase 3 |
| 18–25 | BEGIN · INSERT tx(charge) · INSERT entries(charge) · INSERT tx(fee) · INSERT entries(fee) · UPDATE key → ledger_posted · COMMIT | phase 3 |
| 26–27 | loadKey · loadIntent | resume loop |
| 28–32 | BEGIN · UPDATE intent → succeeded · INSERT events · UPDATE key → finished · COMMIT | phase 4 |
| 33 | loadKey (finished → replay stored response) | resume loop |

The ledger entries are already inserted as a **single multi-row `INSERT … SELECT
unnest(...)`** (not N inserts) — already optimal, left untouched.

---

## Optimizations

Applied one at a time, each re-benched, kept only if it was a real win.

### 1. Cache the immutable chart-of-accounts per process — **KEPT**

`phasePostLedger` re-ran `SELECT id, type FROM accounts WHERE currency = $1` on
**every** payment. Accounts are seed data: `INSERT`-only, never updated or deleted
(the seed is keyed by `(type, currency)` and even the chaos harness does not
truncate `accounts`/`merchants`). Resolved once per process into a
`Map<currency, Map<type, id>>` and reused — mirrors the existing lazy
`getMerchantId` cache. Removes **1 round-trip/create**.

*Safety:* verified the account IDs are stable across a chaos truncate+reseed
(chaos `TRUNCATE` list excludes `accounts` and `merchants`), so a long-lived API
process never holds a stale cache.

### 2. Merge the two pure-DB terminal phases into one transaction — **KEPT**

The pipeline advanced `provider_charged → ledger_posted → finished` as **two
separate transactions** with **no external effect between them** (the provider
call already happened, before `provider_charged`). Merged into one
`phasePostLedgerAndFinish`: post charge + fee, succeed the intent (+ outbox
event), store the response, and advance the pointer straight to `finished` — all
in one TX guarded by `locked_by + recovery_point`.

Removes per create: `loadKey`, `loadIntent`, one `BEGIN`, one `COMMIT`, and the
intermediate `ledger_posted` pointer `UPDATE` ≈ **4 round-trips + 1 transaction**.

*Safety (unchanged invariants):* a crash mid-merged-TX rolls back to
`provider_charged`; resume re-posts the ledger, which is idempotent per
`(intent_id, kind)` — byte-identical outcome to the pre-merge path. The fencing
guard is still the last statement in the TX. The `provider_charged` recovery
point is **deliberately kept separate** (it durably records the foreign-state
mutation so recovery need not re-call the provider). The `ledger_posted` case is
retained as a backward-compat handler for any row a pre-merge process left
mid-flight. All 83 tests (including the crash-resume and 50×-concurrent
idempotency proofs) stay green.

### Mechanism (noise-free result)

Re-profiled the optimized build the same way:

| | round-trips / create | write transactions / create |
|---|---:|---:|
| baseline | 32 | 4 |
| optimized | **26** (−19%) | **3** (−25%) |

This is the measurement that is *not* subject to machine noise: the pipeline
provably does less work per payment.

---

## Controlled before/after (median of 3 runs, back-to-back)

### create (full pipeline) — the hot path

| conc | p50 base→opt | Δp50 | p99 base→opt | RPS base→opt | ΔRPS |
|---:|---|---:|---|---|---:|
| 1  | 10.5 → 10.0 ms | −5%  | 27.6 → 25.9 | 87 → 93   | +7%  |
| 8  | 16.4 → 15.4 ms | −6%  | 54.0 → 43.8 | 408 → 480 | +18% |
| 32 | 62.6 → 54.0 ms | −14% | 140.0 → 94.6 | 395 → 524 | +32% |
| 64 | 121.7 → 116.7 ms | −4% | 172.7 → 215.0 | 493 → 411 | −17% *(noise)* |

The c64 RPS medians land on opposite sides of the noise band — the three raw runs
were baseline **400 / 493 / 512** vs optimized **411 / 398 / 618**: fully
overlapping. Treat c64 as **flat/within-noise** (p50 is marginally better,
throughput is indistinguishable). The signal is cleanest at **c8/c32**, where the
box is loaded but not saturated. At **c1** the fixed costs (provider HTTP call +
Fastify + a smaller round-trip count) dominate, so trimming 6 of 32 round-trips
barely moves single-request latency — as expected.

### replay + ledger — untouched, shown for completeness

Neither change touches the replay path or the ledger microbench; the differences
below are pure environment noise, not regressions.

| scenario | conc | p50 base→opt | RPS base→opt |
|---|---:|---|---|
| replay | 1  | 0.6 → 0.6 ms | 1,276 → 1,156 |
| replay | 8  | 1.6 → 1.7 ms | 4,365 → 4,293 |
| replay | 32 | 5.5 → 6.4 ms | 5,207 → 4,795 |
| replay | 64 | 14.3 → 15.0 ms | 4,021 → 4,089 |
| ledger (sequential) | 1 | 0.6 → 0.6 ms | 1,405 → 1,328 tx/s |
| ledger (8 clients)  | 8 | 1.5 → 1.5 ms | 4,536 → 4,310 tx/s |

Replay and ledger post are already tight — sub-millisecond single-op latency,
thousands of ops/sec. There was nothing to optimize there and I did not pretend
otherwise.

---

## What did NOT help (negative results)

### Postgres pool size 10 → 24 — **REVERTED**

Hypothesis: the linear p50-vs-concurrency scaling and RPS plateau looked like
connection-pool saturation (pg default `max` = 10, contended by 32–64 requests).
Added a tunable `PG_POOL_MAX` and set it to 24. Result (median of 3):

| conc | create RPS, pool=10 | create RPS, pool=24 |
|---:|---:|---:|
| 8  | 495 | 405 |
| 32 | 572 | 503 |
| 64 | 496 | 487 |

Neutral-to-slightly-worse across the board. The box is **CPU-oversubscribed**
(three stacks co-resident), so more connections buy more contention and context
switching, not more parallelism — the bottleneck is CPU/scheduling, not
connection count. Reverted the change entirely, including the config knob (a
default that changes nothing is speculative surface area). On a dedicated DB host
with spare cores this knob would likely help; here it measurably does not.

### Considered and rejected without shipping

- **Eliminate the per-phase `loadKey`/`loadIntent` re-reads** (≈4 more
  round-trips). The resume loop deliberately *re-derives all state from the DB* on
  every entry — that is the rocket-rides-atomic crash-safety contract and the
  crown jewel. Threading state through local variables to skip the reads would
  trade a noise-masked few-percent win for real risk to the idempotency-fencing
  logic. Not worth it (see "next step").
- **Merge `provider_charged` into the finish TX too** (removing that recovery
  point). Correct *only if* the provider is idempotent on the derived key — but
  persisting `provider_charged` is exactly the "durably record the foreign-state
  mutation before proceeding" property, so recovery never has to re-call the
  provider. Removing it weakens defense-in-depth for a marginal gain. Rejected.

---

## Verified already-optimal (checked, not changed)

- **Ledger entry insert:** single multi-row `INSERT … SELECT unnest($2,$3,$4)`,
  not a loop of inserts. Already the right shape.
- **Index coverage on hot WHERE clauses** (`EXPLAIN`):
  - `idempotency_keys (merchant_id, key)` → Index Scan on the unique index.
  - `idempotency_keys (id)` → PK (the per-request `loadKey`).
  - `ledger_transactions (intent_id, kind)` → Index Scan on the unique index.
  - `jobs (status, run_at)` → Index Scan on `jobs_claim_idx` (the SKIP LOCKED claim).
  All hot lookups are index-backed. No missing index was found. (The only
  unindexed query, the accounts `SELECT`, is now cached out of the hot path.)

---

## Current numbers (optimized, median of 3)

| path | p50 | p99 | throughput |
|---|---:|---:|---|
| create @1  | 10.0 ms | 25.9 ms | 93 rps |
| create @32 | 54.0 ms | 94.6 ms | 524 rps |
| create @64 | 116.7 ms | 215.0 ms | 411 rps |
| replay @1  | 0.6 ms | 3.4 ms | 1,156 rps |
| replay @64 | 15.0 ms | 30.6 ms | 4,089 rps |
| ledger post (seq) | 0.6 ms | 2.6 ms | 1,328 tx/s |
| ledger post (8×)  | 1.5 ms | 4.7 ms | 4,310 tx/s |

---

## Remaining bottleneck + honest next step

The create path is still **round-trip-bound**: ~26 *sequential* API→Postgres
round-trips, sequential because each atomic phase depends on the previous
recovery-point commit, and BEGIN→stmts→COMMIT within a phase is serial. On this
CPU-saturated box, the per-request savings are additionally masked by scheduling
noise at high concurrency.

The two levers I would pull next, in order:

1. **Fuse each phase's writes into one server round-trip.** Today a phase is
   `BEGIN; INSERT; INSERT; UPDATE …; COMMIT` = 5 round-trips. Postgres can run a
   phase as a single statement — a CTE (`WITH … RETURNING`) or a plpgsql function
   that does the inserts and the guarded pointer `UPDATE` and returns the guard
   result in one shot. That would take each phase from ~5 round-trips to ~1–2 and
   is the single biggest remaining win, *without* touching the re-derive contract
   between phases. Requires care to keep the fencing guard (`locked_by +
   recovery_point`, RETURNING 0 rows ⇒ OwnershipLost) intact inside the CTE.
2. **Measure on a dedicated host.** Re-run baseline vs optimized on a box that is
   *not* running two other stacks, to get a clean read and to re-test the pool-size
   lever (which should help once the DB has spare cores). The ±30% noise here is
   the limiting factor on claiming anything smaller than ~15%.

I did **not** chase the `loadKey`/`loadIntent` re-reads or the `provider_charged`
merge — both trade the crash-safety/idempotency guarantees for a noise-sized win,
and correctness is non-negotiable here.

---

## Correctness (non-negotiable, verified after the changes)

- `npm test` — **83 passed** (core 50, api 9, worker 11, db 13), including the
  crash-resume test, the 50×-concurrent single-charge/50-identical-response
  idempotency test, and the 1,000-transaction ledger balance property test.
- `npm run chaos -- --intents 1000` — **all assertions passed**: ledger **drift 0**,
  1,000 intents terminal, exactly 1,000 distinct provider charges, 2,000
  balanced ledger transactions, balances sum to 0, worker SIGKILL survived,
  0 orphans, all events delivered.
