import { query, DEPLOYMENT } from './db.js'
import { getRedis, isRedisAvailable } from './redis.js'
import { log } from './logger.js'
import { request as httpsRequest } from 'https'
import { getProxyAgentForProxyId, markProxyFailure, markProxySuccess } from './proxy-agent.js'
import { hydrateVersionLocks } from './rewriter.js'
import { onSlotEvent, hydrateFromRows, type SlotEvent } from './session-slots.js'
import { assertAccountTemplatesPresent, hasTemplateInRedis, syncTemplatesToRedis } from './cc-disguise.js'
import { getClientGroupId, getGroupMultiplier } from './sync.js'
import { decodeOptions, type AccountOptions } from './features/options.js'
import { isAccountPoolPollMode } from './config.js'

// Types
export type CanonicalIdentity = {
  device_id: string       // 64 hex chars, per-account
  email: string           // real from OAuth profile
  account_uuid: string    // real from OAuth profile
}

export type IdentityProfileEnv = {
  platform: string
  platform_raw?: string
  arch: string
  node_version: string
  terminal: string
  version: string
  version_base?: string
  package_managers?: string[]
  runtimes?: string[]
  is_running_with_bun?: boolean
  is_claude_ai_auth?: boolean
  build_time?: string
  deployment_environment?: string
  vcs?: string
}

export type IdentityProfilePromptEnv = {
  platform: string
  shell: string
  os_version: string
  home_prefix: string   // e.g. "/Users/dev/"
}

export type IdentityProfile = {
  id: string
  name: string
  isDefault: boolean
  env: IdentityProfileEnv
  promptEnv: IdentityProfilePromptEnv
}

export type ObservedFingerprint = {
  user_agent: string
  x_app: string
  x_stainless_lang: string
  x_stainless_runtime: string
  x_stainless_runtime_version: string
  x_stainless_os: string
  x_stainless_arch: string
  x_stainless_package_version: string
  prompt_platform?: string
  prompt_shell?: string
  prompt_os_version?: string
  prompt_home_prefix?: string
}

interface AccountCommon {
  id: string
  name: string
  status: string
  accountType: string
  maxRpm: number
  maxTpm: number
  maxConcurrent: number
  maxSessions: number
  maxDailyReq: number
  maxDailyTok: number
  maxDailyCost: number
  weight: number
  models: string[] | null
  cooldownSeconds: number
  maxRetries: number
  sessionTtlSeconds: number  // 0 = use global default
  outboundProxyId: string | null
  canonicalIdentity: CanonicalIdentity | null   // filled via pull-from-oauth or auto-derivation
  identityProfile: IdentityProfile | null        // resolved from identity_profile_id
  groupId: string | null                          // legacy single-group column (first group or NULL)
  groupIds: string[]                              // all groups this account belongs to (M:N); empty = shared pool
  authKind: 'oauth' | 'api_key'
  simulateFingerprint: boolean
  organizationUuid: string | null  // from /api/oauth/profile; used in synthetic event_logging auth block
  accountUuidCol: string | null    // first-class mirror of canonical_identity->>'account_uuid'
  ccTemplateId: string | null      // cc_disguise_templates.id — OAuth accounts without a bound template are refused at select time
  options: AccountOptions
}

export type OAuthAccountVariant = AccountCommon & {
  authKind: 'oauth'
  refreshToken: string | null
  accessToken: string | null
  expiresAt: number
}

export type ApiKeyAccountVariant = AccountCommon & {
  authKind: 'api_key'
  provider: 'anthropic' | 'openai'
  apiKey: string
  apiBaseUrl: string
}

export type Account = OAuthAccountVariant | ApiKeyAccountVariant
// 兼容老引用名(逐步替换;Phase 4 末删除别名)
export type OAuthAccount = Account

export type AccountSelection = {
  account: OAuthAccount
  isOverflow: boolean  // true = temporary, don't change binding
  /**
   * The group actually used to serve this request. Drives the cost multiplier.
   * - client.group_id set: equals that group (or null when the account is shared-pool)
   * - client.group_id NULL (auto): equals the lowest-multiplier group among the
   *   account's groupIds (null when the account is shared-pool)
   */
  selectedGroupId: string | null
}

type CooldownState = {
  reason: string
  errors: number
  startedAt: number
  until: number
}

type SessionBinding = {
  accountId: string
  boundAt: number
  overflowCount: number
}

type AccountFailureAssessment = {
  message: string
  action: 'ignore' | 'cooldown' | 'error' | 'disabled'
}

// ── Model-tier compatibility ──

// Models that NO account can serve — block at gateway before touching any account
const UNSUPPORTED_MODEL_PATTERNS: RegExp[] = [
]

/** Returns a human-readable reason if the model is unsupported, or null if OK */
export function getUnsupportedModelReason(model: string | null): string | null {
  if (!model) return null
  for (const pattern of UNSUPPORTED_MODEL_PATTERNS) {
    if (pattern.test(model)) return `Model "${model}" is not supported by any account in the pool`
  }
  return null
}

// Models that require a Max subscription (Pro accounts cannot use these)
const MAX_ONLY_MODEL_PATTERNS: RegExp[] = [
  /opus/i,  // All Opus models
]

export function isModelAllowedForAccountType(_model: string | null, _accountType: string): boolean {
  // Tier check removed per user request. account_type is now purely informational
  // (real claude.ai subscription tier: pro/max5/max20/free/default_raven) and
  // does NOT gate model access. All accounts can use all models.
  // This change has zero impact on outbound requests to Anthropic — account_type
  // is never serialized to upstream headers or body.
  return true
}

// In-memory account cache (synced from PG every 30s)
let accounts: OAuthAccount[] = []
// Used only as a deterministic tie-breaker when two accounts score identically
// (e.g. cold start, both at 0/0 util). Prevents thundering to the same account
// on exact ties. Rotates per tier hit.
let lbPointer = 0
let poolConfigured = false
let defaultProfile: IdentityProfile | null = null
const inFlightTokenRefreshes = new Map<string, Promise<boolean>>()

export async function loadDefaultProfile(): Promise<void> {
  try {
    const result = await query(
      `SELECT id, name, is_default, profile FROM identity_profiles WHERE is_default = TRUE LIMIT 1`,
    )
    if (result.rows.length > 0) {
      const r = result.rows[0]
      const body = typeof r.profile === 'string' ? JSON.parse(r.profile) : r.profile
      defaultProfile = {
        id: r.id,
        name: r.name,
        isDefault: true,
        env: body.env,
        promptEnv: body.prompt_env,
      }
      log('debug', `account-pool: default identity profile loaded: ${r.name}`)
    }
  } catch (err) {
    log('debug', `account-pool: loadDefaultProfile failed: ${err}`)
  }
}

export function getDefaultProfile(): IdentityProfile | null {
  return defaultProfile
}

// Session TTL (seconds) — loaded from system_settings, default 24h
let sessionTtl = 86400

async function loadSessionTtl(): Promise<void> {
  try {
    const result = await query("SELECT value FROM system_settings WHERE key = 'session_ttl_seconds'")
    if (result.rows.length > 0) {
      const val = parseInt(result.rows[0].value)
      if (val > 0) sessionTtl = val
    }
  } catch {}
}

export function getSessionTtl(): number {
  return sessionTtl
}
let poolEnabled = false

// ── Sync from PG ──

