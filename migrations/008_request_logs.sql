-- 008_request_logs.sql — Request logging with trace-id

BEGIN;

-- Request logs (partitioned by month, same as usage_records)
CREATE TABLE IF NOT EXISTS request_logs (
  id                  BIGSERIAL,
  trace_id            VARCHAR(32) NOT NULL,
  client_id           UUID,
  client_name         VARCHAR(64) NOT NULL,
  oauth_account_id    UUID,
  oauth_account_name  VARCHAR(64),
  method              VARCHAR(8) NOT NULL,
  path                VARCHAR(255) NOT NULL,
  client_ip           VARCHAR(45),
  request_model       VARCHAR(64),
  request_body        JSONB,
  response_status     SMALLINT,
  response_body       JSONB,
  latency_ms          INT,
  error_message       TEXT,
  retry_count         SMALLINT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS idx_request_logs_trace ON request_logs (trace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_client ON request_logs (client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_account ON request_logs (oauth_account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_time ON request_logs (created_at);

-- Create partitions for current and next month
DO $$
DECLARE
  cur_start DATE := date_trunc('month', CURRENT_DATE);
  cur_end   DATE := cur_start + INTERVAL '1 month';
  nxt_start DATE := cur_end;
  nxt_end   DATE := nxt_start + INTERVAL '1 month';
  cur_name  TEXT := 'request_logs_' || to_char(cur_start, 'YYYY_MM');
  nxt_name  TEXT := 'request_logs_' || to_char(nxt_start, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF request_logs FOR VALUES FROM (%L) TO (%L)',
    cur_name, cur_start, cur_end
  );
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF request_logs FOR VALUES FROM (%L) TO (%L)',
    nxt_name, nxt_start, nxt_end
  );
END $$;

-- Add trace_id to usage_records for cross-referencing
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS trace_id VARCHAR(32);
CREATE INDEX IF NOT EXISTS idx_usage_trace ON usage_records (trace_id);

COMMIT;
