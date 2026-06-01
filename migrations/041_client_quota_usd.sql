-- 041_client_quota_usd.sql
-- 每个 client(API key) 可配置 USD 累计额度上限。
--   NULL  = 无限 (默认)
--   0.0+  = 总额度;当 SUM(usage_records.cost) >= quota_usd 时,网关返回 402 拒绝请求。
-- 这里只记录配置;实际执行点在 src/quota-checker.ts。

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS quota_usd NUMERIC(12,4) NULL DEFAULT NULL;
