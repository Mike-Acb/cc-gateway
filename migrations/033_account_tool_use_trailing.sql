BEGIN;

-- 截断 assistant 消息中最后一个 tool_use 之后的 text/thinking/redacted_thinking 块。
-- 修客户端 SDK 重组 thinking + tool_use streaming 时把 text 重复输出导致的
-- [text, tool_use, text(重复)] 畸形 — Anthropic 上游对该结构会报
-- `tool_use ids were found without tool_result blocks immediately after`
-- (字面是配对缺失,实际是 block 顺序违规)。
-- 真实 trace:ccg-moxta8zc-2972c92fb8f7 (sharpglacier665, 2026-05-09 11:55)
--
-- 默认 true:OAuth 关闭 = 直接 400;APIKEY 默认 true (多数 provider 走 Anthropic),
-- 仅当透传到第三方 provider 不期望 body 改写时由用户在 UI 显式关闭。

UPDATE oauth_accounts
SET options = jsonb_set(
  options,
  '{clean,toolUseTrailing}',
  'true'::jsonb,
  true
)
WHERE NOT (options->'clean' ? 'toolUseTrailing');

DO $$
DECLARE bad INT;
BEGIN
  SELECT COUNT(*) INTO bad FROM oauth_accounts
   WHERE NOT (options->'clean' ? 'toolUseTrailing');
  IF bad <> 0 THEN
    RAISE EXCEPTION 'options.clean.toolUseTrailing 回填异常,残留 % 行', bad;
  END IF;
END $$;

COMMIT;
