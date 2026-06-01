BEGIN;

-- 给所有现有账号回填 options.clean.canonicalizeNonCCTools = false。
-- 这个开关用于把非 CC 客户端 (opencode/crush 等) 的 snake_case 工具集改写成
-- CC 风格,过 validateCCRequest baseline。响应 SSE 阶段再反向。
-- 默认 false:只有显式给"愿意吃这类流量"的账号开启,普通 OAuth/APIKEY 不动。

UPDATE oauth_accounts
SET options = jsonb_set(
  options,
  '{clean,canonicalizeNonCCTools}',
  'false'::jsonb,
  true
)
WHERE NOT (options->'clean' ? 'canonicalizeNonCCTools');

DO $$
DECLARE bad INT;
BEGIN
  SELECT COUNT(*) INTO bad FROM oauth_accounts
   WHERE NOT (options->'clean' ? 'canonicalizeNonCCTools');
  IF bad <> 0 THEN
    RAISE EXCEPTION 'options.clean.canonicalizeNonCCTools 回填异常,残留 % 行', bad;
  END IF;
END $$;

COMMIT;
