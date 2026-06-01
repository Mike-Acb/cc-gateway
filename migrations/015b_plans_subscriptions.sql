-- 015b_plans_subscriptions.sql (DEPLOYMENT FIX)
-- v5 源码中遗漏 plans 和 subscriptions 两张表的建表 SQL。
-- 此迁移补上 baseline schema,放在 015 之后、017 之前的位置确保
-- 后续 ALTER 能正常 ADD COLUMN。

BEGIN;

-- Plans (订阅计划)
CREATE TABLE IF NOT EXISTS plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(128) NOT NULL,
  type            VARCHAR(16) NOT NULL,
  subtype         VARCHAR(32),
  price           DECIMAL(10,2) NOT NULL DEFAULT 0,
  currency        VARCHAR(8) NOT NULL DEFAULT 'USD',
  quota_amount    NUMERIC(12,6),
  duration_days   INT,
  max_concurrent  INT NOT NULL DEFAULT 1,
  sort_order      INT NOT NULL DEFAULT 0,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  description     TEXT,
  features        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plans_enabled ON plans (enabled, type, sort_order, price);

-- Subscriptions (用户订阅记录)
CREATE TABLE IF NOT EXISTS subscriptions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id),
  plan_id             UUID NOT NULL REFERENCES plans(id),
  status              VARCHAR(16) NOT NULL DEFAULT 'pending',
  balance             NUMERIC(12,6) NOT NULL DEFAULT 0,
  remaining_uses      INT,
  starts_at           TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user   ON subscriptions (user_id, status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_plan   ON subscriptions (plan_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions (status);

COMMIT;
