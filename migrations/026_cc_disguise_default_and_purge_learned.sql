BEGIN;

-- Fingerprint-leak remediation 2026-04-20:
--   1. Add is_default flag so admins can mark one template per deployment as
--      the fallback for new-account creation and backfill actions.
--   2. Purge all source='learned' templates. Auto-learned templates captured
--      whatever the first CC client sent, which drifts from the current CC
--      release and leaks a version-stale fingerprint. Going forward, the only
--      way to introduce a template is manual import via the admin API
--      (POST /api/admin/cc-disguise-templates), seeded from a fresh HAR.
--
-- Accounts that pointed at the deleted templates have their cc_template_id
-- reset to NULL via the existing ON DELETE SET NULL FK clause (migration 023).
-- OAuth accounts with NULL cc_template_id are refused at select time by
-- isAccountUsable(); admin must import a new template and bind or backfill.

-- 1. is_default flag + unique partial index (at most one default per deployment)
ALTER TABLE cc_disguise_templates
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_disguise_templates_default_per_dep
  ON cc_disguise_templates (deployment)
  WHERE is_default = TRUE;

-- 2. Purge learned templates (fingerprint-stale).
DELETE FROM cc_disguise_templates WHERE source = 'learned';

-- 3. Relax the source CHECK — 'learned' is no longer accepted. Existing rows
--    with source='learned' are already deleted above.
ALTER TABLE cc_disguise_templates DROP CONSTRAINT IF EXISTS cc_disguise_templates_source_check;
ALTER TABLE cc_disguise_templates
  ADD CONSTRAINT cc_disguise_templates_source_check
  CHECK (source IN ('manual', 'cloned', 'imported'));

COMMIT;
