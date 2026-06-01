BEGIN;

CREATE TABLE IF NOT EXISTS system_settings (
  key        VARCHAR(64) PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbound_proxies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           VARCHAR(128) NOT NULL,
  fingerprint    CHAR(64) NOT NULL UNIQUE,
  scheme         VARCHAR(16) NOT NULL,
  host           VARCHAR(255) NOT NULL,
  port           INT NOT NULL,
  username       VARCHAR(255),
  password       TEXT,
  status         VARCHAR(16) NOT NULL DEFAULT 'active',
  weight         INT NOT NULL DEFAULT 10,
  last_used_at   TIMESTAMPTZ,
  last_error     TEXT,
  success_count  BIGINT NOT NULL DEFAULT 0,
  fail_count     BIGINT NOT NULL DEFAULT 0,
  failure_streak INT NOT NULL DEFAULT 0,
  cooldown_until TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO system_settings (key, value, updated_at)
VALUES ('outbound_proxy_enabled', 'false', now())
ON CONFLICT (key) DO NOTHING;

COMMIT;
