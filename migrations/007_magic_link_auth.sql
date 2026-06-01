BEGIN;

-- Allow password_hash to be NULL (magic link users have no password)
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Track email verification status
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;

-- Mark all existing users as verified
UPDATE users SET email_verified = true WHERE email_verified = false;

COMMIT;
