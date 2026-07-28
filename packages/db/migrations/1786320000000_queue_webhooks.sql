-- Up Migration

-- Phase C: hand-rolled job queue lifecycle + outbox fan-out + webhook DLQ.

-- Jobs that exhaust their retries are DEAD (the DLQ state), not 'failed' —
-- 'failed' was never written by anything and a transient failure re-enters
-- 'pending' with a future run_at instead of getting its own status.
ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('pending', 'running', 'done', 'dead'));

-- Outbox dispatch marker. A claimed FLAG (not a cursor table) on purpose:
-- a cursor over (created_at, id) silently skips events committed late by a
-- long-running transaction (commit order != created_at order), while a flag +
-- FOR UPDATE SKIP LOCKED has no ordering dependency and lets multiple workers
-- fan out in parallel. The unique index below makes fan-out exactly-once per
-- (event, endpoint) even if an event were somehow claimed twice.
ALTER TABLE events ADD COLUMN dispatched_at timestamptz;
CREATE INDEX events_undispatched_idx ON events (created_at) WHERE dispatched_at IS NULL;

CREATE UNIQUE INDEX webhook_deliveries_event_endpoint_idx
  ON webhook_deliveries (event_id, endpoint_id);

-- The completer's enqueuer needs "stuck for longer than the grace period",
-- which needs to work for keys that never got an intent_id — so the key row
-- itself carries its creation time.
ALTER TABLE idempotency_keys ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

-- Completer dedupe: at most one live (pending/running) complete_intent job per
-- idempotency key. The enqueuer inserts with ON CONFLICT DO NOTHING against
-- this index, so concurrent enqueuers can never double-enqueue.
CREATE UNIQUE INDEX jobs_complete_intent_live_key_idx
  ON jobs ((payload ->> 'key_id'))
  WHERE kind = 'complete_intent' AND status IN ('pending', 'running');
