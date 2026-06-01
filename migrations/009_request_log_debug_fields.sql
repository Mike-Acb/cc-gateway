-- 009_request_log_debug_fields.sql — Optional detailed request/response fields

BEGIN;

ALTER TABLE request_logs
  ADD COLUMN IF NOT EXISTS request_headers_in JSONB,
  ADD COLUMN IF NOT EXISTS request_headers_out JSONB,
  ADD COLUMN IF NOT EXISTS request_body_out JSONB,
  ADD COLUMN IF NOT EXISTS response_headers JSONB;

COMMIT;
