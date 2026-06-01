/**
 * Pure identity-rewriting helpers.
 *
 * Responsibilities:
 *   1. Extract sticky session id from inbound `metadata.user_id` (dual-format).
 *   2. Derive a stable session_id per (account, inbound sticky) pair.
 *   3. Build the outbound canonical `metadata.user_id` JSON blob.
 *   4. Merge an OAuthAccount into an EffectiveProfile used by the rewriter.
 */

import { createHash, randomBytes } from 'crypto'
import { getConfig } from './config.js'
import type {
  CanonicalIdentity,
  IdentityProfileEnv,
  IdentityProfilePromptEnv,
  ObservedFingerprint,
  OAuthAccount,
} from './account-pool.js'
import { getDefaultProfile } from './account-pool.js'

export type EffectiveProfile = {
  // Gateway-side OAuthAccount.id (PG UUID). Used as the template cache key so
  // per-row template bindings don't collide when multiple oauth_accounts share
  // the same canonical account_uuid.
  oauth_account_id: string
  cc_template_id: string | null
  identity: CanonicalIdentity
  env: IdentityProfileEnv
  promptEnv: IdentityProfilePromptEnv
  fingerprint: ObservedFingerprint | null
}

/**
 * Extract the sticky session id from an inbound `metadata.user_id` string.
 *
 * Handles both known formats:
 *   - JSON blob: `{"device_id":"…","account_uuid":"…","session_id":"<uuid>"}`
 *   - Flat v2 string: `user_<64hex>_account_<uuid>_session_<uuid>` (also matches the
 *     empty-account variant `_account__session_`).
 *
 * Returns `null` if the input is missing. Returns the original string as a last
 * resort so callers can still use it as an opaque sticky key even if neither
 * format matches.
 */
export function extractStickyId(uid: string | undefined | null): string | null {
  if (!uid) return null

  if (uid.startsWith('{')) {
    try {
      const obj = JSON.parse(uid)
      if (obj && typeof obj.session_id === 'string' && obj.session_id.length > 0) {
        return obj.session_id
      }
    } catch {
      // fall through — treat as opaque
    }
  }

  const m = uid.match(/_session_([0-9a-f-]{8,})/i)
  if (m) return m[1]

  return uid
}

/**
 * Derive a stable UUIDv4-shaped session id from an account + inbound sticky key.
 * Same inputs always produce the same output — so the same end-user session
 * always looks like the same Claude Code session on the canonical account.
 */
export function deriveSessionId(accountId: string, stickyKey: string): string {
  const hex = createHash('sha256').update(`${accountId}:${stickyKey}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Build the outbound canonical `metadata.user_id` JSON blob. */
export function buildCanonicalUserId(identity: CanonicalIdentity, derivedSessionId: string): string {
  return JSON.stringify({
    device_id: identity.device_id,
    account_uuid: identity.account_uuid,
    session_id: derivedSessionId,
  })
}

/** Generate a random 64-hex device id (matches claude-code's `randomBytes(32).hex()`). */
export function generateDeviceId(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Derive a stable placeholder identity when we can't (or haven't yet) fetched
 * the real one from the OAuth profile endpoint.
 *
 * The device id is derived deterministically from the account id so it survives
 * restarts and so log correlation stays meaningful.
 */
export function deriveFallbackIdentity(accountId: string): CanonicalIdentity {
  const hex = createHash('sha256').update(`device:${accountId}`).digest('hex')
  // uuid v4-shape from another slice of the same hash
  const uuidHex = createHash('sha256').update(`uuid:${accountId}`).digest('hex')
  const uuid = `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-4${uuidHex.slice(13, 16)}-${((parseInt(uuidHex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${uuidHex.slice(17, 20)}-${uuidHex.slice(20, 32)}`
  return {
    device_id: hex,
    email: '',
    account_uuid: uuid,
  }
}

function mapPlatform(os: string): string {
  switch (os) {
    case 'MacOS': return 'darwin'
    case 'Windows': return 'win32'
    case 'Linux': return 'linux'
    default: return os.toLowerCase()
  }
}

function versionFromUserAgent(userAgent: string): string {
  const match = userAgent.match(/claude-(?:cli|code)\/([^\s]+)/i)
  return match?.[1] ?? getConfig()?.env?.version ?? '2.1.94'
}

function inferTerminal(platform: string): string {
  switch (platform) {
    case 'win32': return 'Windows Terminal'
    case 'linux': return 'xterm-256color'
    default: return 'iTerm.app'
  }
}

export function buildEffectiveProfile(
  account: OAuthAccount,
  fingerprint: ObservedFingerprint | null,
): EffectiveProfile | null {
  const identity = account.canonicalIdentity ?? deriveFallbackIdentity(account.id)
  // Prefer per-account identity_profile binding, fall back to deployment default.
  const boundProfile = account.identityProfile ?? getDefaultProfile()

  if (!fingerprint) {
    if (!boundProfile) return null
    return {
      oauth_account_id: account.id,
      cc_template_id: account.ccTemplateId,
      identity,
      env: boundProfile.env,
      promptEnv: boundProfile.promptEnv,
      fingerprint: null,
    }
  }

  const platform = mapPlatform(fingerprint.x_stainless_os)
  const version = versionFromUserAgent(fingerprint.user_agent)

  return {
    oauth_account_id: account.id,
    cc_template_id: account.ccTemplateId,
    identity,
    env: {
      platform,
      platform_raw: platform,
      arch: fingerprint.x_stainless_arch,
      node_version: fingerprint.x_stainless_runtime_version,
      terminal: boundProfile?.env.terminal ?? inferTerminal(platform),
      version,
      version_base: version,
      package_managers: boundProfile?.env.package_managers ?? ['npm'],
      runtimes: boundProfile?.env.runtimes ?? [fingerprint.x_stainless_runtime],
      is_running_with_bun: boundProfile?.env.is_running_with_bun ?? false,
      is_claude_ai_auth: boundProfile?.env.is_claude_ai_auth ?? true,
      build_time: boundProfile?.env.build_time,
      deployment_environment: boundProfile?.env.deployment_environment,
      vcs: boundProfile?.env.vcs,
    },
    promptEnv: {
      platform: fingerprint.prompt_platform || boundProfile?.promptEnv.platform || platform,
      shell: fingerprint.prompt_shell || boundProfile?.promptEnv.shell || 'zsh',
      os_version: fingerprint.prompt_os_version || boundProfile?.promptEnv.os_version || '',
      home_prefix: fingerprint.prompt_home_prefix || boundProfile?.promptEnv.home_prefix || '/Users/dev/',
    },
    fingerprint,
  }
}
