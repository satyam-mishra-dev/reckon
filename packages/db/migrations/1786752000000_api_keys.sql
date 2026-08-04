-- Up Migration

-- Demo-grade merchant API keys. A request authenticates as a merchant by
-- presenting a key; the API stores only its sha256 hex (NEVER the plaintext),
-- looks the merchant up by that hash, and attaches merchant_id to the request.
-- The plaintext is shown once, at seed/creation time (see packages/db/src/seed.ts).
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants (id),
  -- sha256(plaintext) as hex. UNIQUE doubles as the auth lookup index.
  key_hash text NOT NULL UNIQUE,
  -- Short, non-secret display prefix of the plaintext (e.g. 'rk_demo_0000').
  prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
