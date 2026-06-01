-- 037_request_log_group.sql
-- 记录每条请求实际命中的 account_group(driven by AccountSelection.selectedGroupId),
-- 让管理员能在请求日志列表里看到“这个请求打在了哪个分组”。NULL = 共享池。
--
-- 不加外键,与本表既有 oauth_account_id/oauth_account_name 同款处理:request_logs
-- 是按月分区的,跨分区 FK 行为不便,后续 list 查询 LEFT JOIN account_groups 解析名字。
BEGIN;

ALTER TABLE request_logs
  ADD COLUMN IF NOT EXISTS selected_group_id UUID;

CREATE INDEX IF NOT EXISTS idx_request_logs_group
  ON request_logs (selected_group_id, created_at)
  WHERE selected_group_id IS NOT NULL;

COMMIT;
