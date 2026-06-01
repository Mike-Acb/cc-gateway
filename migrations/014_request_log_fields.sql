-- migrations/014_request_log_fields.sql
-- Adds four observability columns to request_logs:
--   first_token_ms  — SSE time-to-first-token (streaming only)
--   streaming       — whether the request used SSE
--   block_reason    — structured reason code when the request was blocked
--                     (rate_limited, plan_forbidden_model, quota_exceeded,
--                      auth_missing, malformed_block, upstream_5xx, upstream_429)
--   block_source    — 'gw' (gateway rejected) | 'up' (upstream rejected)
-- Successful requests leave both block_* columns NULL.
BEGIN;

ALTER TABLE request_logs
  ADD COLUMN IF NOT EXISTS first_token_ms INT,
  ADD COLUMN IF NOT EXISTS streaming BOOLEAN,
  ADD COLUMN IF NOT EXISTS block_reason VARCHAR(32),
  ADD COLUMN IF NOT EXISTS block_source VARCHAR(4);

CREATE INDEX IF NOT EXISTS idx_request_logs_block_reason
  ON request_logs (block_reason, created_at)
  WHERE block_reason IS NOT NULL;

COMMIT;
