-- Allow admin to opt-in to non-streaming requests per account.
-- Real Claude Code always sends stream: true, so non-stream is a client-side
-- fingerprint anomaly. Default FALSE blocks non-stream requests at the gateway.

ALTER TABLE oauth_accounts
  ADD COLUMN allow_non_stream BOOLEAN NOT NULL DEFAULT FALSE;
