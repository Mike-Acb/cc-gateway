-- 013_deployment_tag.sql — 为 users/clients/oauth_accounts 加 deployment 软隔离列

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deployment VARCHAR(16) NOT NULL DEFAULT 'gw';
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS deployment VARCHAR(16) NOT NULL DEFAULT 'gw';
ALTER TABLE oauth_accounts
  ADD COLUMN IF NOT EXISTS deployment VARCHAR(16) NOT NULL DEFAULT 'gw';

CREATE INDEX IF NOT EXISTS idx_users_deployment         ON users (deployment);
CREATE INDEX IF NOT EXISTS idx_clients_deployment       ON clients (deployment);
CREATE INDEX IF NOT EXISTS idx_oauth_accounts_deploy    ON oauth_accounts (deployment);

COMMIT;
