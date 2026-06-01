BEGIN;

-- API key 账号也启用 shapeAutoComplete (Tier 1 零副作用补齐)。
-- 与 OAuth 通道同款待遇:接受 HAR Pending profile + 缺 temperature 补 1。
-- API key 通道本来就不需要 fingerprint 伪装(直接用 key 调上游 Anthropic 按用量
-- 计费,不走 plan 限额),shape gate 严格拦截对它纯粹是误伤。开 shapeAutoComplete
-- 让兜底 profile 能通过 gate,降低无意义的 400 拒绝。
UPDATE oauth_accounts
SET options = jsonb_set(
  options,
  '{validate,shapeAutoComplete}',
  'true'::jsonb,
  true
)
WHERE auth_kind = 'api_key'
  AND options->'validate'->>'shapeAutoComplete' = 'false';

DO $$
DECLARE bad INT;
BEGIN
  SELECT COUNT(*) INTO bad FROM oauth_accounts
   WHERE auth_kind = 'api_key'
     AND options->'validate'->>'shapeAutoComplete' <> 'true';
  IF bad <> 0 THEN
    RAISE EXCEPTION 'api_key 账号 shapeAutoComplete 未全部回填 true,残留 %', bad;
  END IF;
END $$;

COMMIT;
