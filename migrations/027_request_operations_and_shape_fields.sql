-- 027_request_operations_and_shape_fields.sql
-- Adds logical request operations + request-shape fields so one user action
-- can be analyzed as a root request plus derived/companion child requests.

BEGIN;

CREATE TABLE IF NOT EXISTS request_operations (
  id                UUID PRIMARY KEY,
  root_trace_id     VARCHAR(32) NOT NULL UNIQUE,
  client_name       VARCHAR(64) NOT NULL,
  oauth_account_id  UUID,
  oauth_account_name VARCHAR(64),
  session_key       TEXT,
  root_family       VARCHAR(32) NOT NULL,
  root_profile      VARCHAR(64) NOT NULL,
  status            VARCHAR(16) NOT NULL DEFAULT 'open',
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ,
  summary           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_request_operations_session
  ON request_operations (session_key, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_request_operations_account
  ON request_operations (oauth_account_id, started_at DESC);

ALTER TABLE request_logs
  ADD COLUMN IF NOT EXISTS operation_id UUID,
  ADD COLUMN IF NOT EXISTS root_trace_id VARCHAR(32),
  ADD COLUMN IF NOT EXISTS parent_trace_id VARCHAR(32),
  ADD COLUMN IF NOT EXISTS related_trace_ids JSONB,
  ADD COLUMN IF NOT EXISTS is_root BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS session_key TEXT,
  ADD COLUMN IF NOT EXISTS request_family_in VARCHAR(32),
  ADD COLUMN IF NOT EXISTS request_family_out VARCHAR(32),
  ADD COLUMN IF NOT EXISTS shape_profile_in VARCHAR(64),
  ADD COLUMN IF NOT EXISTS shape_profile_out VARCHAR(64),
  ADD COLUMN IF NOT EXISTS shape_confidence_in SMALLINT,
  ADD COLUMN IF NOT EXISTS shape_confidence_out SMALLINT,
  ADD COLUMN IF NOT EXISTS shape_reason JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_request_logs_operation
  ON request_logs (operation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_request_logs_root_trace
  ON request_logs (root_trace_id, created_at);

CREATE INDEX IF NOT EXISTS idx_request_logs_parent_trace
  ON request_logs (parent_trace_id, created_at)
  WHERE parent_trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_request_logs_session_key
  ON request_logs (session_key, created_at)
  WHERE session_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_request_logs_family_out
  ON request_logs (request_family_out, created_at)
  WHERE request_family_out IS NOT NULL;

COMMIT;
