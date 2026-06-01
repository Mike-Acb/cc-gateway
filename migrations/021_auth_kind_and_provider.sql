BEGIN;

ALTER TABLE oauth_accounts
  ADD COLUMN IF NOT EXISTS auth_kind            VARCHAR(16)  NOT NULL DEFAULT 'oauth',
  ADD COLUMN IF NOT EXISTS provider             VARCHAR(16)  NOT NULL DEFAULT 'anthropic',
  ADD COLUMN IF NOT EXISTS api_key              TEXT,
  ADD COLUMN IF NOT EXISTS api_base_url         TEXT,
  ADD COLUMN IF NOT EXISTS simulate_fingerprint BOOLEAN      NOT NULL DEFAULT TRUE;

-- Constrain enums
ALTER TABLE oauth_accounts
  DROP CONSTRAINT IF EXISTS oauth_accounts_auth_kind_check,
  ADD  CONSTRAINT         oauth_accounts_auth_kind_check
       CHECK (auth_kind IN ('oauth','api_key'));

ALTER TABLE oauth_accounts
  DROP CONSTRAINT IF EXISTS oauth_accounts_provider_check,
  ADD  CONSTRAINT         oauth_accounts_provider_check
       CHECK (provider IN ('anthropic','openai'));

-- refresh_token is NOT NULL today (migration 002). API-KEY rows have no RT,
-- so relax the constraint — but enforce that oauth rows still have one.
ALTER TABLE oauth_accounts
  ALTER COLUMN refresh_token DROP NOT NULL;

ALTER TABLE oauth_accounts
  DROP CONSTRAINT IF EXISTS oauth_accounts_credential_check,
  ADD  CONSTRAINT         oauth_accounts_credential_check
       CHECK (
         (auth_kind = 'oauth'   AND refresh_token IS NOT NULL) OR
         (auth_kind = 'api_key' AND api_key       IS NOT NULL)
       );

COMMIT;
