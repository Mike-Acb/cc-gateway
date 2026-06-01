BEGIN;

-- Anthropic API hard limit:每个 /v1/messages 请求 cache_control 块总数 ≤4
-- (system + tools + messages 累计)。超出 → 上游 400 "A maximum of 4 blocks
-- with cache_control may be provided. Found N"。
--
-- 该开关启用 gateway 末端兜底:在 disguiseBody 之后(OAuth 路径)/ ApiKey
-- 直连路径上,若 body 总 cache_control > 4,按 messages → tools → system
-- 倒序 strip 多余的(头部 cache_control 通常是 system / 静态 tools 缓存,
-- 比尾部 messages 增量缓存更值得保留)。
--
-- 默认 true:OAuth 关闭可能 400;ApiKey 直连不到 Anthropic 的 provider
-- (无此限制) 时由用户在 UI 显式关闭。

UPDATE oauth_accounts
SET options = jsonb_set(
  options,
  '{clean,capCacheControl}',
  'true'::jsonb,
  true
)
WHERE NOT (options->'clean' ? 'capCacheControl');

DO $$
DECLARE bad INT;
BEGIN
  SELECT COUNT(*) INTO bad FROM oauth_accounts
   WHERE NOT (options->'clean' ? 'capCacheControl');
  IF bad <> 0 THEN
    RAISE EXCEPTION 'options.clean.capCacheControl 回填异常,残留 % 行', bad;
  END IF;
END $$;

COMMIT;
