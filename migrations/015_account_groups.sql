-- 015_account_groups.sql
-- Introduce account groups: a group couples a set of oauth_accounts with a set
-- of clients to share the same scheduling scope. NULL oauth_accounts.group_id
-- means "shared pool". clients.group_id is NOT NULL with a default group as
-- fallback.
BEGIN;

CREATE TABLE IF NOT EXISTS account_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(64) NOT NULL UNIQUE,
  description TEXT,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_account_groups_default
  ON account_groups (is_default) WHERE is_default = true;

-- Seed default group
INSERT INTO account_groups (name, description, is_default)
VALUES ('default', '默认组，未指定组的客户端兜底使用', true)
ON CONFLICT (name) DO NOTHING;

-- OAuth accounts: nullable group_id, NULL = 共享池
ALTER TABLE oauth_accounts
  ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES account_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_accounts_group ON oauth_accounts (group_id);

-- Clients: NOT NULL group_id, 先允许 NULL 做回填再加约束
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES account_groups(id) ON DELETE RESTRICT;

UPDATE clients
SET group_id = (SELECT id FROM account_groups WHERE is_default = true LIMIT 1)
WHERE group_id IS NULL;

ALTER TABLE clients ALTER COLUMN group_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clients_group ON clients (group_id);

COMMIT;
