-- Up Migration

-- Settlement / payouts: after charges settle, the platform owes each merchant
-- their merchant_payable balance (credit-normal liability = credits − debits).
-- A payout SWEEPS that balance — a NEW append-only ledger transaction (kind
-- 'payout') that debits merchant_payable and credits a new payout_clearing
-- counter account, drawing the liability to 0. Never an edit of the charge.

-- New counter account: money leaves merchant_payable and lands here on payout,
-- so the ledger keeps summing to 0. Seeded per-currency like the other four
-- (see packages/db/src/seed.ts).
ALTER TABLE accounts DROP CONSTRAINT accounts_type_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_type_check CHECK (
  type IN (
    'customer_receivable', 'provider_clearing', 'merchant_payable',
    'platform_revenue', 'payout_clearing'
  )
);

CREATE TABLE payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants (id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  -- Demo settles synchronously in the ledger, so a payout is born 'paid';
  -- 'pending' is the hook for a real bank-transfer step (see DECISIONS).
  status text NOT NULL DEFAULT 'paid' CHECK (status IN ('pending', 'paid')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payouts_merchant_id_idx ON payouts (merchant_id);

-- A payout is a ledger transaction with NO intent — it sweeps a merchant's whole
-- outstanding balance, not one charge — so intent_id becomes nullable and
-- 'payout' joins the kind set. payout_id links the transaction to its payouts
-- row, mirroring refund_id, with a partial unique index pinning ONE ledger
-- transaction per payout (idempotency: a swept balance can be paid exactly once).
ALTER TABLE ledger_transactions ALTER COLUMN intent_id DROP NOT NULL;
ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_kind_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_kind_check
  CHECK (kind IN ('charge', 'fee', 'refund', 'reversal', 'payout'));
ALTER TABLE ledger_transactions ADD COLUMN payout_id uuid REFERENCES payouts (id);

-- charge/fee stay one-per-intent; refunds and payouts each get their own partial
-- unique index. The charge/fee predicate gains AND payout_id IS NULL so it still
-- matches postTransactionInTx's ON CONFLICT predicate exactly.
DROP INDEX ledger_transactions_intent_id_kind_idx;
CREATE UNIQUE INDEX ledger_transactions_intent_id_kind_idx
  ON ledger_transactions (intent_id, kind) WHERE refund_id IS NULL AND payout_id IS NULL;
CREATE UNIQUE INDEX ledger_transactions_payout_id_idx
  ON ledger_transactions (payout_id) WHERE payout_id IS NOT NULL;

-- Cron-style dedupe for the settle_payouts job: at most one live (pending/running)
-- settle_payouts job in the queue, same trick as jobs_reconcile_live_idx.
CREATE UNIQUE INDEX jobs_settle_payouts_live_idx
  ON jobs (kind)
  WHERE kind = 'settle_payouts' AND status IN ('pending', 'running');
