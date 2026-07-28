-- Up Migration

-- Phase B (idempotency pipeline): the resume loop re-derives ALL state from
-- the database. Storing the request params on the key row lets a retry — or
-- the phase C background completer, which has no HTTP request at all — resume
-- a key stuck at 'started' (rocket-rides-atomic stores request params for the
-- same reason).
ALTER TABLE idempotency_keys
  ADD COLUMN request_params jsonb;
