-- Snapshot the post-debit subscription balance on each usage_records row at
-- metering time. Without this column the only way to know "balance right
-- after this request was debited" is to reconstruct via
--   live_balance + SUM(cost of later deductions)
-- which is wrong whenever the user recharges/adjusts mid-period.
--
-- NULL on legacy rows (recorded before this migration); the UI falls back
-- to the reconstruction for those.

BEGIN;

ALTER TABLE usage_records
  ADD COLUMN IF NOT EXISTS balance_after NUMERIC(14,6);

COMMIT;
