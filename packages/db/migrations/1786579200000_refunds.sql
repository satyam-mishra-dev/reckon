-- Up Migration

-- Refunds: compensating money movement against a settled charge. The ledger
-- stays append-only — a refund is a NEW transaction (kind 'refund'), never an
-- edit of the original charge. A charge can be refunded multiple times (partial
-- refunds) up to the charged amount; the refunds table is the source of truth
-- for "how much has been refunded", and each refund links to exactly one ledger
-- transaction via ledger_transactions.refund_id.
CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id text NOT NULL REFERENCES payment_intents (id),
  merchant_id uuid NOT NULL REFERENCES merchants (id),
  idempotency_key text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Idempotency: one refund per (merchant, key). A retried POST with the same
  -- key conflicts here and replays the original refund instead of posting again.
  UNIQUE (merchant_id, idempotency_key)
);

ALTER TABLE ledger_transactions ADD COLUMN refund_id uuid REFERENCES refunds (id);

-- charge/fee stay one-per-intent, but refunds repeat. Split the old singular
-- (intent_id, kind) uniqueness into a partial index that only covers the
-- non-refund rows, plus a second partial index enforcing one ledger transaction
-- per refund. postTransactionInTx's ON CONFLICT targets the WHERE refund_id IS
-- NULL index so charge/fee idempotency is byte-identical to before.
DROP INDEX ledger_transactions_intent_id_kind_idx;
CREATE UNIQUE INDEX ledger_transactions_intent_id_kind_idx
  ON ledger_transactions (intent_id, kind) WHERE refund_id IS NULL;
CREATE UNIQUE INDEX ledger_transactions_refund_id_idx
  ON ledger_transactions (refund_id) WHERE refund_id IS NOT NULL;