export async function syncAccounts(): Promise<void> {
  try {
    const result = await query(
      `SELECT oa.id, oa.name, oa.refresh_token, oa.access_token, oa.expires_at, oa.status, oa.account_type,
              oa.max_rpm, oa.max_tpm, oa.max_concurrent, oa.max_sessions,
              oa.max_daily_req, oa.max_daily_tok, oa.max_daily_cost,
              oa.weight, oa.models, oa.cooldown_seconds, oa.max_retries,
              COALESCE(oa.session_ttl_seconds, 0) AS session_ttl_seconds,
              oa.outbound_proxy_id,
              oa.options,
              oa.canonical_identity,
              oa.auth_kind, oa.provider, oa.api_key, oa.api_base_url,
              COALESCE(oa.simulate_fingerprint, TRUE) AS simulate_fingerprint,
              oa.organization_uuid, oa.account_uuid,
              oa.cc_template_id,
              oa.group_id,
              COALESCE(
                (SELECT array_agg(oag.group_id ORDER BY oag.created_at)
                   FROM oauth_account_groups oag
                  WHERE oag.account_id = oa.id),
                ARRAY[]::uuid[]
              ) AS group_ids,
              ip.id AS profile_id, ip.name AS profile_name,
              ip.is_default AS profile_is_default, ip.profile AS profile_body
       FROM oauth_accounts oa
       LEFT JOIN identity_profiles ip ON ip.id = oa.identity_profile_id
       WHERE oa.status != 'disabled' AND oa.deployment = $1
       ORDER BY oa.weight DESC, oa.created_at`,
      [DEPLOYMENT]
    )
    accounts = result.rows.map((r: any) => {
      let profile: IdentityProfile | null = null
      if (r.profile_id && r.profile_body) {
        const body = typeof r.profile_body === 'string' ? JSON.parse(r.profile_body) : r.profile_body
        profile = {
          id: r.profile_id,
          name: r.profile_name,
          isDefault: !!r.profile_is_default,
          env: body.env,
          promptEnv: body.prompt_env,
        }
      }
      let canonicalIdentity: CanonicalIdentity | null = null
      if (r.canonical_identity) {
        const ci = typeof r.canonical_identity === 'string' ? JSON.parse(r.canonical_identity) : r.canonical_identity
        if (ci && ci.device_id) canonicalIdentity = ci
      }
      // Prefer the M:N list; fall back to the legacy single group_id column so
      // accounts without any oauth_account_groups row (migrated but never
      // re-saved) still report a non-empty groupIds when they have a legacy
      // binding. An empty array means "shared pool".
      const mnGroupIds: string[] = Array.isArray(r.group_ids)
        ? r.group_ids.filter((g: any) => typeof g === 'string' && g.length > 0)
        : []
      const legacyGroupId: string | null = r.group_id ?? null
      const groupIds: string[] = mnGroupIds.length > 0
        ? mnGroupIds
        : (legacyGroupId ? [legacyGroupId] : [])
      const authKind = (r.auth_kind ?? 'oauth') as 'oauth' | 'api_key'
      const common: AccountCommon = {
        id: r.id,
        name: r.name,
        status: r.status,
        accountType: r.account_type,
        maxRpm: r.max_rpm,
        maxTpm: r.max_tpm,
        maxConcurrent: r.max_concurrent,
        maxSessions: r.max_sessions,
        maxDailyReq: r.max_daily_req,
        maxDailyTok: Number(r.max_daily_tok ?? 0),
        maxDailyCost: parseFloat(r.max_daily_cost ?? 0),
        weight: r.weight,
        models: r.models,
        cooldownSeconds: r.cooldown_seconds,
        maxRetries: r.max_retries,
        sessionTtlSeconds: Number(r.session_ttl_seconds ?? 0),
        outboundProxyId: r.outbound_proxy_id ?? null,
        canonicalIdentity,
        identityProfile: profile,
        groupId: legacyGroupId ?? (mnGroupIds[0] ?? null),
        groupIds,
        authKind,
        simulateFingerprint: r.simulate_fingerprint !== false,
        organizationUuid: r.organization_uuid ?? null,
        accountUuidCol: r.account_uuid ?? null,
        ccTemplateId: r.cc_template_id ?? null,
        options: decodeOptions(r.options, authKind),
      }
      if (authKind === 'oauth') {
        return {
          ...common,
          authKind: 'oauth',
          refreshToken: r.refresh_token,
          accessToken: r.access_token,
          expiresAt: Number(r.expires_at ?? 0),
        } satisfies OAuthAccountVariant
      }
      return {
        ...common,
        authKind: 'api_key',
        provider: (r.provider ?? 'anthropic') as 'anthropic' | 'openai',
        apiKey: r.api_key ?? '',
        apiBaseUrl: r.api_base_url ?? '',
      } satisfies ApiKeyAccountVariant
    })
    log('debug', `account-pool: synced ${accounts.length} accounts`)
  } catch (err) {
    log('debug', `account-pool: sync failed (table may not exist yet): ${err}`)
  }
}

export function getAccounts(): OAuthAccount[] {
  return accounts
}

export function isPoolEnabled(): boolean {
  return poolEnabled && accounts.length > 0
}

/**
 * 心跳类请求专用 peek:不占 slot,不消费 concurrent,不刷 redis,只判定"号池
 * 是否还有任何 active 且未冷却的账号"。读 redis 的 cooldown:* key 是只读。
 *
 * 与 selectAccount 的差异:
 *   - selectAccount 会触发 session-slot 分配、ensureValidToken (含 OAuth refresh
 *     的副作用)、并发计数器递增 — 不能复用,会污染心跳健康面。
 *   - 这里 status==='active' && 无 cooldown 即够;模型/分组/token 维度都不检查,
 *     "号池有命可用"是 boolean 概念。
 *
 * 用途:proxy.ts 在收到客户端心跳探测时不打上游,直接 200 回 OK 节省 quota。
 */
export async function hasAnyReadyAccount(): Promise<boolean> {
  if (!poolEnabled || accounts.length === 0) return false
  if (!isRedisAvailable()) {
    return accounts.some(a => a.status === 'active')
  }
  const redis = getRedis()
  for (const account of accounts) {
    if (account.status !== 'active') continue
    const cd = await redis.get(`cooldown:${account.id}`)
    if (!cd) return true
  }
  return false
}

export function isPoolConfigured(): boolean {
  return poolConfigured
}

function assessFailureReason(reason?: string | null): AccountFailureAssessment {
  const text = formatFailureReason(reason)
  const normalized = text.toLowerCase()

  if (normalized.includes('organization has been disabled') || normalized.includes('organization disabled')) {
    return {
      message: 'Anthropic returned 400: This organization has been disabled. The account has been disabled automatically.',
      action: 'disabled',
    }
  }

  if (normalized.includes('refresh token not found or invalid') || normalized.includes('invalid_grant')) {
    return {
      message: 'OAuth refresh token is invalid or expired. The account has been marked as error.',
      action: 'error',
    }
  }

  // Gateway-side rejections are caused by the inbound client, not by account
  // health. The account never made any upstream request; do not penalize it.
  if (
    reason === 'non_cc_request'
    || reason === 'no_template_bound'
    || reason === 'body_validation_failed'
    || reason === 'non_stream_blocked'
  ) {
    return {
      message: text,
      action: 'ignore',
    }
  }

  // 上游 4xx (除 429) 一律视为客户端请求体问题,不算账号健康失败。
  //
  // 历史 bug:这里之前查 'upstream returned 400',但 extractUpstreamFailureReason
  // 实际产生的是 'upstream_status_400: ...' 前缀,从未命中 → 所有 400 错误
  // (image too big / cache_control too many / tool_use ids missing 等) 都走
  // 默认 cooldown,池里仅剩的账号 3 次失败就进 60s cooldown,客户端没账号可用。
  //
  // 现在改成 includes('400') 兜底所有 400 文案。429 仍走 cooldown(rate limit 真问题);
  // organization disabled / invalid_grant 已在前面单独处理为 disabled/error。
  // 其他 4xx (403 OAuth permission / 413 payload too large / 422 等) 也算客户端错。
  if (
    normalized.includes('upstream_status_400')
    || normalized.includes('upstream_status_403')
    || normalized.includes('upstream_status_404')
    || normalized.includes('upstream_status_413')
    || normalized.includes('upstream_status_422')
    || normalized.includes('upstream returned 400')
    || normalized.includes('anthropic returned 400')
  ) {
    return {
      message: text,
      action: 'ignore',
    }
  }

  return {
    message: text,
    action: 'cooldown',
  }
}

async function migrateSessionsToAvailableAccount(accountId: string): Promise<{ migrated: number; targetName: string | null }> {
  if (!isRedisAvailable()) return { migrated: 0, targetName: null }

  // Preserve group isolation: migrate to an account in the same group as the
  // failing one (or to the shared pool when it is unbound). For auto-mode
  // clients (no single group), pass null so the picker considers everything.
  const failing = accounts.find((a) => a.id === accountId)
  const picked = await pickBestAccount(null, [accountId], failing?.groupId ?? null)
  if (!picked) return { migrated: 0, targetName: null }
  const target = picked.account

  const redis = getRedis()
  const sessionKeys = await redis.smembers(`sessions:${accountId}`)
  if (sessionKeys.length === 0) return { migrated: 0, targetName: target.name }

  let migrated = 0
  for (const sessionKey of sessionKeys) {
    const [raw, ttl] = await Promise.all([
      redis.get(sessionKey),
      redis.ttl(sessionKey),
    ])

    if (!raw) {
      await redis.srem(`sessions:${accountId}`, sessionKey)
      continue
    }

    let binding: any
    try {
      binding = JSON.parse(raw)
    } catch {
      binding = { accountId: target.id, overflowCount: 0 }
    }

    binding.accountId = target.id
    binding.overflowCount = 0
    binding.migratedAt = Date.now()
    binding.migratedFrom = accountId

    const targetTtl = target.sessionTtlSeconds > 0 ? target.sessionTtlSeconds : sessionTtl
    const effectiveTtl = ttl && ttl > 0 ? ttl : targetTtl

    await Promise.all([
      redis.set(sessionKey, JSON.stringify(binding), 'EX', effectiveTtl),
      redis.sadd(`sessions:${target.id}`, sessionKey),
      redis.expire(`sessions:${target.id}`, Math.max(targetTtl, effectiveTtl)),
      redis.srem(`sessions:${accountId}`, sessionKey),
    ])
    migrated += 1
  }

  return { migrated, targetName: target.name }
}

export async function markAccountUnavailable(
  account: Account,
  status: 'error' | 'disabled',
  reason: string,
): Promise<void> {
  account.status = status
  if (account.authKind === 'oauth') {
    account.accessToken = null
    account.expiresAt = 0
  }

  await query(
    `UPDATE oauth_accounts
        SET status = $1,
            health_status = 'failed',
            access_token = NULL,
            expires_at = 0,
            last_error = $2,
            updated_at = now()
      WHERE id = $3 AND deployment = $4`,
    [status, reason.slice(0, 500), account.id, DEPLOYMENT],
  )

  if (isRedisAvailable()) {
    const redis = getRedis()
    await Promise.all([
      redis.del(`cooldown:${account.id}`),
      redis.del(`errors:${account.id}`),
      redis.del(`concurrent:${account.id}`),
      redis.del(`rpm:${account.id}`),
      redis.del(`tpm:${account.id}`),
    ]).catch(() => {})
  }

  const migration = await migrateSessionsToAvailableAccount(account.id)
  if (migration.migrated > 0 && migration.targetName) {
    log('warn', `account-pool: migrated ${migration.migrated} session(s) from "${account.name}" to "${migration.targetName}"`)
  } else if (!migration.targetName) {
    log('warn', `account-pool: no alternative account available to migrate sessions from "${account.name}"`)
  }
}

