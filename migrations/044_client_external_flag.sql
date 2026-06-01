-- 044_client_external_flag.sql
-- 标记某个 client 为「外部第三方」(如 CherryStudio 走 Go 中转过来)。
-- gateway 看到这个标志会主动给请求加 CC 伪装包装:
--   - 重写 inbound User-Agent 为 claude-cli/2.1.132 (external, cli)
--   - prepend "You are Claude Code..." 到 system 块
--   - 跳过 CC 工具集校验(否则被 NonCCRequest 直接拒)
-- 你自己 CC 用的号(默认 false)不受任何影响。
BEGIN;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS external_client BOOLEAN NOT NULL DEFAULT FALSE;
COMMIT;
