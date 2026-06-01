BEGIN;

-- 仅 api_key 账号可以选择跳过请求形态校验（empty-tools side-query allowlist 等）。
-- OAuth 账号必须始终校验：无校验直连官方上游容易触发反作弊。
ALTER TABLE oauth_accounts
  ADD COLUMN IF NOT EXISTS skip_shape_validation BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE oauth_accounts
  DROP CONSTRAINT IF EXISTS oauth_accounts_skip_shape_validation_check,
  ADD  CONSTRAINT         oauth_accounts_skip_shape_validation_check
       CHECK (skip_shape_validation = FALSE OR auth_kind = 'api_key');

COMMIT;
