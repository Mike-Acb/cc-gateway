BEGIN;

-- Reusable machine fingerprint templates (env + prompt_env).
-- Per-account identity (device_id / email / account_uuid) stays in oauth_accounts.canonical_identity.
CREATE TABLE IF NOT EXISTS identity_profiles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(128) NOT NULL UNIQUE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  profile    JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Only one default profile at any time
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_profiles_default
  ON identity_profiles (is_default) WHERE is_default = TRUE;

-- Seed templates
INSERT INTO identity_profiles (name, is_default, profile) VALUES
  ('macOS arm64 iTerm (default)', TRUE, '{
    "env": {
      "platform": "darwin",
      "platform_raw": "darwin",
      "arch": "arm64",
      "node_version": "v22.1.0",
      "terminal": "iTerm.app",
      "version": "2.1.888",
      "version_base": "2.1.888",
      "package_managers": ["npm", "pnpm"],
      "runtimes": ["node"],
      "is_running_with_bun": false,
      "is_claude_ai_auth": true,
      "build_time": "2026-03-27T00:00:00.000Z",
      "deployment_environment": "production",
      "vcs": "git"
    },
    "prompt_env": {
      "platform": "darwin",
      "shell": "zsh",
      "os_version": "Darwin 24.4.0",
      "home_prefix": "/Users/dev/"
    }
  }'::jsonb),
  ('macOS arm64 Terminal', FALSE, '{
    "env": {
      "platform": "darwin",
      "platform_raw": "darwin",
      "arch": "arm64",
      "node_version": "v20.18.0",
      "terminal": "Apple_Terminal",
      "version": "2.1.888",
      "version_base": "2.1.888",
      "package_managers": ["npm"],
      "runtimes": ["node"],
      "is_running_with_bun": false,
      "is_claude_ai_auth": true,
      "build_time": "2026-03-27T00:00:00.000Z",
      "deployment_environment": "production",
      "vcs": "git"
    },
    "prompt_env": {
      "platform": "darwin",
      "shell": "zsh",
      "os_version": "Darwin 23.6.0",
      "home_prefix": "/Users/alex/"
    }
  }'::jsonb),
  ('macOS arm64 Warp', FALSE, '{
    "env": {
      "platform": "darwin",
      "platform_raw": "darwin",
      "arch": "arm64",
      "node_version": "v22.11.0",
      "terminal": "WarpTerminal",
      "version": "2.1.888",
      "version_base": "2.1.888",
      "package_managers": ["npm", "pnpm", "yarn"],
      "runtimes": ["node", "bun"],
      "is_running_with_bun": false,
      "is_claude_ai_auth": true,
      "build_time": "2026-03-27T00:00:00.000Z",
      "deployment_environment": "production",
      "vcs": "git"
    },
    "prompt_env": {
      "platform": "darwin",
      "shell": "zsh",
      "os_version": "Darwin 24.3.0",
      "home_prefix": "/Users/sam/"
    }
  }'::jsonb),
  ('macOS x64 iTerm', FALSE, '{
    "env": {
      "platform": "darwin",
      "platform_raw": "darwin",
      "arch": "x64",
      "node_version": "v22.12.0",
      "terminal": "iTerm.app",
      "version": "2.1.888",
      "version_base": "2.1.888",
      "package_managers": ["npm", "yarn"],
      "runtimes": ["node"],
      "is_running_with_bun": false,
      "is_claude_ai_auth": true,
      "build_time": "2026-03-27T00:00:00.000Z",
      "deployment_environment": "production",
      "vcs": "git"
    },
    "prompt_env": {
      "platform": "darwin",
      "shell": "zsh",
      "os_version": "Darwin 23.5.0",
      "home_prefix": "/Users/jordan/"
    }
  }'::jsonb),
  ('macOS x64 Warp', FALSE, '{
    "env": {
      "platform": "darwin",
      "platform_raw": "darwin",
      "arch": "x64",
      "node_version": "v20.17.0",
      "terminal": "WarpTerminal",
      "version": "2.1.888",
      "version_base": "2.1.888",
      "package_managers": ["npm", "pnpm"],
      "runtimes": ["node"],
      "is_running_with_bun": false,
      "is_claude_ai_auth": true,
      "build_time": "2026-03-27T00:00:00.000Z",
      "deployment_environment": "production",
      "vcs": "git"
    },
    "prompt_env": {
      "platform": "darwin",
      "shell": "zsh",
      "os_version": "Darwin 23.4.0",
      "home_prefix": "/Users/taylor/"
    }
  }'::jsonb),
  ('Windows x64 pwsh', FALSE, '{
    "env": {
      "platform": "win32",
      "platform_raw": "win32",
      "arch": "x64",
      "node_version": "v20.11.1",
      "terminal": "Windows Terminal",
      "version": "2.1.888",
      "version_base": "2.1.888",
      "package_managers": ["npm"],
      "runtimes": ["node"],
      "is_running_with_bun": false,
      "is_claude_ai_auth": true,
      "build_time": "2026-03-27T00:00:00.000Z",
      "deployment_environment": "production",
      "vcs": "git"
    },
    "prompt_env": {
      "platform": "win32",
      "shell": "pwsh",
      "os_version": "Windows 11 Pro (10.0.22631)",
      "home_prefix": "C:\\Users\\casey\\"
    }
  }'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- Per-account identity: {device_id, email, account_uuid}
-- Filled by "pull from OAuth" button or auto-derivation on first use.
ALTER TABLE oauth_accounts
  ADD COLUMN IF NOT EXISTS canonical_identity  JSONB,
  ADD COLUMN IF NOT EXISTS identity_profile_id UUID REFERENCES identity_profiles(id) ON DELETE SET NULL;

-- Link existing accounts to the default profile
UPDATE oauth_accounts
SET identity_profile_id = (SELECT id FROM identity_profiles WHERE is_default = TRUE LIMIT 1)
WHERE identity_profile_id IS NULL;

COMMIT;
