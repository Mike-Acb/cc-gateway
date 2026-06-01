-- 016_audit_logs.sql
-- Structured audit trail for admin write operations. Every mutation through
-- /api/admin/* (plans, accounts, groups, users, subscriptions, clients,
-- campaigns, system) emits a row here via server/src/services/audit.ts.
-- `before`/`after` capture the pre/post-mutation snapshot with sensitive
-- fields (access_token / refresh_token / api_key / password_hash / secret)
-- redacted before storage.
BEGIN;

CREATE TABLE IF NOT EXISTS audit_logs (
  id            BIGSERIAL PRIMARY KEY,
  actor_id      UUID,
  actor_email   VARCHAR(255),
  action        VARCHAR(64)  NOT NULL,
  resource_type VARCHAR(32)  NOT NULL,
  resource_id   VARCHAR(128),
  before        JSONB,
  after         JSONB,
  summary       TEXT,
  ip            VARCHAR(45),
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_time     ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor    ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action   ON audit_logs (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs (resource_type, resource_id, created_at DESC);

COMMIT;
