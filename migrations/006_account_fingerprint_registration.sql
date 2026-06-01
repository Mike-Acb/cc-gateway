BEGIN;

ALTER TABLE oauth_accounts
  ADD COLUMN IF NOT EXISTS observed_fingerprint JSONB,
  ADD COLUMN IF NOT EXISTS fingerprint_status VARCHAR(24) NOT NULL DEFAULT 'pending';

UPDATE oauth_accounts
SET fingerprint_status = CASE
  WHEN observed_fingerprint IS NULL THEN 'pending'
  ELSE 'ready'
END
WHERE fingerprint_status IS NULL OR fingerprint_status = '';

COMMIT;
