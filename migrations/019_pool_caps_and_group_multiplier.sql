BEGIN;

-- 1. plans: pool 四档额度上限（USD, NULL=不限, 0=禁）
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS limit_5h_usd  NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS limit_1d_usd  NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS limit_7d_usd  NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS limit_30d_usd NUMERIC(12,6);

-- 2. subscriptions: 4 窗口状态（首请求触发，窗口内累计 USD）
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS window_5h_start  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS window_5h_used   NUMERIC(12,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS window_1d_start  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS window_1d_used   NUMERIC(12,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS window_7d_start  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS window_7d_used   NUMERIC(12,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS window_30d_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS window_30d_used  NUMERIC(12,6) NOT NULL DEFAULT 0;

-- 3. usage_records: 归属订阅
ALTER TABLE usage_records
  ADD COLUMN IF NOT EXISTS subscription_id UUID;
CREATE INDEX IF NOT EXISTS idx_usage_records_subscription ON usage_records (subscription_id);

-- 4. account_groups: 倍率
ALTER TABLE account_groups
  ADD COLUMN IF NOT EXISTS cost_multiplier NUMERIC(6,3) NOT NULL DEFAULT 1.000;

-- 5. oauth_account_groups: 多对多
CREATE TABLE IF NOT EXISTS oauth_account_groups (
  account_id UUID NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,
  group_id   UUID NOT NULL REFERENCES account_groups(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_oauth_account_groups_group ON oauth_account_groups (group_id);

-- 迁移现有 oauth_accounts.group_id 数据
INSERT INTO oauth_account_groups (account_id, group_id)
SELECT id, group_id FROM oauth_accounts WHERE group_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- 6. clients.group_id: 允许 NULL（NULL = auto，自动选最低倍率组）
ALTER TABLE clients ALTER COLUMN group_id DROP NOT NULL;

-- 7. system_settings: prebill_usd
INSERT INTO system_settings (key, value) VALUES ('prebill_usd', '0.025')
ON CONFLICT (key) DO NOTHING;

COMMIT;
