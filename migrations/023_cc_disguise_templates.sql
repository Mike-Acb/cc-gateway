BEGIN;

-- CC disguise templates: DB-backed, deployment-scoped, human-named.
-- Source field records how the template was created:
--   'learned'  — auto-captured from a real CC request
--   'manual'   — operator created via admin UI
--   'cloned'   — copied from another template
CREATE TABLE IF NOT EXISTS cc_disguise_templates (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment               TEXT NOT NULL DEFAULT 'main',
  name                     TEXT NOT NULL,
  description              TEXT,
  tools                    JSONB NOT NULL DEFAULT '[]'::jsonb,
  system_blocks            JSONB NOT NULL DEFAULT '[]'::jsonb,
  source                   TEXT NOT NULL DEFAULT 'learned',
  source_ua                TEXT,
  learned_from_account_id  UUID REFERENCES oauth_accounts(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source IN ('learned', 'manual', 'cloned'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_disguise_templates_name_dep
  ON cc_disguise_templates (deployment, name);

-- Account binding — multiple accounts may share one template.
ALTER TABLE oauth_accounts
  ADD COLUMN IF NOT EXISTS cc_template_id UUID
  REFERENCES cc_disguise_templates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_oauth_accounts_cc_template
  ON oauth_accounts (cc_template_id);

COMMIT;