// ── Token management ──

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const SCOPES = ['user:inference', 'user:profile', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload']

export async function refreshAccountToken(account: Account, forceServerRefresh: boolean = false): Promise<boolean> {
  // 用 process.stderr.write 强制 sync 写,排除 console.log buffer 问题导致 log 丢失
  process.stderr.write(`[REFRESH-ENTRY] pid=${process.pid} name=${account.name} stack=${new Error().stack?.split('\n').slice(1, 5).join(' <- ')}\n`)
  if (account.authKind !== 'oauth') return false

  // P0 兜底:**永远先 reload db,不依赖 redis** — pg 是 source of truth。
  // 之前 race 失败的根因:fix 全在 if(isRedisAvailable()) 块里,ioredis 客户端
  // 短暂 reconnecting 那一瞬 status !== 'ready' → fix 整段跳过 → 用 in-memory
  // stale account.refreshToken 走 HTTP refresh → Anthropic 拒 invalid_grant。
  //
  // 现在入口立即 reload db:
  //   1. sync in-memory 到 db 最新 token (覆盖 stale snapshot)
  //   2. 如果 db.access_token 仍有效(被别的 process / 上次 refresh 刚写新)
  //      直接 return true,绝不消费 refresh_token
  // 后续 redis 锁仅作为多 process 并发优化(挡同时跑),不是必需。
  log('info', `[P0-enter] "${account.name}" inMem.expiresIn=${Math.floor((account.expiresAt - Date.now())/1000)}s`)
  try {
    const fresh = await query<{ access_token: string; refresh_token: string; expires_at: string }>(
      `SELECT access_token, refresh_token, expires_at FROM oauth_accounts WHERE id = $1 AND deployment = $2`,
      [account.id, DEPLOYMENT],
    )
    log('info', `[P0-after-query] "${account.name}" rowCount=${fresh.rowCount}`)
    if ((fresh.rowCount ?? 0) > 0) {
      const dbAccess = fresh.rows[0].access_token
      const dbRefresh = fresh.rows[0].refresh_token
      const dbExpiresAt = parseInt(fresh.rows[0].expires_at, 10)
      const dbExpiresIn = Math.floor((dbExpiresAt - Date.now()) / 1000)
      log('info', `[P0-check] "${account.name}" db.access_len=${(dbAccess||'').length} db.expiresIn=${dbExpiresIn}s 5min_threshold=${dbExpiresAt > Date.now() + 5 * 60 * 1000}`)
      // 永远 sync in-memory(包括 caller 持有的 stale 引用)
      account.accessToken = dbAccess
      account.refreshToken = dbRefresh
      account.expiresAt = dbExpiresAt
      if (dbAccess && dbExpiresAt > Date.now() + 5 * 60 * 1000) {
        if (forceServerRefresh) {
          log('info', `account-pool: forceServerRefresh=true, bypassing P0-entry skip for "${account.name}" — will hit refresh endpoint`)
        } else {
          log('info', `account-pool: skipped refresh for "${account.name}" — db token still valid (P0 entry check)`)
          return true
        }
      }
      log('info', `[P0-fall-through] "${account.name}" — db token also expired or near expiry, proceeding to lock/refresh`)
    }
  } catch (err) {
    log('error', `[P0-catch] db reload at entry failed for "${account.name}": ${err} — proceeding with in-memory token`)
  }

  // 跨进程分布式锁:防止多个 gateway 实例(部署期间孤儿 + 新进程并存 / 多 worker)
  // 同时 refresh 同一账号 — refresh token 是 single-use,Anthropic 端处理一次后旧
  // token 立即失效,第二个并发 refresh 会拿到 invalid_grant 误标账号为 error。
  // 进程内 inFlightTokenRefreshes Map 已挡了同进程并发,这里挡跨进程 race。
  const lockKey = `refresh_lock:${account.id}`
  if (isRedisAvailable()) {
    const redis = getRedis()
    const acquired = await redis.set(lockKey, String(process.pid), 'EX', 30, 'NX')
    if (!acquired) {
      // 别的进程在 refresh — 短暂 polling 等待它完成,然后从 db reload 新 token
      log('debug', `account-pool: refresh lock held by another process for "${account.name}", waiting`)
      const start = Date.now()
      while (Date.now() - start < 15_000) {
        await new Promise(r => setTimeout(r, 500))
        if ((await redis.exists(lockKey)) === 0) break
      }
      const fresh = await query<{ access_token: string; refresh_token: string; expires_at: string }>(
        `SELECT access_token, refresh_token, expires_at FROM oauth_accounts WHERE id = $1 AND deployment = $2`,
        [account.id, DEPLOYMENT],
      )
      if ((fresh.rowCount ?? 0) > 0 && fresh.rows[0].access_token) {
        account.accessToken = fresh.rows[0].access_token
        account.refreshToken = fresh.rows[0].refresh_token
        account.expiresAt = parseInt(fresh.rows[0].expires_at, 10)
        log('info', `account-pool: reloaded token for "${account.name}" after waiting on lock`)
        return true
      }
      log('warn', `account-pool: lock wait timed out for "${account.name}", db has no fresh token`)
      return false
    }

    // 抢到锁。先从 db reload 最新 refresh_token + access_token —
    // 防止 caller 持有 stale account 对象(refreshToken 已被其他进程 refresh 过 single-use)。
    // 如果 db 里的 access_token 还有效,直接复用,不再消费 refresh_token。
    const fresh = await query<{ access_token: string; refresh_token: string; expires_at: string }>(
      `SELECT access_token, refresh_token, expires_at FROM oauth_accounts WHERE id = $1 AND deployment = $2`,
      [account.id, DEPLOYMENT],
    )
    log('info', `[refresh-trace] acquired lock for "${account.name}", db reload rowCount=${fresh.rowCount}`)
    if ((fresh.rowCount ?? 0) > 0) {
      const dbAccess = fresh.rows[0].access_token
      const dbRefresh = fresh.rows[0].refresh_token
      const dbExpiresAt = parseInt(fresh.rows[0].expires_at, 10)
      const validForSec = Math.floor((dbExpiresAt - Date.now()) / 1000)
      const inMemRefreshChanged = account.refreshToken !== dbRefresh
      log('info', `[refresh-trace] "${account.name}" db.access_len=${(dbAccess||'').length} db.expiresIn=${validForSec}s inMemRefreshChanged=${inMemRefreshChanged}`)
      // sync in-memory 到 db 最新值
      account.accessToken = dbAccess
      account.refreshToken = dbRefresh
      account.expiresAt = dbExpiresAt
      // 如果 db access_token 还有 5 分钟以上有效期,跳过 refresh 直接复用
      if (dbAccess && dbExpiresAt > Date.now() + 5 * 60 * 1000) {
        if (forceServerRefresh) {
          log('info', `account-pool: forceServerRefresh=true, bypassing post-lock skip for "${account.name}"`)
        } else {
          log('info', `account-pool: skipped refresh for "${account.name}" — db token still valid`)
          await getRedis().del(lockKey).catch(() => {})
          return true
        }
      }
    }
  } else {
    log('info', `[refresh-trace] redis unavailable for "${account.name}", proceeding without lock`)
  }

  try {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: account.refreshToken,
      client_id: CLIENT_ID,
      scope: SCOPES.join(' '),
    })

    const url = new URL(TOKEN_URL)
    const selection = getProxyAgentForProxyId(account.outboundProxyId)
    if (selection.required && !selection.agent) {
      log('error', `account-pool: outbound proxy unavailable while refreshing "${account.name}"`)
      if (isRedisAvailable()) await getRedis().del(lockKey).catch(() => {})
      return false
    }

    const result = await new Promise<boolean>((resolve) => {
      const req = httpsRequest(
        {
          hostname: url.hostname,
          port: 443,
          path: url.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
          ...(selection.agent && { agent: selection.agent as any }),
        },
        (res) => {
          let data = ''
          res.on('data', (chunk: Buffer) => { data += chunk.toString() })
          res.on('end', async () => {
            log('info', `[refresh-resp] "${account.name}" http_status=${res.statusCode} body_len=${data.length} body_preview=${data.slice(0, 200)}`)
            if (res.statusCode === 407) {
              markProxyFailure(selection, 'proxy_auth_failed: HTTP 407').catch(() => {})
            } else {
              markProxySuccess(selection).catch(() => {})
            }
            try {
              const json = JSON.parse(data)
              if (json.access_token) {
                account.accessToken = json.access_token
                account.expiresAt = Date.now() + (json.expires_in ?? 3600) * 1000
                const newRefresh = json.refresh_token ?? account.refreshToken
                account.refreshToken = newRefresh

                // Persist to DB. 对齐 server admin /refresh 行为:成功 refresh 意味着账号本质可用,
                // 同步重置 status='active' + last_error=NULL,避免 stale snapshot race 误标后
                // token 实际能用但 status 卡 error 需要运维干预。
                await query(
                  `UPDATE oauth_accounts SET access_token = $1, expires_at = $2, refresh_token = $3,
                   health_status = 'healthy', status = 'active', last_error = NULL, updated_at = now()
                   WHERE id = $4 AND deployment = $5`,
                  [account.accessToken, account.expiresAt, newRefresh, account.id, DEPLOYMENT]
                )
                log('info', `account-pool: refreshed token for "${account.name}"`)
                resolve(true)
              } else {
                const assessment = assessFailureReason(data)
                log('error', `account-pool: token refresh failed for "${account.name}": ${assessment.message}`)
                if (assessment.action === 'cooldown' || assessment.action === 'ignore') {
                  await query(
                    `UPDATE oauth_accounts SET health_status = 'failed', last_error = $1, updated_at = now() WHERE id = $2 AND deployment = $3`,
                    [assessment.message.slice(0, 500), account.id, DEPLOYMENT],
                  )
                } else {
                  await markAccountUnavailable(account, assessment.action, assessment.message)
                }
                resolve(false)
              }
            } catch (err) {
              log('error', `account-pool: token parse error for "${account.name}": ${err}`)
              resolve(false)
            }
          })
        },
      )
      req.on('error', (err) => {
        markProxyFailure(selection, `account_refresh:${account.name}: ${err.message}`).catch(() => {})
        log('error', `account-pool: token request error for "${account.name}": ${err.message}`)
        resolve(false)
      })
      req.write(body)
      req.end()
    })
    if (isRedisAvailable()) await getRedis().del(lockKey).catch(() => {})
    return result
  } catch (err) {
    log('error', `account-pool: refreshAccountToken error: ${err}`)
    if (isRedisAvailable()) await getRedis().del(lockKey).catch(() => {})
    return false
  }
}

