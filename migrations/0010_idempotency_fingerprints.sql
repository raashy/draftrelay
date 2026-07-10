-- Bind idempotency keys to the exact operation payload that first claimed them.
-- Older keyed rows remain readable but fail closed on replay because their
-- fingerprint is null and cannot be reconstructed from mutable item metadata.

ALTER TABLE output_revision
  ADD COLUMN idempotency_fingerprint text
    CHECK (idempotency_fingerprint IS NULL OR char_length(idempotency_fingerprint) = 64);

ALTER TABLE output_event
  ADD COLUMN idempotency_fingerprint text
    CHECK (idempotency_fingerprint IS NULL OR char_length(idempotency_fingerprint) = 64);

COMMENT ON COLUMN output_revision.idempotency_fingerprint IS
  'SHA-256 of the canonical operation scope and normalized request payload.';
COMMENT ON COLUMN output_event.idempotency_fingerprint IS
  'SHA-256 of the canonical operation scope and normalized request payload.';
