-- 043_oauth_accounts_banned_at.sql
-- 加 banned_at 字段记录账号被封禁的具体时间戳。
-- 当 status 变为 'banned' 或 'disabled' 时,通过 trigger 自动写入 now()。
BEGIN;

ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_oauth_accounts_banned_at
  ON oauth_accounts (banned_at DESC) WHERE banned_at IS NOT NULL;

-- Trigger function: set banned_at when status transitions to banned/disabled
CREATE OR REPLACE FUNCTION oauth_accounts_track_banned_at() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('banned', 'disabled') AND
     (OLD.status IS NULL OR OLD.status NOT IN ('banned', 'disabled')) THEN
    NEW.banned_at := COALESCE(NEW.banned_at, now());
  END IF;
  -- If status returns to active and banned_at was set, clear it
  IF NEW.status = 'active' AND OLD.status IN ('banned', 'disabled') THEN
    NEW.banned_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS oauth_accounts_banned_at_trigger ON oauth_accounts;
CREATE TRIGGER oauth_accounts_banned_at_trigger
  BEFORE UPDATE ON oauth_accounts
  FOR EACH ROW
  EXECUTE FUNCTION oauth_accounts_track_banned_at();

-- Backfill banned_at for existing banned/disabled accounts (use updated_at)
UPDATE oauth_accounts
   SET banned_at = updated_at
 WHERE status IN ('banned', 'disabled') AND banned_at IS NULL;

COMMIT;