export async function ensureValidToken(account: OAuthAccount): Promise<boolean> {
  // Migration mode: when SKIP_BOOT_REFRESH=1, never call refresh API — just
  // accept whatever's in DB. This prevents rotating refresh_tokens during
  // data sync from old server.
  if (process.env.SKIP_BOOT_REFRESH === '1') {
    if (account.authKind === 'api_key') return Boolean(account.apiKey)
    return Boolean(account.accessToken)
  }
  // api_key 账号没有 OAuth refresh 流程，凭 apiKey 字段判活
  if (account.authKind === 'api_key') {
    return Boolean(account.apiKey)
  }

  const now = Date.now()
  const fiveMin = 5 * 60 * 1000
  if (account.accessToken && account.expiresAt > now + fiveMin) {
    return true // token still valid
  }

  const inFlight = inFlightTokenRefreshes.get(account.id)
  if (inFlight) {
    log('debug', `account-pool: waiting for in-flight token refresh for "${account.name}"`)
    return inFlight
  }

  const refreshPromise = refreshAccountToken(account)
    .finally(() => {
      const current = inFlightTokenRefreshes.get(account.id)
      if (current === refreshPromise) {
        inFlightTokenRefreshes.delete(account.id)
      }
    })

  inFlightTokenRefreshes.set(account.id, refreshPromise)
  return refreshPromise
}

// ── Account selection with sticky sessions ──

/**
 * Group-eligibility gate. 严格隔离语义：
 *
 *  - clientGroupId === null (auto / 未绑组) → 所有账号都可选；账号拣选时仍按
 *    resolveEffectiveGroup 选最便宜的组算计费。
 *  - clientGroupId !== null (已绑组) → 仅接受 groupIds 显式包含该组的账号。
 *    共享池账号（groupIds 空）一律不参与 —— 这条规则保证客户端绑哪个组就只
 *    用那个组的账号，不会被共享池里其它账号"漏接"。
 */
function isAccountInGroup(account: OAuthAccount, clientGroupId: string | null): boolean {
  if (clientGroupId === null) return true
  if (!account.groupIds || account.groupIds.length === 0) return false
  return account.groupIds.includes(clientGroupId)
}

/**
 * For a candidate account, pick the group whose multiplier will be charged
 * (and therefore matters for ordering). Rules:
 *  - Shared-pool account (groupIds empty) → null, multiplier 1.0.
 *  - Bound client (clientGroupId set) and account belongs to that group →
 *    that group (bound semantics).
 *  - Otherwise (auto mode, or shared account in bound mode) → the group in
 *    groupIds with the smallest cost_multiplier wins. Ties break on the first
 *    occurrence (stable array order from sync).
 *
 * Returns { groupId, multiplier }. Never throws.
 */
export function resolveEffectiveGroup(
  account: OAuthAccount,
  clientGroupId: string | null,
): { groupId: string | null; multiplier: number } {
  if (!account.groupIds || account.groupIds.length === 0) {
    return { groupId: null, multiplier: 1 }
  }
  if (clientGroupId !== null && account.groupIds.includes(clientGroupId)) {
    return { groupId: clientGroupId, multiplier: getGroupMultiplier(clientGroupId) }
  }
  // auto / fallback: pick the cheapest group the account actually belongs to
  let bestId: string | null = null
  let bestMul = Number.POSITIVE_INFINITY
  for (const gid of account.groupIds) {
    const m = getGroupMultiplier(gid)
    if (m < bestMul) {
      bestMul = m
      bestId = gid
    }
  }
  if (bestId === null) return { groupId: null, multiplier: 1 }
  return { groupId: bestId, multiplier: bestMul }
}

async function readBinding(redis: ReturnType<typeof getRedis>, bindingKey: string): Promise<SessionBinding | null> {
  const raw = await redis.get(bindingKey)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.accountId === 'string') {
      return {
        accountId: parsed.accountId,
        boundAt: Number(parsed.boundAt) || Date.now(),
        overflowCount: Number(parsed.overflowCount) || 0,
      }
    }
  } catch {}
  return null
}

async function writeBinding(
  redis: ReturnType<typeof getRedis>,
  bindingKey: string,
  binding: SessionBinding,
  ttl: number,
): Promise<void> {
  await redis.set(bindingKey, JSON.stringify(binding), 'EX', ttl)
}

async function createBinding(
  redis: ReturnType<typeof getRedis>,
  bindingKey: string,
  account: OAuthAccount,
): Promise<SessionBinding> {
  const ttl = account.sessionTtlSeconds > 0 ? account.sessionTtlSeconds : sessionTtl
  const binding: SessionBinding = {
    accountId: account.id,
    boundAt: Date.now(),
    overflowCount: 0,
  }
  await writeBinding(redis, bindingKey, binding, ttl)
  await redis.sadd(`sessions:${account.id}`, bindingKey)
  await redis.expire(`sessions:${account.id}`, ttl)
  return binding
}

async function moveBindingToAccount(
  redis: ReturnType<typeof getRedis>,
  bindingKey: string,
  binding: SessionBinding,
  fromAccountId: string | null,
  targetAccount: OAuthAccount,
): Promise<void> {
  const ttl = targetAccount.sessionTtlSeconds > 0 ? targetAccount.sessionTtlSeconds : sessionTtl
  binding.accountId = targetAccount.id
  binding.boundAt = Date.now()
  binding.overflowCount = 0
  await writeBinding(redis, bindingKey, binding, ttl)
  await redis.sadd(`sessions:${targetAccount.id}`, bindingKey)
  await redis.expire(`sessions:${targetAccount.id}`, ttl)
  if (fromAccountId && fromAccountId !== targetAccount.id) {
    await redis.srem(`sessions:${fromAccountId}`, bindingKey)
  }
}

export async function selectAccount(
  sessionId: string | null,
  clientId: string | null,
  model: string | null,
): Promise<AccountSelection | null> {
  const clientGroupId = getClientGroupId(clientId)

  if (!isRedisAvailable()) {
    // Fallback: simple round-robin without sticky sessions
    return pickBestAccountNoRedis(model, clientGroupId)
  }

  const redis = getRedis()
  const bindingKey = sessionId ? `sess:${sessionId}` : clientId ? `sess:client:${clientId}` : null
  log('info', `sticky.select start key=${bindingKey ?? '-'} session=${sessionId ?? '-'} client=${clientId ?? '-'} model=${model ?? '-'} client_group=${clientGroupId ?? '-'} local_accounts=${accounts.length}`)

  // 1. Check existing binding
  if (bindingKey) {
    const binding = await readBinding(redis, bindingKey)
    if (binding) {
      log('info', `sticky.binding found key=${bindingKey} account=${binding.accountId} overflow=${binding.overflowCount}`)
      const account = accounts.find(a => a.id === binding.accountId)

      if (account) {
        const ttl = account.sessionTtlSeconds > 0 ? account.sessionTtlSeconds : sessionTtl

        if (!isAccountInGroup(account, clientGroupId)) {
          const picked = await pickBestAccount(model, [account.id], clientGroupId)
          if (!picked) return null
          log('warn', `sticky.binding migrate group_mismatch key=${bindingKey} from=${account.id} to=${picked.account.id} client_group=${clientGroupId ?? '-'}`)
          await moveBindingToAccount(redis, bindingKey, binding, account.id, picked.account)
          return { account: picked.account, isOverflow: false, selectedGroupId: picked.selectedGroupId }
        }

        if (!isModelAllowedForAccountType(model, account.accountType)) {
          const picked = await pickBestAccount(model, [account.id], clientGroupId)
          if (!picked) return null
          log('warn', `sticky.binding overflow model_not_allowed key=${bindingKey} bound=${account.id} picked=${picked.account.id} model=${model ?? '-'} account_type=${account.accountType}`)
          await redis.expire(bindingKey, ttl)
          return { account: picked.account, isOverflow: true, selectedGroupId: picked.selectedGroupId }
        }

        const usable = await isAccountUsable(account, model)
        if (usable) {
          await redis.expire(bindingKey, ttl)
          if (binding.overflowCount !== 0) {
            binding.overflowCount = 0
            await writeBinding(redis, bindingKey, binding, ttl)
          }
          const eff = resolveEffectiveGroup(account, clientGroupId)
          log('info', `sticky.binding reuse key=${bindingKey} account=${account.id} selected_group=${eff.groupId ?? '-'}`)
          return { account, isOverflow: false, selectedGroupId: eff.groupId }
        }

        if (account.status !== 'active') {
          const picked = await pickBestAccount(model, [account.id], clientGroupId)
          if (!picked) return null
          log('warn', `sticky.binding migrate inactive key=${bindingKey} from=${account.id} to=${picked.account.id} status=${account.status}`)
          await moveBindingToAccount(redis, bindingKey, binding, account.id, picked.account)
          return { account: picked.account, isOverflow: false, selectedGroupId: picked.selectedGroupId }
        }

        // ★ Sticky migrate (was: 503-fix temp-fallback)
        // 号还是 active 但 isAccountUsable=false (cooldown / concurrent满 / RPM/TPM/daily满)
        // 原逻辑保持 binding 指向原号"等它恢复",但 cooldown(常 15-30min)远超
        // Anthropic prompt cache TTL(5min)→ 原号恢复时 cache 早过期,顶号期间每次
        // 重选号又付一次 cache_creation,两边亏。
        // 新逻辑: 永久把 binding 迁到新号 → 之后该 session 都走新号 → cache 命中率上去,
        // 池子分布也更均匀,不存在"挤回去再挤出来"的震荡。
        // 池子空场景下行为不变(都是 binding 保留 + 503)。
        const newPicked = await pickBestAccount(model, [account.id], clientGroupId)
        if (newPicked) {
          log('warn', `sticky.binding migrate unusable key=${bindingKey} from=${account.id} to=${newPicked.account.id} status=${account.status} model=${model ?? '-'}`)
          await moveBindingToAccount(redis, bindingKey, binding, account.id, newPicked.account)
          return { account: newPicked.account, isOverflow: false, selectedGroupId: newPicked.selectedGroupId }
        }
        // 实在没号可用,只能 503 — binding 不动,等下次重新挑
        log('warn', `sticky.binding unusable_no_fallback key=${bindingKey} account=${account.id} status=${account.status} model=${model ?? '-'}`)
        await redis.expire(bindingKey, ttl)
        return null
      }
      log('warn', `sticky.binding account_missing key=${bindingKey} bound_account=${binding.accountId} local_accounts=${accounts.length}`)
    }
  }

  // 2. No binding -- pick best account
  const picked = await pickBestAccount(model, [], clientGroupId)
  if (!picked) return null
  const account = picked.account

  if (bindingKey) {
    log('info', `sticky.binding create key=${bindingKey} account=${account.id} selected_group=${picked.selectedGroupId ?? '-'}`)
    await createBinding(redis, bindingKey, account)
  }

  return { account, isOverflow: false, selectedGroupId: picked.selectedGroupId }
}


