BEGIN;

-- temperature 规整开关:把客户端 temperature 拉到 CC 真实分布。
-- thinking active (enabled/adaptive) → 删 temperature;否则 → temperature=1。
-- 配合 inbound-validate 的执行顺序(在 requestShape 之前),让 IDE agent
-- (Roo Code / Cline 默认 temperature=0) 经修正后命中 agentic_*_t1_like profile,
-- 自动通过 shape 校验。
--
-- 回填策略:
--   - OAuth 账号 → true (CC 伪装通道默认对齐 CC 真实分布)
--   - APIKEY 账号 → false (透传通道,客户端 temperature 原样发到上游)
--
-- 这与 OAUTH_DEFAULT_OPTIONS / APIKEY_DEFAULT_OPTIONS 的代码默认值一致。
-- 不回填会让现存账号 zod 解析时拿到 schema 默认 false,导致 OAuth 账号
-- 不规整 temperature → 第三方 IDE agent 客户端继续被 shape 校验拦下。

-- 1) 回填 normalizeTemperature 字段
UPDATE oauth_accounts
SET options = jsonb_set(
  options,
  '{validate,normalizeTemperature}',
  CASE
    WHEN auth_kind = 'oauth' THEN 'true'::jsonb
    ELSE 'false'::jsonb
  END,
  true
)
WHERE NOT (options->'validate' ? 'normalizeTemperature');

-- 2) 不变量自检:迁移后所有行都有 normalizeTemperature 字段
DO $$
DECLARE bad INT;
BEGIN
  SELECT COUNT(*) INTO bad FROM oauth_accounts
   WHERE NOT (options->'validate' ? 'normalizeTemperature');
  IF bad <> 0 THEN
    RAISE EXCEPTION 'options.validate.normalizeTemperature 回填异常,残留 % 行', bad;
  END IF;

  -- OAuth 账号必须 normalizeTemperature=true(代码默认值,关闭会让 IDE 客户端被拒)
  SELECT COUNT(*) INTO bad FROM oauth_accounts
   WHERE auth_kind = 'oauth'
     AND options->'validate'->>'normalizeTemperature' <> 'true';
  IF bad <> 0 THEN
    RAISE EXCEPTION 'OAuth 账号 normalizeTemperature 应为 true,异常 % 行', bad;
  END IF;
END $$;

COMMIT;
