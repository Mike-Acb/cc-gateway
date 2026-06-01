BEGIN;

-- 1) 给 oauth_accounts.options.validate 回填 shapeAutoComplete=false
--    放宽 shape gate:接受 CC 源码确认但 HAR Pending 的 profile,
--    并在缺 temperature 时自动补 1。仅作为账号级 opt-in,默认关闭。
UPDATE oauth_accounts
SET options = jsonb_set(
  options,
  '{validate,shapeAutoComplete}',
  'false'::jsonb,
  true
)
WHERE NOT (options->'validate' ? 'shapeAutoComplete');

-- 2) request_logs 加 auto_completed_fields(审计:gateway 自动补了哪些 body 字段)
ALTER TABLE request_logs
  ADD COLUMN IF NOT EXISTS auto_completed_fields JSONB;

-- 3) 不变量自检:迁移后所有行都应有 shapeAutoComplete 字段
DO $$
DECLARE bad INT;
BEGIN
  SELECT COUNT(*) INTO bad FROM oauth_accounts
   WHERE NOT (options->'validate' ? 'shapeAutoComplete');
  IF bad <> 0 THEN
    RAISE EXCEPTION 'options.validate.shapeAutoComplete 回填异常,残留 % 行', bad;
  END IF;
END $$;

COMMIT;