async function isAccountUsable(account: OAuthAccount, model: string | null): Promise<boolean> {
  if (account.status !== 'active') return false

  // CC disguise template is mandatory for OAuth accounts — without it, the
  // request would leak a stale static default fingerprint. api_key accounts
  // bypass disguise (direct provider call) and don't need one.
  if (account.authKind === 'oauth' && !account.ccTemplateId) return false
  if (account.authKind === 'oauth' && account.ccTemplateId) {
    if (!(await hasTemplateInRedis(account.ccTemplateId))) return false
  }

  // Check model support (explicit whitelist)
  if (model && account.models && account.models.length > 0) {
    if (!account.models.includes(model)) return false
  }

  // Check model-tier compatibility (Pro cannot use Opus, etc.)
  if (!isModelAllowedForAccountType(model, account.accountType)) return false

  // Check token
  const hasToken = await ensureValidToken(account)
  if (!hasToken) return false

  const proxySelection = getProxyAgentForProxyId(account.outboundProxyId)
  if (proxySelection.required && !proxySelection.agent) return false

  // Fingerprint gate removed — headers are passed through from client,
  // no longer overridden from stored fingerprint.

  if (!isRedisAvailable()) return true

  const redis = getRedis()

  // Check cooldown
  const cooldown = await redis.get(`cooldown:${account.id}`)
  if (cooldown) return false

  // Session count is now managed by session-slots module (LRU reuse, not hard reject).
  // Old maxSessions gate removed — slot allocation handles this transparently.

  // Check concurrent
  if (account.maxConcurrent > 0) {
    const concurrent = parseInt(await redis.get(`concurrent:${account.id}`) ?? '0')
    if (concurrent >= account.maxConcurrent) return false
  }

  // Check RPM (sliding window)
  if (account.maxRpm > 0) {
    const rpm = await getSlidingRpm(redis, account.id)
    if (rpm >= account.maxRpm) return false
  }

  // Check TPM (sliding window)
  if (account.maxTpm > 0) {
    const tpm = await getSlidingTpm(redis, account.id)
    if (tpm >= account.maxTpm) return false
  }

  // Check daily limits
  if (account.maxDailyReq > 0) {
    const daily = parseInt(await redis.get(`daily_req:${account.id}`) ?? '0')
    if (daily >= account.maxDailyReq) return false
  }

  return true
}

/**
 * Selection scoring.
 *
 * Candidates are filtered by group eligibility / model / tier / status first.
 * The remaining set is sliced into tiers keyed by the EFFECTIVE multiplier
 * (resolveEffectiveGroup) so the cheapest billing tier is always tried first.
 * Within each tier, the existing weighted round-robin is preserved — each
 * account contributes `weight` virtual slots to the tier, and `lbPointer` is
 * advanced on hit for fair rotation across requests.
 *
 * We only fall through to a pricier tier when every account in the cheaper
 * tier is temporarily unusable (cooldown / concurrent / rpm / tpm / daily /
 * token refresh). This preserves the "lowest cost first" invariant without
 * starving traffic when the cheap tier is momentarily saturated.
 *
 * Return includes `selectedGroupId` so callers can recover the multiplier at
 * settlement time without re-running the group resolver.
 */
/**
 * Pipeline-fetch live load metrics for multiple accounts in one RTT.
 * Returns Map<accountId, { concurrent, rpm, tpm, daily }>.
 *
 * Uses ZCOUNT for RPM (O(log N)) and ZRANGE for TPM (we need to sum tokens
 * encoded in member strings — ZCOUNT won't give sum). TPM read is O(K) where
 * K is entries in the 60s window — typically <= maxRpm, so bounded.
 */
async function fetchLoadMetrics(
  redis: import('ioredis').default,
  list: OAuthAccount[],
): Promise<Map<string, { concurrent: number; rpm: number; tpm: number; daily: number }>> {
  const result = new Map<string, { concurrent: number; rpm: number; tpm: number; daily: number }>()
  if (list.length === 0) return result
  const now = Date.now()
  const cutoff = now - 60_000
  const pipe = redis.pipeline()
  for (const a of list) {
    pipe.get(`concurrent:${a.id}`)
    pipe.zcount(`rpm:${a.id}`, cutoff, '+inf')
    pipe.zrangebyscore(`tpm:${a.id}`, cutoff, '+inf')
    pipe.get(`daily_req:${a.id}`)
  }
  const res = await pipe.exec() ?? []
  for (let i = 0; i < list.length; i++) {
    const base = i * 4
    const concurrent = parseInt(String(res[base]?.[1] ?? '0')) || 0
    const rpm = Number(res[base + 1]?.[1] ?? 0) || 0
    const tpmMembers = (res[base + 2]?.[1] as string[] | null) ?? []
    let tpm = 0
    for (const m of tpmMembers) {
      // member format: "<timestamp>:<tokens>:<rand>"
      const parts = String(m).split(':')
      tpm += parseInt(parts[1] ?? '0') || 0
    }
    const daily = parseInt(String(res[base + 3]?.[1] ?? '0')) || 0
    result.set(list[i].id, { concurrent, rpm, tpm, daily })
  }
  return result
}

/**
 * Compute a load score in [0, +∞). Lower = emptier = preferred.
 *
 * Primary signal: the MAX util fraction across 4 rate-limit dimensions. Any
 * single dim nearing 1.0 dominates, matching the real behavior (any dim
 * hitting its cap triggers limiter block).
 *
 * Weight divides the primary so `weight=30` account ties with `weight=15` at
 * double the util — weight becomes a capacity multiplier, not a rotation
 * priority.
 *
 * Secondary signal (scaled 0.01×): recent pick count / weight. Breaks ties
 * at low traffic (where all util = 0) in weight-proportional fashion, so B
 * still gets traffic even when A's util drops back to 0 between requests.
 * The scale keeps it dominated by the primary when util > 0.01 on any dim.
 */
function computeLoadScore(
  c: OAuthAccount,
  load: { concurrent: number; rpm: number; tpm: number; daily: number },
): number {
  const w = Math.max(1, c.weight)
  const cf = c.maxConcurrent > 0 ? load.concurrent / c.maxConcurrent : 0
  const rf = c.maxRpm > 0 ? load.rpm / c.maxRpm : 0
  const tf = c.maxTpm > 0 ? load.tpm / c.maxTpm : 0
  const df = c.maxDailyReq > 0 ? load.daily / c.maxDailyReq : 0
  const primary = Math.max(cf, rf, tf, df) / w
  // `load.rpm` is also our "recent picks" proxy — a 60s sliding window of
  // requests to this account. Dividing by weight makes B with lower weight
  // catch up faster, producing weight-proportional steady-state distribution.
  const secondary = 0.01 * (load.rpm / w)
  return primary + secondary
}

