-- 042_client_reserved_usd.sql
-- 每个 client 在请求生命周期内的「预扣余额占用」。
--   入口: reserved_usd += system_settings.prebill_usd
--   出口: reserved_usd -= system_settings.prebill_usd (真实 cost 由 metering 写 usage_records)
-- quota-checker 比较 (SUM(usage_records.cost) + reserved_usd) >= quota_usd,
-- 防止单次大请求穿越限额。
-- 异常 abort 会泄漏占用,后续由 cron 按 reserved_at 超时清理(本次不做)。

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS reserved_usd NUMERIC(12,4) NOT NULL DEFAULT 0;
