BEGIN;

-- First, migrate any oauth_accounts still pointing at the four bogus seed rows
-- to NULL so we can DELETE them without violating the FK. We insert the new
-- default below and re-link right after.
UPDATE oauth_accounts
   SET identity_profile_id = NULL
 WHERE identity_profile_id IN (
   SELECT id FROM identity_profiles
    WHERE name IN (
      'macOS arm64 iTerm (default)',
      'macOS arm64 Terminal',
      'macOS arm64 Warp',
      'macOS x64 iTerm',
      'macOS x64 Warp',
      'Windows x64 pwsh'
    )
 );

DELETE FROM identity_profiles
 WHERE name IN (
   'macOS arm64 iTerm (default)',
   'macOS arm64 Terminal',
   'macOS arm64 Warp',
   'macOS x64 iTerm',
   'macOS x64 Warp',
   'Windows x64 pwsh'
 );

INSERT INTO identity_profiles (name, is_default, profile) VALUES
  ('claude-code 2.1.112 macOS arm64 (HAR)', TRUE, '{
    "env": {
      "platform": "darwin",
      "platform_raw": "darwin",
      "arch": "arm64",
      "node_version": "v22.1.0",
      "terminal": "iTerm.app",
      "version": "2.1.112",
      "version_base": "2.1.112",
      "package_managers": ["npm", "yarn", "pnpm"],
      "runtimes": ["node"],
      "is_running_with_bun": false,
      "is_claude_ai_auth": true,
      "build_time": "2026-04-01T22:53:10.000Z",
      "deployment_environment": "unknown-darwin",
      "vcs": "git"
    },
    "prompt_env": {
      "platform": "darwin",
      "shell": "zsh",
      "os_version": "Darwin 24.3.0",
      "home_prefix": "/Users/dev/"
    }
  }'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- Link orphaned accounts to the new default.
UPDATE oauth_accounts
   SET identity_profile_id = (SELECT id FROM identity_profiles WHERE is_default = TRUE LIMIT 1)
 WHERE identity_profile_id IS NULL;

COMMIT;