async function pickBestAccount(
  model: string | null,
  exclude: string[] = [],
  clientGroupId: string | null = null,
): Promise<{ account: OAuthAccount; selectedGroupId: string | null } | null> {
  const candidates = accounts.filter(a => {
    if (a.status !== 'active') return false
    if (exclude.includes(a.id)) return false
    if (!isAccountInGroup(a, clientGroupId)) return false
    if (model && a.models && a.models.length > 0 && !a.models.includes(model)) return false
    if (!isModelAllowedForAccountType(model, a.accountType)) return false
    return true
  })

  if (candidates.length === 0) return null

  // Bucket by effective multiplier (ascending) — cheapest tier tried first.
  type TierCandidate = { account: OAuthAccount; selectedGroupId: string | null }
  const tierMap = new Map<number, TierCandidate[]>()
  for (const c of candidates) {
    const eff = resolveEffectiveGroup(c, clientGroupId)
    let tier = tierMap.get(eff.multiplier)
    if (!tier) { tier = []; tierMap.set(eff.multiplier, tier) }
    tier.push({ account: c, selectedGroupId: eff.groupId })
  }
  const tiers = Array.from(tierMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, list]) => list)

  const redis = getRedis()

  for (const tier of tiers) {
    if (tier.length === 0) continue

    // One-shot fetch of all candidates' live load — O(1) RTT per tier.
    const loads = await fetchLoadMetrics(redis, tier.map(t => t.account))

    // Sort ascending by score. Ties break by lbPointer-advanced stable order
    // so batches arriving with identical scores don't all stampede one account.
    const scored = tier.map(t => ({
      slot: t,
      score: computeLoadScore(t.account, loads.get(t.account.id)!),
    }))
    scored.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score
      // Deterministic + rotating tie-break: use account.id ordering shifted
      // by lbPointer so consecutive ties alternate picks.
      const ai = (a.slot.account.id).localeCompare(b.slot.account.id)
      return lbPointer % 2 === 0 ? ai : -ai
    })

    for (const { slot } of scored) {
      const usable = await isAccountUsable(slot.account, model)
      if (usable) {
        lbPointer++ // advance only on successful pick
        return { account: slot.account, selectedGroupId: slot.selectedGroupId }
      }
    }
    // This tier saturated — try next multiplier up.
  }

  return null
}

async function pickBestAccountNoRedis(
  model: string | null,
  clientGroupId: string | null = null,
): Promise<AccountSelection | null> {
  const candidates = accounts.filter(a => {
    if (a.status !== 'active') return false
    if (!isAccountInGroup(a, clientGroupId)) return false
    if (model && a.models && a.models.length > 0 && !a.models.includes(model)) return false
    if (!isModelAllowedForAccountType(model, a.accountType)) return false
    return true
  })
  if (candidates.length === 0) return null

  // Same multiplier-first ordering as pickBestAccount — grouped by effective
  // multiplier, round-robin within each tier.
  const scored = candidates.map((a) => {
    const eff = resolveEffectiveGroup(a, clientGroupId)
    return { account: a, selectedGroupId: eff.groupId, multiplier: eff.multiplier }
  }).sort((a, b) => a.multiplier - b.multiplier)

  const idx = lbPointer % scored.length
  lbPointer = (idx + 1) % scored.length
  const pick = scored[idx]
  const hasToken = await ensureValidToken(pick.account)
  if (!hasToken) return null
  return { account: pick.account, isOverflow: false, selectedGroupId: pick.selectedGroupId }
}

async function recordBlockedReason(accountId: string, reason: string): Promise<void> {
  const truncated = reason.slice(0, 500)
  // Two stores with different semantics:
  //   PG last_error — single scalar showing "currently skipped because". Drives
  //     the accounts-list warning pill. OK to overwrite.
  //   Redis skip_log — 50-entry LIST of consecutive-deduped events for the
  //     error tab. Never-persisted: pool skips are state, not facts (see
  //     memory note — high freq, low info density, not needed for audit).
  try {
    await query(
      `UPDATE oauth_accounts SET last_error = $1, updated_at = now() WHERE id = $2 AND deployment = $3`,
      [truncated, accountId, DEPLOYMENT],
    )
  } catch {}
  await appendSkipLog(accountId, truncated)
}

/**
 * Append a skip event to Redis, collapsing consecutive duplicates:
 *   - LINDEX 0 → if latest entry has same reason, bump count + timestamp in place
 *   - else LPUSH new entry + LTRIM 0 49
 *   - PEXPIRE 7 days (sliding)
 *
 * Silent no-op if Redis is unavailable — skip logs are best-effort UX, not
 * fact-critical.
 */
async function appendSkipLog(accountId: string, reason: string): Promise<void> {
  if (!isRedisAvailable()) return
  try {
    const redis = getRedis()
    const key = `skip_log:${accountId}`
    const head = await redis.lindex(key, 0)
    const now = Date.now()
    if (head) {
      try {
        const prev = JSON.parse(head)
        if (prev && prev.reason === reason) {
          // consecutive dup — update in place, do not add a new row
          prev.count = (prev.count ?? 1) + 1
          prev.at = now
          await redis.lset(key, 0, JSON.stringify(prev))
          await redis.pexpire(key, 7 * 24 * 60 * 60 * 1000)
          return
        }
      } catch {
        // corrupt entry — fall through and LPUSH a new one
      }
    }
    await redis.lpush(key, JSON.stringify({ at: now, reason, count: 1 }))
    await redis.ltrim(key, 0, 49)
    await redis.pexpire(key, 7 * 24 * 60 * 60 * 1000)
  } catch { /* best-effort */ }
}

/**
 * Read recent pool-skip events for an account. Returns entries newest-first.
 * Empty array if Redis unavailable or no events yet.
 */
export async function readSkipLog(
  accountId: string,
): Promise<Array<{ at: number; reason: string; count: number }>> {
  if (!isRedisAvailable()) return []
  try {
    const redis = getRedis()
    const rows = await redis.lrange(`skip_log:${accountId}`, 0, 49)
    const out: Array<{ at: number; reason: string; count: number }> = []
    for (const r of rows) {
      try {
        const obj = JSON.parse(r)
        if (obj && typeof obj.reason === 'string') {
          out.push({
            at: Number(obj.at) || 0,
            reason: obj.reason,
            count: Number(obj.count) || 1,
          })
        }
      } catch { /* skip corrupt */ }
    }
    return out
  } catch {
    return []
  }
}

export async function describePoolUnavailability(
  model: string | null,
  clientGroupId: string | null = null,
): Promise<string> {
  if (accounts.length === 0) {
    if (poolConfigured) {
      return 'No active OAuth accounts remain in the pool.'
    }
    return 'No OAuth accounts are configured in the pool.'
  }

  const counts = {
    active: 0,
    disabled: 0,
    error: 0,
    cooldown: 0,
    proxyUnavailable: 0,
    modelMismatch: 0,
    tierMismatch: 0,
    groupMismatch: 0,
    noToken: 0,
    concurrent: 0,
    rpm: 0,
    tpm: 0,
    daily: 0,
    unknown: 0,
  }

  for (const account of accounts) {
    if (account.status !== 'active') {
      if (account.status === 'disabled') counts.disabled += 1
      else counts.error += 1
      continue
    }

    counts.active += 1

    // 严格组隔离：clientGroupId 设了就只算同组账号，shared-pool 不接管
    if (!isAccountInGroup(account, clientGroupId)) {
      counts.groupMismatch += 1
      continue
    }

    if (model && account.models && account.models.length > 0 && !account.models.includes(model)) {
      counts.modelMismatch += 1
      continue
    }

    if (!isModelAllowedForAccountType(model, account.accountType)) {
      counts.tierMismatch += 1
      continue
    }

    const hasToken = await ensureValidToken(account)
    const credential = account.authKind === 'api_key' ? account.apiKey : account.accessToken
    if (!hasToken || !credential) {
      counts.noToken += 1
      continue
    }

    const proxySelection = getProxyAgentForProxyId(account.outboundProxyId)
    if (proxySelection.required && !proxySelection.agent) {
      counts.proxyUnavailable += 1
      await recordBlockedReason(account.id, proxySelection.error ?? 'Bound outbound proxy unavailable')
      continue
    }

    if (!isRedisAvailable()) {
      counts.unknown += 1
      continue
    }

    const redis = getRedis()
    const cooldown = await redis.get(`cooldown:${account.id}`)
    if (cooldown) {
      counts.cooldown += 1
      continue
    }

    // Session count managed by session-slots LRU — no hard reject here.

    if (account.maxConcurrent > 0) {
      const concurrent = parseInt(await redis.get(`concurrent:${account.id}`) ?? '0')
      if (concurrent >= account.maxConcurrent) {
        counts.concurrent += 1
        await recordBlockedReason(account.id, `Blocked by gateway: concurrent ${concurrent}/${account.maxConcurrent}`)
        continue
      }
    }

    if (account.maxRpm > 0) {
      const rpm = await getSlidingRpm(redis, account.id)
      if (rpm >= account.maxRpm) {
        counts.rpm += 1
        await recordBlockedReason(account.id, `Blocked by gateway: RPM ${rpm}/${account.maxRpm}`)
        continue
      }
    }

    if (account.maxTpm > 0) {
      const tpm = await getSlidingTpm(redis, account.id)
      if (tpm >= account.maxTpm) {
        counts.tpm += 1
        await recordBlockedReason(account.id, `Blocked by gateway: TPM ${tpm.toLocaleString()}/${account.maxTpm.toLocaleString()}`)
        continue
      }
    }

    if (account.maxDailyReq > 0) {
      const daily = parseInt(await redis.get(`daily_req:${account.id}`) ?? '0')
      if (daily >= account.maxDailyReq) {
        counts.daily += 1
        await recordBlockedReason(account.id, `Blocked by gateway: daily requests ${daily}/${account.maxDailyReq}`)
        continue
      }
    }
  }

  const parts: string[] = []
  if (counts.disabled > 0) parts.push(`${counts.disabled} disabled`)
  if (counts.error > 0) parts.push(`${counts.error} error`)
  if (counts.cooldown > 0) parts.push(`${counts.cooldown} cooling down`)
  if (counts.proxyUnavailable > 0) parts.push(`${counts.proxyUnavailable} bound proxy unavailable`)
  if (counts.noToken > 0) parts.push(`${counts.noToken} missing valid token`)
  if (counts.concurrent > 0) parts.push(`${counts.concurrent} at concurrent limit`)
  if (counts.rpm > 0) parts.push(`${counts.rpm} at RPM limit`)
  if (counts.tpm > 0) parts.push(`${counts.tpm} at TPM limit`)
  if (counts.daily > 0) parts.push(`${counts.daily} at daily limit`)
  if (counts.tierMismatch > 0) parts.push(`${counts.tierMismatch} account tier insufficient for model ${model} (need Max)`)
  if (counts.modelMismatch > 0) parts.push(`${counts.modelMismatch} do not support model ${model}`)
  if (counts.groupMismatch > 0) parts.push(`${counts.groupMismatch} not in client's bound group`)
  if (parts.length === 0) parts.push('all accounts are temporarily unavailable')
  return `No available OAuth accounts: ${parts.join(', ')}.`
}

