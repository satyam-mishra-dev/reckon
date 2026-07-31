-- Up Migration

-- Crown-jewel fencing (audit C1/C2): the idempotency lock gains an OWNER TOKEN.
-- Every actor that takes the lock (API, completer, reconciler) stamps a fresh
-- uuid in locked_by; every unlock and every recovery_point advance then carries
-- `AND locked_by = <owner>` so a stalled actor whose stale lock was stolen can
-- neither free the new owner's lock nor regress the pointer — it aborts instead.
ALTER TABLE idempotency_keys ADD COLUMN locked_by uuid;

-- Completer backstop (audit C5/O1): a poisoned/permanently-stuck key would
-- otherwise re-enqueue a complete_intent job every grace period forever. This
-- counts the completer's failed attempts; past a cap the key is driven to a
-- terminal failed state with a stored response so the client gets a stable
-- answer and the completer stops.
ALTER TABLE idempotency_keys ADD COLUMN completer_attempts integer NOT NULL DEFAULT 0;
