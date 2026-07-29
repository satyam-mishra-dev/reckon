-- Up Migration

-- Phase D: the reconciler (brief §4.8) persists one row per pass — drift or
-- not — so "zero drift" is a queryable record, not a log line. drift_minor is
-- the sum of |debits - credits| across ledger transactions (0 on a healthy
-- ledger); the orphan columns track the external pass against provider /truth.
CREATE TABLE reconciliation_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer NOT NULL,
  intents_checked integer NOT NULL,
  transactions_checked integer NOT NULL,
  entries_checked integer NOT NULL,
  drift_minor bigint NOT NULL,
  internal_violations integer NOT NULL,
  orphans_found integer NOT NULL,
  orphans_resolved integer NOT NULL,
  orphans_unresolved integer NOT NULL,
  flagged_critical integer NOT NULL,
  external_checked boolean NOT NULL,
  details jsonb NOT NULL
);

CREATE INDEX reconciliation_reports_finished_at_idx
  ON reconciliation_reports (finished_at DESC);

-- Cron-style dedupe for the reconcile job: at most one live (pending/running)
-- reconcile job in the whole queue, same trick as jobs_complete_intent_live_key_idx.
CREATE UNIQUE INDEX jobs_reconcile_live_idx
  ON jobs (kind)
  WHERE kind = 'reconcile' AND status IN ('pending', 'running');
