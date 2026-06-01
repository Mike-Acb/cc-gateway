BEGIN;

CREATE TABLE IF NOT EXISTS oauth_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(64) NOT NULL,
  refresh_token   TEXT NOT NULL,
  access_token    TEXT,
  expires_at      BIGINT DEFAULT 0,
  status          VARCHAR(16) DEFAULT 'active',
  account_type    VARCHAR(16) DEFAULT 'pro',
  max_rpm         INT DEFAULT 60,
  max_tpm         INT DEFAULT 80000,
  max_concurrent  INT DEFAULT 5,
  max_sessions    INT DEFAULT 0,
  max_daily_req   INT DEFAULT 0,
  max_daily_tok   BIGINT DEFAULT 0,
  max_daily_cost  DECIMAL(10,2) DEFAULT 0,
  weight          INT DEFAULT 10,
  models          TEXT[],
  cooldown_seconds INT DEFAULT 60,
  max_retries     INT DEFAULT 2,
  total_requests  BIGINT DEFAULT 0,
  total_tokens    BIGINT DEFAULT 0,
  total_cost      DECIMAL(10,4) DEFAULT 0,
  last_used_at    TIMESTAMPTZ,
  last_error      TEXT,
  last_health_check TIMESTAMPTZ,
  health_status   VARCHAR(16) DEFAULT 'unknown',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS oauth_account_id UUID;

COMMIT;
