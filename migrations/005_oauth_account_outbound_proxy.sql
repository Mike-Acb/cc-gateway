BEGIN;

ALTER TABLE oauth_accounts
  ADD COLUMN IF NOT EXISTS outbound_proxy_id UUID REFERENCES outbound_proxies(id) ON DELETE SET NULL;

COMMIT;
