-- Drop legacy time-window limit / usage counter columns.
-- These were global per-subscription request counters (5h/daily/weekly/monthly).
-- The billing model is now USD balance only; counts are no longer tracked here.
-- If per-model/per-group count limits become a product need later, introduce
-- dedicated plan_limits + subscription_limit_counters tables.

ALTER TABLE plans
  DROP COLUMN IF EXISTS limit_5h,
  DROP COLUMN IF EXISTS limit_daily,
  DROP COLUMN IF EXISTS limit_weekly,
  DROP COLUMN IF EXISTS limit_monthly;

ALTER TABLE subscriptions
  DROP COLUMN IF EXISTS used_5h,
  DROP COLUMN IF EXISTS used_daily,
  DROP COLUMN IF EXISTS used_weekly,
  DROP COLUMN IF EXISTS used_monthly,
  DROP COLUMN IF EXISTS last_reset_5h,
  DROP COLUMN IF EXISTS last_reset_daily,
  DROP COLUMN IF EXISTS last_reset_weekly,
  DROP COLUMN IF EXISTS last_reset_monthly;
