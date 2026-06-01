-- 001_core.sql — Users, clients, usage, quotas, rate limits, model pricing

BEGIN;

-- Users (Dashboard login accounts)
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username        VARCHAR(64) UNIQUE NOT NULL,
  email           VARCHAR(255) UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  role            VARCHAR(16) NOT NULL DEFAULT 'user',
  status          VARCHAR(16) NOT NULL DEFAULT 'active',
  invited_by      UUID REFERENCES users(id),
  invite_bound_at TIMESTAMPTZ,
  free_until      DATE,
  discount_rate   DECIMAL(3,2) DEFAULT 1.0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Clients (Gateway tokens)
CREATE TABLE IF NOT EXISTS clients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  name            VARCHAR(64) NOT NULL,
  token           CHAR(64) UNIQUE NOT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'pending',
  approved_by     UUID REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  suspended_at    TIMESTAMPTZ,
  suspend_reason  VARCHAR(64),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, name)
);

-- Usage records (partitioned by month)
CREATE TABLE IF NOT EXISTS usage_records (
  id              BIGSERIAL,
  client_id       UUID NOT NULL,
  model           VARCHAR(64) NOT NULL,
  input_tokens    INT NOT NULL DEFAULT 0,
  output_tokens   INT NOT NULL DEFAULT 0,
  cache_read      INT NOT NULL DEFAULT 0,
  cache_write     INT NOT NULL DEFAULT 0,
  cost            DECIMAL(10,6) NOT NULL DEFAULT 0,
  latency_ms      INT,
  path            VARCHAR(255),
  status_code     SMALLINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS idx_usage_client_time ON usage_records (client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_records (created_at);

-- Create partitions for current and next month
DO $$
DECLARE
  cur_start DATE := date_trunc('month', CURRENT_DATE);
  cur_end   DATE := cur_start + INTERVAL '1 month';
  nxt_start DATE := cur_end;
  nxt_end   DATE := nxt_start + INTERVAL '1 month';
  cur_name  TEXT := 'usage_records_' || to_char(cur_start, 'YYYY_MM');
  nxt_name  TEXT := 'usage_records_' || to_char(nxt_start, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_records FOR VALUES FROM (%L) TO (%L)',
    cur_name, cur_start, cur_end
  );
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_records FOR VALUES FROM (%L) TO (%L)',
    nxt_name, nxt_start, nxt_end
  );
END $$;

-- Quota rules
CREATE TABLE IF NOT EXISTS quota_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type     VARCHAR(8) NOT NULL,
  target_id       UUID NOT NULL,
  metric          VARCHAR(16) NOT NULL,
  "window"        INTERVAL NOT NULL,
  max_value       DECIMAL NOT NULL,
  action          VARCHAR(16) NOT NULL DEFAULT 'reject',
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rate limits
CREATE TABLE IF NOT EXISTS rate_limits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type     VARCHAR(8) NOT NULL,
  target_id       UUID NOT NULL,
  max_rpm         INT NOT NULL,
  max_rph         INT,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Model pricing
CREATE TABLE IF NOT EXISTS model_pricing (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_pattern    VARCHAR(64) NOT NULL,
  input_mtok       DECIMAL(10,4) NOT NULL,
  output_mtok      DECIMAL(10,4) NOT NULL,
  cache_read_mtok  DECIMAL(10,4) NOT NULL DEFAULT 0,
  cache_write_mtok DECIMAL(10,4) NOT NULL DEFAULT 0,
  effective_from   DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(model_pattern, effective_from)
);

-- Seed default model pricing
INSERT INTO model_pricing (model_pattern, input_mtok, output_mtok, cache_read_mtok, cache_write_mtok) VALUES
  ('claude-opus-4-6',   15.00, 75.00, 1.50, 18.75),
  ('claude-sonnet-4-6',  3.00, 15.00, 0.30,  3.75),
  ('claude-haiku-4-5',   0.80,  4.00, 0.08,  1.00)
ON CONFLICT (model_pattern, effective_from) DO NOTHING;

-- Also create ALL the tables from the full spec (Phase 2-4 tables):

-- Daily costs
CREATE TABLE IF NOT EXISTS daily_costs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date           DATE UNIQUE NOT NULL,
  amount         DECIMAL(10,2) NOT NULL,
  note           VARCHAR(255),
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Invoices
CREATE TABLE IF NOT EXISTS invoices (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id),
  period_start     DATE NOT NULL,
  period_end       DATE NOT NULL,
  original_amount  DECIMAL(10,2),
  coupon_id        UUID,
  coupon_amount    DECIMAL(10,2) DEFAULT 0,
  discount_rate    DECIMAL(3,2) DEFAULT 1.0,
  token_credit_used BIGINT DEFAULT 0,
  total_due        DECIMAL(10,2) NOT NULL,
  status           VARCHAR(16) NOT NULL DEFAULT 'draft',
  due_date         DATE,
  issued_at        TIMESTAMPTZ,
  paid_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Invoice items
CREATE TABLE IF NOT EXISTS invoice_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     UUID NOT NULL REFERENCES invoices(id),
  type           VARCHAR(8) NOT NULL,
  model          VARCHAR(64),
  input_tokens   BIGINT,
  output_tokens  BIGINT,
  unit_cost      DECIMAL(10,6),
  subtotal       DECIMAL(10,4),
  total_cost     DECIMAL(10,4),
  user_tokens    BIGINT,
  all_tokens     BIGINT,
  share_ratio    DECIMAL(5,4),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Payments
CREATE TABLE IF NOT EXISTS payments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     UUID NOT NULL REFERENCES invoices(id),
  user_id        UUID NOT NULL REFERENCES users(id),
  amount         DECIMAL(10,2) NOT NULL,
  provider       VARCHAR(16) NOT NULL DEFAULT 'epay',
  trade_no       VARCHAR(64),
  out_trade_no   VARCHAR(64) UNIQUE,
  status         VARCHAR(16) NOT NULL DEFAULT 'pending',
  paid_at        TIMESTAMPTZ,
  raw_callback   JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id),
  type           VARCHAR(16) NOT NULL,
  title          VARCHAR(255) NOT NULL,
  content        TEXT,
  read           BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Webhook configs