// ── Request lifecycle ──

async function decrementConcurrentCounter(accountId: string): Promise<void> {
  const redis = getRedis()
  await redis.eval(
    `
      local current = tonumber(redis.call('GET', KEYS[1]) or '0')
      if current <= 0 then
        redis.call('SET', KEYS[1], '0', 'EX', ARGV[1])
        return 0
      end
      local next = redis.call('DECR', KEYS[1])
      redis.call('EXPIRE', KEYS[1], ARGV[1])
      return next
    `,
    1,
    `concurrent:${accountId}`,
    '600',
  )
}

/**
 * Immediately disable an account (e.g., after 401/403 ban).
 * Updates DB + removes from in-memory pool.
 * Recovery: admin manually re-enables via dashboard.
 */
export async function disableAccount(accountId: string, reason: string): Promise<void> {
  try {
    await query(
      `UPDATE oauth_accounts SET status = 'disabled', health_status = 'failed', last_error = $2, updated_at = now() WHERE id = $1 AND deployment = $3`,
      [accountId, reason, DEPLOYMENT]
    )
    accounts = accounts.filter(a => a.id !== accountId)
    log('warn', `account-pool: disabled account ${accountId}: ${reason}`)
  } catch (err) {
    log('error', `account-pool: failed to disable account ${accountId}: ${err}`)
  }
}

// ── Sliding window helpers ──

async function getSlidingRpm(redis: import('ioredis').default, accountId: string): Promise<number> {
  const now = Date.now()
  await redis.zremrangebyscore(`rpm:${accountId}`, 0, now - 60_000)
  return redis.zcard(`rpm:${accountId}`)
}

async function getSlidingTpm(redis: import('ioredis').default, accountId: string): Promise<number> {
  const now = Date.now()
  const key = `tpm:${accountId}`
  await redis.zremrangebyscore(key, 0, now - 60_000)
  const members = await redis.zrange(key, 0, -1)
  let total = 0
  for (const m of members) {
    // member format: "timestamp:tokens:random"
    const parts = m.split(':')
    total += parseInt(parts[1] ?? '0') || 0
  }
  return total
}

export async function onRequestStart(accountId: string): Promise<void> {
  if (!isRedisAvailable()) return
  const redis = getRedis()
  const now = Date.now()
  const rpmKey = `rpm:${accountId}`
  const pipe = redis.pipeline()
  // Concurrent
  pipe.incr(`concurrent:${accountId}`)
  pipe.expire(`concurrent:${accountId}`, 600)
  // RPM: sliding window via sorted set (score = timestamp ms)
  pipe.zadd(rpmKey, now, `${now}:${Math.random().toString(36).slice(2, 8)}`)
  pipe.zremrangebyscore(rpmKey, 0, now - 60_000)
  pipe.expire(rpmKey, 120)
  await pipe.exec()
}

export async function onRequestEnd(
  accountId: string,
  tokens: number,
  cost: number,
  success: boolean,
  failureReason?: string | null,
  upstreamRetryAfterSec?: number | null,
): Promise<void> {
  if (!isRedisAvailable()) return
  const redis = getRedis()
  const accountForAssessment = accounts.find(a => a.id === accountId) ?? null
  // api_key 直连账号不计上游错误也不冷却：5xx 是上游中转的业务返回，跟 key 健康无关，
  // 网关原样透传给客户端就行；oauth 账号才需要把错误攒到阈值打冷却防被风控。
  const treatAsIgnore = !success && accountForAssessment?.authKind === 'api_key'
  const assessment = success
    ? null
    : (treatAsIgnore
        ? { message: failureReason ?? 'api_key passthrough', action: 'ignore' as const }
        : assessFailureReason(failureReason))
  const pipe = redis.pipeline()

  // Decrement concurrent
  await decrementConcurrentCounter(accountId)

  if (success) {
    // TPM: sliding window via sorted set (member encodes token count in score)
    const tpmKey = `tpm:${accountId}`
    const now = Date.now()
    if (tokens > 0) {
      // Add one entry per request; score = timestamp, member encodes tokens for retrieval
      pipe.zadd(tpmKey, now, `${now}:${tokens}:${Math.random().toString(36).slice(2, 8)}`)
      pipe.zremrangebyscore(tpmKey, 0, now - 60_000)
      pipe.expire(tpmKey, 120)
    }

    // Daily counters
    const ttlMidnight = secondsUntilMidnight()
    pipe.incr(`daily_req:${accountId}`)
    pipe.expire(`daily_req:${accountId}`, ttlMidnight)
    pipe.incrby(`daily_tok:${accountId}`, tokens)
    pipe.expire(`daily_tok:${accountId}`, ttlMidnight)
    pipe.incrbyfloat(`daily_cost:${accountId}`, cost)
    pipe.expire(`daily_cost:${accountId}`, ttlMidnight)

    // Reset error count on success
    pipe.del(`errors:${accountId}`)
  } else if (assessment?.action !== 'ignore') {
    // Track errors
    pipe.incr(`errors:${accountId}`)
    pipe.expire(`errors:${accountId}`, 300)
  }

  await pipe.exec()

  // Check error threshold for cooldown
  if (!success) {
    const failureAssessment = assessment ?? assessFailureReason(failureReason)
    if (failureAssessment.action === 'ignore') {
      return
    }
    const errors = parseInt(await redis.get(`errors:${accountId}`) ?? '0')
    const account = accountForAssessment ?? accounts.find(a => a.id === accountId)
    if (account) {
      const reasonText = failureAssessment.message

      if (failureAssessment.action === 'disabled' || failureAssessment.action === 'error') {
        await markAccountUnavailable(account, failureAssessment.action, reasonText)
        return
      }

      if (errors >= 10) {
        await markAccountUnavailable(account, 'error', `Too many errors: ${reasonText}`)
        log('error', `account-pool: account "${account.name}" marked error due to ${errors} errors (${reasonText})`)
      } else if (errors >= 3) {
        const localCd = account.cooldownSeconds * (errors >= 5 ? 5 : 1)
        // Honor upstream Retry-After: when Anthropic says 'wait X seconds'
        // (e.g. 5h limit returns retry-after=12982 = 3.6h), respect it.
        // Cap at 24h as safety against accidental huge values.
        const cd = Math.min(
          Math.max(localCd, upstreamRetryAfterSec ?? 0),
          24 * 3600,
        )
        if (cd > localCd) {
          log('warn', `account-pool: "${account.name}" cooldown extended to ${cd}s (upstream retry-after=${upstreamRetryAfterSec}s, local=${localCd}s)`)
        }
        const cooldownState: CooldownState = {
          reason: reasonText,
          errors,
          startedAt: Date.now(),
          until: Date.now() + cd * 1000,
        }
        await Promise.all([
          redis.set(`cooldown:${accountId}`, JSON.stringify(cooldownState), 'EX', cd),
          query(
            "UPDATE oauth_accounts SET last_error = $1, updated_at = now() WHERE id = $2 AND deployment = $3",
            [reasonText.slice(0, 500), accountId, DEPLOYMENT],
          ).catch(() => {}),
        ])
        log('warn', `account-pool: account "${account.name}" in cooldown for ${cd}s (${errors} errors, ${reasonText})`)
      }
    }
  }

  // Update last_used_at on every request
  if (success) {
    await query(
      `UPDATE oauth_accounts SET last_used_at = now() WHERE id = $1 AND deployment = $2`,
      [accountId, DEPLOYMENT]
    ).catch(() => {})
  }
}

function secondsUntilMidnight(): number {
  const now = new Date()
  const midnight = new Date(now)
  midnight.setHours(24, 0, 0, 0)
  return Math.floor((midnight.getTime() - now.getTime()) / 1000)
}

function formatFailureReason(reason?: string | null): string {
  if (!reason) return 'Request failed'
  if (reason.startsWith('upstream_status_')) {
    const raw = reason.slice('upstream_status_'.length)
    const [status, ...rest] = raw.split(':')
    const detail = rest.join(':').trim()
    return detail ? `Upstream returned ${status}: ${detail}` : `Upstream returned ${status}`
  }
  if (reason.startsWith('upstream_error:')) {
    return `Upstream error: ${reason.slice('upstream_error:'.length).trim()}`
  }
  return reason
}

// ── Lifecycle ──

let syncTimer: ReturnType<typeof setInterval> | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null

async function loadConfiguredAccountState(): Promise<void> {
  try {
    const result = await query('SELECT COUNT(*)::int AS n FROM oauth_accounts WHERE deployment = $1', [DEPLOYMENT])
    poolConfigured = (result.rows[0]?.n ?? 0) > 0
  } catch {
    poolConfigured = false
  }
}

