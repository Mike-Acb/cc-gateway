-- Session slot management: limits outbound session_id count per OAuth account

CREATE TABLE IF NOT EXISTS session_slots (
  id                 BIGSERIAL PRIMARY KEY,
  account_id         UUID NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,
  slot_index         SMALLINT NOT NULL,
  derived_session_id VARCHAR(36) NOT NULL,
  bound_keys         TEXT[] NOT NULL DEFAULT '{}',
  reuse_count        INT NOT NULL DEFAULT 0,
  last_used_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, slot_index)
);
CREATE INDEX IF NOT EXISTS idx_session_slots_account ON session_slots(account_id);

CREATE TABLE IF NOT EXISTS session_slot_history (
  id                 BIGSERIAL PRIMARY KEY,
  account_id         UUID NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,
  slot_index         SMALLINT NOT NULL,
  action             VARCHAR(16) NOT NULL,
  client_name        VARCHAR(64),
  evicted_client     VARCHAR(64),
  idle_duration_ms   BIGINT,
  reuse_number       INT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_slot_history_account ON session_slot_history(account_id, created_at DESC);

-- Change default max_sessions from 0 (unlimited) to 3
ALTER TABLE oauth_accounts ALTER COLUMN max_sessions SET DEFAULT 3;
UPDATE oauth_accounts SET max_sessions = 3 WHERE max_sessions = 0;