CREATE TABLE IF NOT EXISTS webhook_configs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id),
  url            VARCHAR(512) NOT NULL,
  secret         VARCHAR(128),
  events         TEXT[] NOT NULL,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Campaigns
CREATE TABLE IF NOT EXISTS campaigns (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(128) NOT NULL,
  type             VARCHAR(16) NOT NULL,
  status           VARCHAR(16) NOT NULL DEFAULT 'active',
  start_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  end_at           TIMESTAMPTZ,
  max_uses         INT,
  current_uses     INT NOT NULL DEFAULT 0,
  invite_required  BOOLEAN NOT NULL DEFAULT false,
  code_prefix      VARCHAR(16),
  codes_per_user   INT NOT NULL DEFAULT 5,
  bind_window      INTERVAL NOT NULL DEFAULT '5 days',
  inviter_rewards  JSONB,
  invitee_rewards  JSONB,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Invite codes
CREATE TABLE IF NOT EXISTS invite_codes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    UUID NOT NULL REFERENCES campaigns(id),
  owner_id       UUID NOT NULL REFERENCES users(id),
  code           VARCHAR(16) UNIQUE NOT NULL,
  max_uses       INT NOT NULL DEFAULT 1,
  used_count     INT NOT NULL DEFAULT 0,
  status         VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Invite bindings
CREATE TABLE IF NOT EXISTS invite_bindings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_code_id UUID NOT NULL REFERENCES invite_codes(id),
  inviter_id     UUID NOT NULL REFERENCES users(id),
  invitee_id     UUID NOT NULL REFERENCES users(id),
  status         VARCHAR(16) NOT NULL DEFAULT 'bound',
  bound_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(invitee_id)
);

-- Rewards
CREATE TABLE IF NOT EXISTS rewards (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id),
  campaign_id    UUID REFERENCES campaigns(id),
  binding_id     UUID REFERENCES invite_bindings(id),
  type           VARCHAR(16) NOT NULL,
  status         VARCHAR(16) NOT NULL DEFAULT 'active',
  coupon_id      UUID,
  token_amount   BIGINT,
  token_remaining BIGINT,
  free_until     DATE,
  discount_rate  DECIMAL(3,2),
  discount_periods_left INT,
  expires_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Coupons
CREATE TABLE IF NOT EXISTS coupons (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id),
  code           VARCHAR(32) UNIQUE NOT NULL,
  amount         DECIMAL(10,2) NOT NULL,
  min_order      DECIMAL(10,2) NOT NULL DEFAULT 0,
  status         VARCHAR(16) NOT NULL DEFAULT 'unused',
  used_at        TIMESTAMPTZ,
  used_on_invoice UUID REFERENCES invoices(id),
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
