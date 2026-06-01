BEGIN;

-- Tier 2 主动伪装开关:tools 替换 + context_management 模板化覆盖。
-- 与 Tier 1 (shapeAutoComplete) 边界明确分开 — 那个是零副作用补齐,
-- 这个是主动语义破坏 (客户端 tool_use / compact 配置失效)。
--
-- 同步策略:把现有 shapeAutoComplete=true 的账号同步设 aggressiveDisguise=true,
-- 因为之前 shapeAutoComplete 已经包含 tools 替换,不同步会让运行中的账号
-- 突然失去 tools 替换行为,触发 'Third-party apps...' 上游 reject。

-- 1) 回填 aggressiveDisguise 字段
UPDATE oauth_accounts
SET options = jsonb_set(
  options,
  '{validate,aggressiveDisguise}',
  CASE
    WHEN options->'validate'->>'shapeAutoComplete' = 'true' THEN 'true'::jsonb
    ELSE 'false'::jsonb
  END,
  true
)
WHERE NOT (options->'validate' ? 'aggressiveDisguise');

-- 2) 不变量自检:迁移后所有行都有 aggressiveDisguise 字段
DO $$
DECLARE bad INT;
BEGIN
  SELECT COUNT(*) INTO bad FROM oauth_accounts
   WHERE NOT (options->'validate' ? 'aggressiveDisguise');
  IF bad <> 0 THEN
    RAISE EXCEPTION 'options.validate.aggressiveDisguise 回填异常,残留 % 行', bad;
  END IF;

  -- shapeAutoComplete=true 必须同时 aggressiveDisguise=true,否则失去 tools 替换
  SELECT COUNT(*) INTO bad FROM oauth_accounts
   WHERE options->'validate'->>'shapeAutoComplete' = 'true'
     AND options->'validate'->>'aggressiveDisguise' <> 'true';
  IF bad <> 0 THEN
    RAISE EXCEPTION 'shapeAutoComplete=true 应同步 aggressiveDisguise=true,异常 %', bad;
  END IF;
END $$;

COMMIT;
