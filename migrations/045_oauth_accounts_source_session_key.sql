-- 045: 保留导入时的原始 sessionKey + 当时使用的 proxy
-- 目的: admin 后台凭据 tab 能查看每个号导入时用的 ck, 以及当时绑的 proxy_id
-- 风险: ADD COLUMN with NULL default = PG metadata-only, 无表锁
-- 已存在的账号 source_session_key = NULL (历史无法补, 只能从今天起记录)

ALTER TABLE oauth_accounts
  ADD COLUMN IF NOT EXISTS source_session_key TEXT,
  ADD COLUMN IF NOT EXISTS source_proxy_id_at_import UUID REFERENCES outbound_proxies(id) ON DELETE SET NULL;

COMMENT ON COLUMN oauth_accounts.source_session_key IS
  'Original sessionKey (sk-ant-sid02-...) used to import this account. Written by batch/single import endpoint, returned by reveal-credentials endpoint with audit log.';
COMMENT ON COLUMN oauth_accounts.source_proxy_id_at_import IS
  'Outbound proxy id used at import time. May differ from current outbound_proxy_id if reassigned. ON DELETE SET NULL.';
