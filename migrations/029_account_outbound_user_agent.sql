BEGIN;

-- api_key 账号自定义出站 User-Agent。中转网关（如 cchubapi）会挑剔 UA 字符串，
-- 真实 CC 客户端发的 `claude-cli/X.Y.Z (external, cli)` / `claude-code/X.Y.Z`
-- 很容易被拒；默认留空 = 不发送 User-Agent，需要时再按中转期望的格式显式覆盖。
ALTER TABLE oauth_accounts
  ADD COLUMN IF NOT EXISTS outbound_user_agent TEXT;

COMMIT;
