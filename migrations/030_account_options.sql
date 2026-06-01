BEGIN;

-- 1) 加 options 列
ALTER TABLE oauth_accounts
  ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 2) 数据迁移(P12:仅迁移空对象的行,防 deploy 重跑覆盖人工修改)
UPDATE oauth_accounts SET options = jsonb_build_object(
  'validate', jsonb_build_object(
    'body',              true,
    'shape',             NOT COALESCE(skip_shape_validation, false),
    'model',             true,
    'fastMode',          true,
    'requireStream',     NOT COALESCE(allow_non_stream, false)
  ),
  'clean', jsonb_build_object(
    'ccHeaders',   auth_kind = 'api_key',
    'ccBetaFlags', auth_kind = 'api_key',
    'systemText',  auth_kind = 'api_key',
    'metadata',    auth_kind = 'api_key'
  ),
  'override', jsonb_build_object(
    'userAgent', jsonb_build_object(
      'mode',  CASE WHEN outbound_user_agent IS NOT NULL THEN 'override' ELSE 'omit' END,
      'value', outbound_user_agent
    ),
    'anthropicVersion', jsonb_build_object('mode','omit','value',NULL),
    'anthropicBeta',    jsonb_build_object('mode','omit','value',NULL),
    'extraHeaders',     '{}'::jsonb
  ),
  'events', jsonb_build_object('emitTengu', auth_kind = 'oauth'),
  'canonicalCcMessages', auth_kind = 'oauth'
)
WHERE NOT (options ? 'validate');  -- 已迁移过的不覆盖

-- 3) 不变量自检(线上跑也能 catch 数据漏搬)
DO $$
DECLARE bad INT;
BEGIN
  SELECT COUNT(*) INTO bad FROM oauth_accounts
   WHERE auth_kind='oauth' AND options->>'canonicalCcMessages' <> 'true';
  IF bad <> 0 THEN RAISE EXCEPTION 'OAuth 账号 canonicalCcMessages 应全为 true,实际有 %', bad; END IF;

  SELECT COUNT(*) INTO bad FROM oauth_accounts
   WHERE skip_shape_validation = true AND options->'validate'->>'shape' <> 'false';
  IF bad <> 0 THEN RAISE EXCEPTION 'skip_shape=true 应迁为 validate.shape=false,异常 %', bad; END IF;

  SELECT COUNT(*) INTO bad FROM oauth_accounts
   WHERE outbound_user_agent IS NOT NULL
     AND (options->'override'->'userAgent'->>'mode' <> 'override'
       OR options->'override'->'userAgent'->>'value' IS DISTINCT FROM outbound_user_agent);
  IF bad <> 0 THEN RAISE EXCEPTION 'outbound_user_agent 迁移异常 %', bad; END IF;
END $$;

-- 4) DROP 老约束 + 老列
ALTER TABLE oauth_accounts
  DROP CONSTRAINT IF EXISTS oauth_accounts_skip_shape_validation_check;

ALTER TABLE oauth_accounts
  DROP COLUMN IF EXISTS allow_non_stream,
  DROP COLUMN IF EXISTS skip_shape_validation,
  DROP COLUMN IF EXISTS outbound_user_agent;

-- 5) 加 options shape CHECK
ALTER TABLE oauth_accounts
  ADD CONSTRAINT oauth_accounts_options_shape_check
  CHECK (
    jsonb_typeof(options->'validate') = 'object'
    AND jsonb_typeof(options->'clean') = 'object'
    AND jsonb_typeof(options->'override') = 'object'
    AND jsonb_typeof(options->'events') = 'object'
    AND (options ? 'canonicalCcMessages')
  );

COMMIT;