export async function startAccountPool(): Promise<void> {
  await loadConfiguredAccountState()
  await loadSessionTtl()
  await loadDefaultProfile()
  await syncAccounts()

  // Hydrate version locks from Redis so OS/arch/UA stay consistent across PM2 restarts
  const accountUuids = accounts
    .map(a => a.canonicalIdentity?.account_uuid)
    .filter((u): u is string => !!u)
  if (accountUuids.length > 0) {
    await hydrateVersionLocks(accountUuids)
    log('info', `account-pool: hydrated version locks for ${accountUuids.length} accounts`)
  }

  // Hydrate session slots from DB
  try {
    const slotRows = await query(
      `SELECT * FROM session_slots WHERE last_used_at > now() - INTERVAL '24 hours' ORDER BY account_id, slot_index`
    )
    if (slotRows.rows.length > 0) {
      hydrateFromRows(slotRows.rows)
      log('info', `account-pool: hydrated ${slotRows.rows.length} session slots from DB`)
    }
  } catch (err) {
    log('debug', `account-pool: session_slots hydrate skipped: ${err}`)
  }

  await syncTemplatesToRedis()
  await assertAccountTemplatesPresent(accounts.map(a => ({
    id: a.id,
    ccTemplateId: a.ccTemplateId,
    authKind: a.authKind,
  })))

  // Persist slot events to DB (async, fire-and-forget)
  onSlotEvent(async (event: SlotEvent) => {
    try {
      if (event.action === 'created' || event.action === 'bound') {
        await query(
          `INSERT INTO session_slots (account_id, slot_index, derived_session_id, bound_keys, reuse_count, last_used_at)
           VALUES ($1, $2, $3, ARRAY[$4], $5, now())
           ON CONFLICT (account_id, slot_index) DO UPDATE
           SET bound_keys = ARRAY[$4], reuse_count = $5, last_used_at = now()`,
          [event.accountId, event.slotIndex, event.derivedSessionId ?? '',
           event.clientName, event.reuseNumber ?? 0]
        )
      }
      await query(
        `INSERT INTO session_slot_history (account_id, slot_index, action, client_name, evicted_client, idle_duration_ms, reuse_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [event.accountId, event.slotIndex, event.action, event.clientName,
         event.evictedClient ?? null, event.idleDurationMs ?? null, event.reuseNumber ?? null]
      )
    } catch (err) {
      log('debug', `session-slots: DB persist failed: ${err}`)
    }
  })

  // Clean up expired session slots every hour
  setInterval(async () => {
    try {
      await query(`DELETE FROM session_slots WHERE last_used_at < now() - INTERVAL '24 hours'`)
      await query(`DELETE FROM session_slot_history WHERE created_at < now() - INTERVAL '7 days'`)
    } catch {}
  }, 3600_000)

  await enablePoolIfReady()
}

// Start the 30s/60s timers once. Safe to call multiple times — no-op if already running.
function ensurePoolTimers(): void {
  if (!syncTimer) {
    syncTimer = setInterval(async () => {
      loadConfiguredAccountState().catch(() => {})
      await syncAccounts().catch(() => {})
      loadSessionTtl().catch(() => {})
      loadDefaultProfile().catch(() => {})
      const uuids = accounts
        .map(a => a.canonicalIdentity?.account_uuid)
        .filter((u): u is string => !!u)
      if (uuids.length > 0) hydrateVersionLocks(uuids).catch(() => {})
      if (!poolEnabled || accounts.length === 0) {
        await enablePoolIfReady().catch(() => {})
      }
    }, 30_000)
  }

  if (!refreshTimer && process.env.SKIP_BOOT_REFRESH !== '1') {
    refreshTimer = setInterval(async () => {
      for (const account of accounts) {
        if (account.status === 'active') {
          await ensureValidToken(account)
        }
      }
    }, 60_000)
  }
}

// Transition poolEnabled based on current `accounts` state. Called from start + reload.
async function enablePoolIfReady(): Promise<void> {
  if (accounts.length === 0) {
    if (poolEnabled) {
      log('warn', 'account-pool: all accounts disabled/removed — pool disabled')
    } else if (poolConfigured) {
      log('warn', 'account-pool: configured accounts exist but none are active; pool disabled')
    } else {
      log('info', isAccountPoolPollMode()
        ? 'account-pool: no accounts in DB, waiting in poll mode'
        : 'account-pool: no accounts in DB, pool disabled (using config.yaml single token)')
    }
    poolEnabled = false
    if (isAccountPoolPollMode()) ensurePoolTimers()
    return
  }

  const wasEnabled = poolEnabled
  poolEnabled = true

  // Refresh all tokens (noop for already-valid ones).
  // Migration mode: SKIP_BOOT_REFRESH=1 disables proactive refresh entirely.
  if (process.env.SKIP_BOOT_REFRESH !== '1') {
    for (const account of accounts) {
      await ensureValidToken(account)
    }
  } else {
    log('warn', 'account-pool: SKIP_BOOT_REFRESH=1 — boot refresh disabled')
  }

  ensurePoolTimers()

  if (!wasEnabled) {
    log('info', `account-pool: enabled with ${accounts.length} accounts`)
  }
}

// Reload triggered by admin panel via `NOTIFY gateway_reload_<deployment>`.
// Re-runs the full start-up flow so the pool can transition disabled → enabled
// (or the reverse) without restarting the gateway.
export async function reloadAccountPool(): Promise<void> {
  await loadConfiguredAccountState()
  await loadSessionTtl()
  await loadDefaultProfile()
  await syncAccounts()

  const uuids = accounts
    .map(a => a.canonicalIdentity?.account_uuid)
    .filter((u): u is string => !!u)
  if (uuids.length > 0) {
    await hydrateVersionLocks(uuids)
  }

  await syncTemplatesToRedis()
  await assertAccountTemplatesPresent(accounts.map(a => ({
    id: a.id,
    ccTemplateId: a.ccTemplateId,
    authKind: a.authKind,
  })))

  await enablePoolIfReady()
}

export function stopAccountPool(): void {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
  if (utilizationTimer) { clearInterval(utilizationTimer); utilizationTimer = null }
}

// ── Claude utilization (5h / 7d limits) ──

let utilizationTimer: ReturnType<typeof setInterval> | null = null

/**
 * Fetch real Claude usage from /api/oauth/usage endpoint
 * Returns: { five_hour, seven_day, seven_day_opus, seven_day_sonnet, ... }
 */
export async function fetchClaudeUtilization(account: OAuthAccount): Promise<any | null> {
  // /api/oauth/usage 仅对 OAuth 账号可用，api_key 直连账号没有这条端点
  if (account.authKind === 'api_key') return null

  if (!account.accessToken) {
    const ok = await ensureValidToken(account)
    if (!ok) return null
  }

  return new Promise((resolve) => {
    const url = new URL('https://api.anthropic.com/api/oauth/usage')
    const selection = getProxyAgentForProxyId(account.outboundProxyId)
    if (selection.required && !selection.agent) {
      log('debug', `fetchClaudeUtilization skipped for "${account.name}": ${selection.error}`)
      resolve(null)
      return
    }
    const req = httpsRequest({
      hostname: url.hostname,
      path: url.pathname,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${account.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'claude-code/2.1.90',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      ...(selection.agent && { agent: selection.agent as any }),
      timeout: 10_000,
    }, (res) => {
      let data = ''
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode === 407) {
          markProxyFailure(selection, 'proxy_auth_failed: HTTP 407').catch(() => {})
        } else {
          markProxySuccess(selection).catch(() => {})
        }
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data))
          } catch {
            resolve(null)
          }
        } else {
          log('debug', `fetchClaudeUtilization failed for "${account.name}": ${res.statusCode} ${data.slice(0, 200)}`)
          resolve(null)
        }
      })
    })
    req.on('error', (err: Error) => {
      markProxyFailure(selection, `oauth_usage:${account.name}: ${err.message}`).catch(() => {})
      log('debug', `fetchClaudeUtilization error for "${account.name}": ${err.message}`)
      resolve(null)
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.end()
  })
}

async function storeClaudeUtilization(accountId: string, data: any): Promise<void> {
  if (!isRedisAvailable()) return
  const redis = getRedis()
  await redis.set(
    `claude_utilization:${accountId}`,
    JSON.stringify(data),
    'EX',
    600,
  )
  await redis.set(
    `claude_utilization:${accountId}:updated_at`,
    new Date().toISOString(),
    'EX',
    600,
  )
}

export async function refreshClaudeUtilization(accountId: string): Promise<any | null> {
  const account = accounts.find(a => a.id === accountId)
  if (!account || account.status !== 'active') return null

  try {
    const data = await fetchClaudeUtilization(account)
    if (data) {
      await storeClaudeUtilization(account.id, data)
    }
    return data
  } catch (err) {
    log('debug', `refreshClaudeUtilization error for "${account.name}": ${err}`)
    return null
  }
}

/**
 * Manual bulk utilization sync — for explicit administrative refresh only.
 */
export async function syncAllUtilizations(): Promise<void> {
  for (const account of accounts) {
    if (account.status !== 'active') continue
    try {
      await refreshClaudeUtilization(account.id)
    } catch (err) {
      log('debug', `syncAllUtilizations error for "${account.name}": ${err}`)
    }
  }
}

// ── Get token for account ──

export function getAccountToken(accountId: string): string | null {
  const account = accounts.find(a => a.id === accountId)
  if (!account || account.authKind !== 'oauth') return null
  return account.accessToken ?? null
}
