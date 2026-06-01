-- Store the organization_uuid (and account_uuid) reported by Anthropic for
-- each OAuth account so synthetic event_logging batches can populate
-- auth.organization_uuid the way a real Claude Code client does.
--
-- Previously we lazily captured orgUuid from the anthropic-organization-id
-- response header into an in-memory Map. That Map is empty on cold start,
-- empty on a new gateway instance, and never survives a restart — so the
-- FIRST synthetic batches after every restart carried auth.organization_uuid:""
-- which is a trivial detection signal.
--
-- account_uuid already lives inside canonical_identity JSONB; we expose it as
-- a first-class column too so the /api/oauth/profile importer does not need
-- to round-trip through the JSON blob on every update.

BEGIN;

ALTER TABLE oauth_accounts
  ADD COLUMN IF NOT EXISTS organization_uuid TEXT,
  ADD COLUMN IF NOT EXISTS account_uuid TEXT;

-- Back-fill account_uuid from the existing canonical_identity JSONB when
-- present so rows touched before profile re-pull still have something.
UPDATE oauth_accounts
   SET account_uuid = canonical_identity->>'account_uuid'
 WHERE account_uuid IS NULL
   AND canonical_identity->>'account_uuid' IS NOT NULL;

COMMIT;
