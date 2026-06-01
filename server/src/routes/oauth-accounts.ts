import { Router } from 'express'
import { randomBytes, randomUUID, createHash } from 'crypto'
import { createRequire } from 'module'
import { query, DEPLOYMENT } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { adminMiddleware } from '../middleware/admin.js'
import { getRedis } from '../redis.js'
import { requestExternal, parseProxyInput, reloadOutboundProxies } from '../services/outbound-proxy.js'
import { audit } from '../services/audit.js'
import { cookieAuth } from '../services/claude-oauth.js'
const router = Router()

// 镜像 src/features/options.ts 的默认值(server 独立 build,不能跨 rootDir import)
const OAUTH_DEFAULT_OPTIONS_PAYLOAD = {
  validate:  { body: true, shape: true, shapeAutoComplete: false, aggressiveDisguise: false, normalizeTemperature: true, model: true, fastMode: true, requireStream: true },
  clean:     { ccHeaders: false, ccBetaFlags: false, systemText: false, metadata: false, toolUseTrailing: true, capCacheControl: true },
  override:  {
    userAgent:        { mode: 'omit', value: null },
    anthropicVersion: { mode: 'omit', value: null },
    anthropicBeta:    { mode: 'omit', value: null },
    extraHeaders: {},
  },
  events: { emitTengu: true },
  canonicalCcMessages: true,
}
const APIKEY_DEFAULT_OPTIONS_PAYLOAD = {
  validate:  { body: true, shape: true, shapeAutoComplete: true, aggressiveDisguise: false, normalizeTemperature: false, model: true, fastMode: true, requireStream: true },
  clean:     { ccHeaders: true, ccBetaFlags: true, systemText: true, metadata: true, toolUseTrailing: true, capCacheControl: true },
  override:  {
    userAgent:        { mode: 'omit', value: null },
    anthropicVersion: { mode: 'omit', value: null },
    anthropicBeta:    { mode: 'omit', value: null },
    extraHeaders: {},
  },
  events: { emitTengu: false },
  canonicalCcMessages: false,
}

router.use(authMiddleware, adminMiddleware)

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const SCOPES = ['user:inference', 'user:profile', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload']

// ── Template guard ──

async function requireCCTemplate(
  ccTemplateId: unknown,
  res: any,
): Promise<string | null> {
  if (typeof ccTemplateId !== 'string' || ccTemplateId.trim().length === 0) {
    res.status(400).json({ error: 'cc_template_id is required — import a template via /api/admin/cc-disguise-templates first' })
    return null
  }
  const row = await query('SELECT id FROM cc_disguise_templates WHERE id = $1 AND deployment = $2', [ccTemplateId, DEPLOYMENT])
  if (row.rowCount === 0) {
    res.status(400).json({ error: `cc_template_id ${ccTemplateId} not found in deployment ${DEPLOYMENT}` })
    return null
  }
  return ccTemplateId
}

// ── New-account flow helpers (OAuth PKCE + api_key import) ──

const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const MANUAL_REDIRECT_URL = 'https://console.anthropic.com/oauth/code/callback'
const DEFAULT_UA = 'claude-code/2.1.112'

type PendingOAuth = {
  state: string
  codeVerifier: string
  outboundProxyId: string | null
  name: string | null
  createdAt: number
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function fetchOAuthProfile(accessToken: string, proxyId: string | null) {
  const resp = await requestExternal(PROFILE_URL, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'user-agent': DEFAULT_UA,
    },
    timeoutMs: 15_000,
    proxyId,
  })
  if (resp.statusCode >= 400) {
    throw new Error(`oauth/profile HTTP ${resp.statusCode}: ${resp.text.slice(0, 200)}`)
  }
  return resp.text ? JSON.parse(resp.text) : {}
}

async function exchangeRefreshToken(refreshToken: string, proxyId: string | null) {
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    scope: SCOPES.join(' '),
  })
  const resp = await requestExternal(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
    body,
    timeoutMs: 15_000,
    proxyId,
  })
  const parsed = resp.text ? JSON.parse(resp.text) : {}
  if (resp.statusCode !== 200 || !parsed.access_token) {
    throw new Error(`OAuth refresh failed (${resp.statusCode}): ${JSON.stringify(parsed).slice(0, 300)}`)
  }
  return {
    accessToken: parsed.access_token as string,
    refreshToken: (parsed.refresh_token as string) ?? refreshToken,
    expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
  }
}

/**
 * Load the gateway event-emitter at runtime. This file compiles to
 * server/dist/routes/oauth-accounts.js while the emitter compiles to
 * dist/event-emitter.js (project root). We resolve with createRequire so
 * TypeScript's rootDir boundary (src/) stays clean, and bail out silently
 * if the emitter hasn't been built yet.
 */
function loadEventEmitter(): { emitLoginCeremony?: (args: any) => Promise<void> } {
  try {
    const req = createRequire(import.meta.url)
    return req('../../../dist/event-emitter.js') as { emitLoginCeremony?: (args: any) => Promise<void> }
  } catch (err) {
    console.warn('oauth-accounts: event-emitter load failed:', err)
    return {}
  }
}

// NOTIFY the gateway process to reload its account pool. Without this, newly
// created accounts are invisible until the next manual reload — and if the
// pool was empty at startup, sync timers never start.
function reloadChannel(): string | null {
  switch (DEPLOYMENT) {
    case 'gw': return 'gateway_reload_gw'
    case 'gwbk': return 'gateway_reload_gwbk'
    default: return null
  }
}
async function notifyReload(): Promise<void> {
  const channel = reloadChannel()
  if (!channel) return
  try {
    await query(`NOTIFY ${channel}, 'reload'`)
  } catch (err) {
    console.warn('notifyReload failed:', err)
  }
}

// Policy fields callers may supply during account creation. Matches defaults
// in POST / so OAuth/import-rt/api-key flows produce equivalent rows.
type PolicyInput = {
  account_type?: string
  max_rpm?: number
  max_tpm?: number
  max_concurrent?: number
  max_sessions?: number
  max_daily_req?: number
  max_daily_tok?: number
  max_daily_cost?: number
  weight?: number
  cooldown_seconds?: number
  max_retries?: number
  session_ttl_seconds?: number
  group_ids?: string[] | null
}

function normalizeGroupIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return (raw as unknown[]).filter((g): g is string => typeof g === 'string' && g.length > 0)
}

async function syncGroupLinks(accountId: string, groupIds: string[]): Promise<void> {
  if (groupIds.length === 0) return
  for (const gid of groupIds) {
    await query(
      `INSERT INTO oauth_account_groups (account_id, group_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [accountId, gid],
    )
  }
}

/**
 * Persist a freshly acquired OAuth account + (best-effort) pull identity + fire
 * login ceremony event batch. Shared by /exchange and /import-rt.
 */
async function finalizeOAuthAccount(args: {
  name: string
  refreshToken: string
  accessToken: string
  expiresAt: number
  outboundProxyId: string | null
  ccTemplateId: string
  policy?: PolicyInput
  options?: Record<string, unknown>
}): Promise<{ id: string; email: string | null; accountUuid: string | null }> {
  let email: string | null = null
  let accountUuid: string | null = null
  let orgUuid: string | null = null
  try {
    const profile = await fetchOAuthProfile(args.accessToken, args.outboundProxyId)
    email = profile?.account?.email ?? null
    accountUuid = profile?.account?.uuid ?? null
    orgUuid = profile?.organization?.uuid ?? null
  } catch (err) {
    console.warn('finalizeOAuthAccount: profile fetch failed:', err)
  }

  const def = await query('SELECT id FROM identity_profiles WHERE is_default = TRUE LIMIT 1')
  const profileId = def.rows[0]?.id ?? null
  const deviceId = randomBytes(32).toString('hex')
  const canonical = { device_id: deviceId, email: email ?? '', account_uuid: accountUuid ?? '' }
  const p = args.policy ?? {}
  const groupIds = normalizeGroupIds(p.group_ids)
  const primaryGroupId = groupIds[0] ?? null

  const inserted = await query(
    `INSERT INTO oauth_accounts
       (name, refresh_token, access_token, expires_at,
        account_type, auth_kind, provider,
        max_rpm, max_tpm, max_concurrent, max_sessions,
        max_daily_req, max_daily_tok, max_daily_cost,
        weight, cooldown_seconds, max_retries, session_ttl_seconds,
        identity_profile_id, outbound_proxy_id, canonical_identity,
        simulate_fingerprint, group_id, deployment,
        organization_uuid, account_uuid, cc_template_id, options)
     VALUES ($1,$2,$3,$4,$5,'oauth','anthropic',
             $6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
             $17,$18,$19,TRUE,$20,$21,$22,$23,$24,$25)
     RETURNING id`,
    [
      args.name, args.refreshToken, args.accessToken, args.expiresAt,
      p.account_type ?? 'pro',
      p.max_rpm ?? 60, p.max_tpm ?? 80000, p.max_concurrent ?? 5, p.max_sessions ?? 0,
      p.max_daily_req ?? 0, p.max_daily_tok ?? 0, p.max_daily_cost ?? 0,
      p.weight ?? 10, p.cooldown_seconds ?? 60, p.max_retries ?? 2,
      p.session_ttl_seconds ?? 0,
      profileId, args.outboundProxyId, JSON.stringify(canonical),
      primaryGroupId, DEPLOYMENT,
      orgUuid, accountUuid, args.ccTemplateId,
      JSON.stringify(args.options ?? OAUTH_DEFAULT_OPTIONS_PAYLOAD),
    ],
  )
  const accountId: string = inserted.rows[0].id
  await syncGroupLinks(accountId, groupIds)

  try {
    const emitter = loadEventEmitter()
    if (emitter.emitLoginCeremony) {
      emitter.emitLoginCeremony({
        accountId,
        oauthToken: args.accessToken,
        proxyId: args.outboundProxyId,
        deviceId,
        accountUuid: accountUuid ?? '',
        email: email ?? '',
        orgUuid: orgUuid ?? '',
        clientVersion: '2.1.112',
        platform: 'darwin',
        arch: 'arm64',
        nodeVersion: 'v22.1.0',
        terminal: 'iTerm.app',
      }).catch(() => {})
    }
  } catch (err) {
    console.warn('finalizeOAuthAccount: emitLoginCeremony failed:', err)
  }

  return { id: accountId, email, accountUuid }
}

type RedisStats = {
  concurrent: number
  rpm: number
  tpm: number
  daily_req: number
  daily_tok: number
  daily_cost: number
  active_sessions: number
  cooldown: boolean
  cooldown_reason: string | null
  cooldown_until: string | null
  cooldown_remaining_seconds: number
  errors: number
  anthropic_limits: Record<string, string> | null
  anthropic_limits_updated_at: string | null
  claude_utilization: any | null
  claude_utilization_updated_at: string | null
}

function parseCooldown(raw: string | null, ttl: number | null | undefined) {
  const remaining = ttl && ttl > 0 ? ttl : 0
  const fallbackUntil = remaining > 0 ? new Date(Date.now() + remaining * 1000).toISOString() : null
  if (!raw) {
    return { active: false, reason: null, until: null, remainingSeconds: 0 }
  }
  try {
    const parsed = JSON.parse(raw)
    return {
      active: remaining > 0 || parsed.until > Date.now(),
      reason: typeof parsed.reason === 'string' ? parsed.reason : null,
      until: typeof parsed.until === 'number' ? new Date(parsed.until).toISOString() : fallbackUntil,
      remainingSeconds: remaining,
    }
  } catch {
    return {
      active: remaining > 0,
      reason: null,
      until: fallbackUntil,
      remainingSeconds: remaining,
    }
  }
}

/**
 * Read per-account pool-skip log. Kept only in Redis (not PG) — see the
 * memory note on why: high freq, low info density, not audit-worthy.
 * Returns newest-first, collapsed dupes with a `count`.
 */
async function readSkipLogFromRedis(
  accountId: string,
): Promise<Array<{ at: number; reason: string; count: number }>> {
  const redis = getRedis()
  if (!redis) return []
  try {
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
      } catch { /* skip corrupt entry */ }
    }
    return out
  } catch {
    return []
  }
}

async function fetchRedisStats(accountId: string): Promise<RedisStats> {
  const redis = getRedis()
  const empty: RedisStats = {
    concurrent: 0, rpm: 0, tpm: 0, daily_req: 0, daily_tok: 0,
    daily_cost: 0, active_sessions: 0, cooldown: false,
    cooldown_reason: null, cooldown_until: null, cooldown_remaining_seconds: 0,
    errors: 0,
    anthropic_limits: null, anthropic_limits_updated_at: null,
    claude_utilization: null, claude_utilization_updated_at: null,
  }
  if (!redis) return empty
  try {
    const now = Date.now()
    // Clean up expired entries before reading
    await Promise.all([
      redis.zremrangebyscore(`rpm:${accountId}`, 0, now - 60_000),
      redis.zremrangebyscore(`tpm:${accountId}`, 0, now - 60_000),
    ])
    const [concurrent, rpmCount, tpmMembers, dailyReq, dailyTok, dailyCost, sessions, cooldown, cooldownTtl, errors, anthropicLimits, limitsUpdatedAt, claudeUtil, claudeUtilUpdated] = await Promise.all([
      redis.get(`concurrent:${accountId}`),
      redis.zcard(`rpm:${accountId}`),
      redis.zrange(`tpm:${accountId}`, 0, -1),
      redis.get(`daily_req:${accountId}`),
      redis.get(`daily_tok:${accountId}`),
      redis.get(`daily_cost:${accountId}`),
      redis.scard(`sessions:${accountId}`),
      redis.get(`cooldown:${accountId}`),
      redis.ttl(`cooldown:${accountId}`),
      redis.get(`errors:${accountId}`),
      redis.hgetall(`anthropic_limits:${accountId}`),
      redis.get(`anthropic_limits:${accountId}:updated_at`),
      redis.get(`claude_utilization:${accountId}`),
      redis.get(`claude_utilization:${accountId}:updated_at`),
    ])
    const cooldownState = parseCooldown(cooldown, cooldownTtl)
    return {
      concurrent: parseInt(concurrent ?? '0') || 0,
      rpm: rpmCount || 0,
      tpm: (tpmMembers as string[]).reduce((sum, m) => sum + (parseInt(m.split(':')[1] ?? '0') || 0), 0),
      daily_req: parseInt(dailyReq ?? '0') || 0,
      daily_tok: parseInt(dailyTok ?? '0') || 0,
      daily_cost: parseFloat(dailyCost ?? '0') || 0,
      active_sessions: sessions || 0,
      cooldown: cooldownState.active,
      cooldown_reason: cooldownState.reason,
      cooldown_until: cooldownState.until,
      cooldown_remaining_seconds: cooldownState.remainingSeconds,
      errors: parseInt(errors ?? '0') || 0,
      anthropic_limits: anthropicLimits && Object.keys(anthropicLimits).length > 0 ? anthropicLimits : null,
      anthropic_limits_updated_at: limitsUpdatedAt || null,
      claude_utilization: claudeUtil ? (() => { try { return JSON.parse(claudeUtil) } catch { return null } })() : null,
      claude_utilization_updated_at: claudeUtilUpdated || null,
    }
  } catch {
    return empty
  }
}

async function getSystemClientToken(): Promise<string | null> {
  const result = await query(
    `SELECT c.token
       FROM clients c
       JOIN users u ON u.id = c.user_id
      WHERE u.username = '_system'
        AND c.status = 'active'
        AND c.token != '_no_login_'
        AND c.deployment = $1
        AND u.deployment = $1
      ORDER BY c.created_at ASC
      LIMIT 1`,
    [DEPLOYMENT]
  )
  return result.rows[0]?.token ?? null
}

function extractTextPreview(payload: any): string {
  if (!payload) return ''
  if (typeof payload === 'string') return payload.slice(0, 500)
  if (Array.isArray(payload.content)) {
    const text = payload.content
      .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
      .map((item: any) => item.text)
      .join('\n')
    if (text) return text.slice(0, 500)
  }
  if (typeof payload.error === 'string') return payload.error.slice(0, 500)
  if (typeof payload.detail === 'string') return payload.detail.slice(0, 500)
  return JSON.stringify(payload).slice(0, 500)
}


// GET /api/admin/oauth-accounts — list all accounts with Redis stats + 24h health
router.get('/', async (_req, res) => {
  try {
    const result = await query(
      `WITH stats AS (
         SELECT oauth_account_id,
                COUNT(*)::int AS req_24h,
                COUNT(*) FILTER (WHERE response_status BETWEEN 200 AND 299)::int AS ok_24h,
                COUNT(*) FILTER (
                  WHERE block_reason IN ('rate_limited','upstream_429')
                     OR response_status = 429
                )::int AS limited_24h
           FROM request_logs
          WHERE created_at > now() - INTERVAL '24 hours'
          GROUP BY oauth_account_id
       ),
       cost_windows AS (
         SELECT oauth_account_id,
                COALESCE(SUM(cost) FILTER (WHERE created_at > now() - INTERVAL '5 hours'), 0)::float8 AS cost_5h,
                COALESCE(SUM(cost) FILTER (WHERE created_at > now() - INTERVAL '48 hours'), 0)::float8 AS cost_48h
           FROM usage_records
          WHERE created_at > now() - INTERVAL '48 hours'
            AND oauth_account_id IS NOT NULL
          GROUP BY oauth_account_id
       ),
       groups_agg AS (
         SELECT account_id, array_agg(group_id) AS group_ids
           FROM oauth_account_groups
          GROUP BY account_id
       ),
       session_slots_agg AS (
         SELECT account_id, COUNT(*)::int AS used_24h
           FROM session_slots
          WHERE last_used_at > now() - INTERVAL '24 hours'
          GROUP BY account_id
       )
       SELECT oa.id, oa.name, oa.account_type, oa.status, oa.health_status, oa.weight,
              oa.max_rpm, oa.max_tpm, oa.max_concurrent, oa.max_sessions,
              oa.max_daily_req, oa.max_daily_tok, oa.max_daily_cost,
              oa.cooldown_seconds, oa.max_retries, oa.models,
              COALESCE(oa.session_ttl_seconds, 0) AS session_ttl_seconds,
              oa.auth_kind, oa.options,
              oa.canonical_identity, oa.identity_profile_id, oa.outbound_proxy_id,
              oa.group_id,
              g.name AS group_name,
              COALESCE(ga.group_ids, ARRAY[]::uuid[]) AS group_ids,
              (SELECT name FROM outbound_proxies WHERE id = oa.outbound_proxy_id) AS outbound_proxy_name,
              oa.total_requests, oa.total_tokens, oa.total_cost,
              oa.expires_at, oa.last_used_at, oa.last_error, oa.banned_at, oa.created_at, oa.updated_at,
              COALESCE(s.req_24h, 0)     AS req_24h,
              COALESCE(s.ok_24h, 0)      AS ok_24h,
              COALESCE(s.limited_24h, 0) AS limited_24h,
              COALESCE(cw.cost_5h, 0)::float8  AS cost_5h,
              COALESCE(cw.cost_48h, 0)::float8 AS cost_48h,
              COALESCE(ss.used_24h, 0)         AS session_slot_used_24h,
              oa.cc_template_id,
              ct.name AS cc_template_name,
              ct.source AS cc_template_source,
              ct.updated_at AS cc_template_updated_at,
              COALESCE(jsonb_array_length(ct.tools), 0) AS cc_template_tools_count
         FROM oauth_accounts oa
         LEFT JOIN account_groups g ON g.id = oa.group_id
         LEFT JOIN stats s ON s.oauth_account_id = oa.id
         LEFT JOIN cost_windows cw ON cw.oauth_account_id = oa.id
         LEFT JOIN groups_agg ga ON ga.account_id = oa.id
         LEFT JOIN cc_disguise_templates ct ON ct.id = oa.cc_template_id
         LEFT JOIN session_slots_agg ss ON ss.account_id = oa.id
        WHERE oa.deployment = $1
        ORDER BY oa.weight DESC, oa.created_at`,
      [DEPLOYMENT]
    )

    const enriched = await Promise.all(result.rows.map(async (row: any) => {
      const stats = await fetchRedisStats(row.id)

      // session_slot count comes pre-aggregated from main SQL CTE (no per-row query)
      const slotUsed = Number(row.session_slot_used_24h ?? 0)

      let email: string | null = null
      if (row.canonical_identity) {
        try {
          const ci = typeof row.canonical_identity === 'string'
            ? JSON.parse(row.canonical_identity)
            : row.canonical_identity
          email = ci?.email || null
        } catch {}
      }

      // CC disguise template summary from DB (single JOIN, no per-row queries).
      // tools_count comes pre-computed from SQL jsonb_array_length to avoid
      // transferring the full tools jsonb (~14MB) over the wire.
      const disguise = {
        learned: !!row.cc_template_id,
        template_id: row.cc_template_id ?? null,
        template_name: row.cc_template_name ?? null,
        template_source: row.cc_template_source ?? null,
        tools_count: Number(row.cc_template_tools_count ?? 0),
        learned_at: row.cc_template_updated_at
          ? new Date(row.cc_template_updated_at).getTime()
          : null,
      }

      return {
        ...row,
        cc_template_tools_count: undefined,
        session_slot_used_24h: undefined,
        email,
        stats: {
          ...stats,
          session_slots: { used: slotUsed, max: row.max_sessions },
          disguise,
        },
      }
    }))

    res.json({ accounts: enriched })
  } catch (err) {
    console.error('List oauth accounts error:', err)
    res.status(500).json({ error: 'Failed to list accounts' })
  }
})

// GET /api/admin/oauth-accounts/today-summary — 账号池主页顶栏聚合:今日总额度 / 平均倍率
// usage_records.cost 是已乘 group 倍率的计费金额,billing_multiplier 是当时使用的倍率;
// 加权平均倍率 = SUM(cost) / SUM(cost / multiplier) = 总计费 / 总官方价。
// 必须放在 /:id 之前,否则被 catch-all 抢走。
router.get('/today-summary', async (_req, res) => {
  try {
    const r = await query(
      `SELECT COALESCE(SUM(ur.cost), 0)::float8 AS total_cost,
              COALESCE(SUM(ur.cost / NULLIF(ur.billing_multiplier, 0)), 0)::float8 AS base_cost,
              COUNT(*)::int AS request_count
         FROM usage_records ur
        WHERE ur.created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
          AND ur.client_id IN (SELECT id FROM clients WHERE deployment = $1)`,
      [DEPLOYMENT],
    )
    const row = r.rows[0] ?? { total_cost: 0, base_cost: 0, request_count: 0 }
    const totalCost = Number(row.total_cost) || 0
    const baseCost = Number(row.base_cost) || 0
    const avgMultiplier = baseCost > 0 ? totalCost / baseCost : 1
    res.json({
      total_cost: totalCost,
      avg_multiplier: avgMultiplier,
      request_count: Number(row.request_count) || 0,
    })
  } catch (err) {
    console.error('today-summary error:', err)
    res.status(500).json({ error: 'Failed to load today summary' })
  }
})

// GET /api/admin/oauth-accounts/cache-hit-rate -- prompt cache hit/ROI
// across windows. Mirrors sub2api / Anthropic Console formula: c = read / (read+write).
router.get('/cache-hit-rate', async (_req, res) => {
  try {
    const { getRedis } = await import('../redis.js')
    let gatewayStartAt: string | null = null
    const redis = getRedis()
    if (redis) {
      try {
        const v = await redis.get('gateway:start_at')
        if (v) gatewayStartAt = new Date(parseInt(v, 10)).toISOString()
      } catch {}
    }

    const sql = `
      WITH agg AS (
        SELECT
          SUM(input_tokens) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai') AS today_i,
          SUM(cache_read)   FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai') AS today_r,
          SUM(cache_write)  FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai') AS today_w,
          SUM(input_tokens) FILTER (WHERE $1::timestamptz IS NOT NULL AND created_at >= $1::timestamptz) AS since_i,
          SUM(cache_read)   FILTER (WHERE $1::timestamptz IS NOT NULL AND created_at >= $1::timestamptz) AS since_r,
          SUM(cache_write)  FILTER (WHERE $1::timestamptz IS NOT NULL AND created_at >= $1::timestamptz) AS since_w,
          SUM(input_tokens) FILTER (WHERE created_at >= now() - INTERVAL '1 hour')   AS h1_i,
          SUM(cache_read)   FILTER (WHERE created_at >= now() - INTERVAL '1 hour')   AS h1_r,
          SUM(cache_write)  FILTER (WHERE created_at >= now() - INTERVAL '1 hour')   AS h1_w,
          SUM(input_tokens) FILTER (WHERE created_at >= now() - INTERVAL '5 hours')  AS h5_i,
          SUM(cache_read)   FILTER (WHERE created_at >= now() - INTERVAL '5 hours')  AS h5_r,
          SUM(cache_write)  FILTER (WHERE created_at >= now() - INTERVAL '5 hours')  AS h5_w,
          SUM(input_tokens) FILTER (WHERE created_at >= now() - INTERVAL '24 hours') AS h24_i,
          SUM(cache_read)   FILTER (WHERE created_at >= now() - INTERVAL '24 hours') AS h24_r,
          SUM(cache_write)  FILTER (WHERE created_at >= now() - INTERVAL '24 hours') AS h24_w
        FROM usage_records
        WHERE created_at >= now() - INTERVAL '30 days'
      )
      SELECT * FROM agg`
    const rs = await query(sql, [gatewayStartAt])
    const r = rs.rows[0] ?? {}

    const mk = (i: any, rd: any, w: any) => {
      const I = Number(i) || 0
      const R = Number(rd) || 0
      const W = Number(w) || 0
      const denom_c = R + W
      return {
        a: I + R + W > 0 ? Math.round(1000 * R / (I + R + W)) / 10 : null,
        b: I + R + W > 0 ? Math.round(1000 * (R + W) / (I + R + W)) / 10 : null,
        c: denom_c > 0 ? Math.round(1000 * R / denom_c) / 10 : null,
        roi: W > 0 ? Math.round(10 * R / W) / 10 : null,
        read_tokens: R,
        write_tokens: W,
        input_tokens: I,
      }
    }

    res.json({
      windows: {
        today:       mk(r.today_i, r.today_r, r.today_w),
        since_start: mk(r.since_i, r.since_r, r.since_w),
        '1h':  mk(r.h1_i,  r.h1_r,  r.h1_w),
        '5h':  mk(r.h5_i,  r.h5_r,  r.h5_w),
        '24h': mk(r.h24_i, r.h24_r, r.h24_w),
      },
      gateway_start_at: gatewayStartAt,
      computed_at: new Date().toISOString(),
    })
  } catch (err) {
    console.error('cache-hit-rate error:', err)
    res.status(500).json({ error: 'Failed to compute cache hit rate' })
  }
})

// GET /api/admin/oauth-accounts/cc-disguise-templates — list CC disguise templates across all accounts
// NOTE: Declared before the /:id catch-all so Express does not treat the literal
// path segment as an account id.
// GET /api/admin/oauth-accounts/:id — detail: account row + 24h trend + error breakdown
router.get('/:id', async (req, res) => {
  try {
    const base = await query(
      `SELECT oa.id, oa.name, oa.account_type, oa.status, oa.health_status, oa.weight,
              oa.max_rpm, oa.max_tpm, oa.max_concurrent, oa.max_sessions,
              oa.max_daily_req, oa.max_daily_tok, oa.max_daily_cost,
              oa.cooldown_seconds, oa.max_retries, oa.models,
              COALESCE(oa.session_ttl_seconds, 0) AS session_ttl_seconds,
              oa.auth_kind, oa.provider, oa.api_base_url, oa.options,
              COALESCE(oa.simulate_fingerprint, TRUE) AS simulate_fingerprint,
              oa.canonical_identity, oa.identity_profile_id, oa.outbound_proxy_id,
              oa.group_id, g.name AS group_name,
              COALESCE(
                (SELECT array_agg(group_id) FROM oauth_account_groups WHERE account_id = oa.id),
                ARRAY[]::uuid[]
              ) AS group_ids,
              oa.total_requests, oa.total_tokens, oa.total_cost,
              oa.expires_at, oa.last_used_at, oa.last_error,
              oa.created_at, oa.updated_at
         FROM oauth_accounts oa
         LEFT JOIN account_groups g ON g.id = oa.group_id
        WHERE oa.id = $1 AND oa.deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    if (base.rows.length === 0) {
      res.status(404).json({ error: 'Account not found' })
      return
    }

    const [trend, errors, recent, costWindows] = await Promise.all([
      query(
        `SELECT date_trunc('hour', created_at) AS bucket,
                COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE block_reason IS NOT NULL OR response_status >= 500)::int AS errors_n,
                COUNT(*) FILTER (WHERE response_status BETWEEN 200 AND 299)::int AS ok_n
           FROM request_logs
          WHERE oauth_account_id = $1
            AND created_at > now() - INTERVAL '24 hours'
          GROUP BY bucket
          ORDER BY bucket`,
        [req.params.id],
      ),
      query(
        `SELECT COALESCE(block_reason, CASE WHEN response_status >= 500 THEN 'http_5xx' ELSE 'other' END) AS reason,
                COUNT(*)::int AS n
           FROM request_logs
          WHERE oauth_account_id = $1
            AND created_at > now() - INTERVAL '24 hours'
            AND (block_reason IS NOT NULL OR response_status >= 500 OR response_status = 429)
          GROUP BY 1
          ORDER BY 2 DESC
          LIMIT 10`,
        [req.params.id],
      ),
      query(
        `SELECT created_at, request_model, response_status, block_reason, block_source,
                streaming, first_token_ms
           FROM request_logs
          WHERE oauth_account_id = $1
            AND (block_reason IS NOT NULL OR response_status >= 400)
          ORDER BY created_at DESC
          LIMIT 20`,
        [req.params.id],
      ),
      // 5h / 7d / 30d 的 cost (计费价 + 官方价) + token + 请求数。
      // 一次扫表三窗口:索引 (oauth_account_id, created_at) + PARTITION BY RANGE(created_at),
      // planner 自动剪裁分区只读涉及月份。
      //
      // cost = 网关计费价 (已乘 group multiplier);cost_official = cost / multiplier 回推官方 1× 价。
      // multiplier=0/NULL 用 NULLIF 保护除零;老数据 multiplier=1 时 official == billed。
      query(
        `WITH base AS (
           SELECT cost, billing_multiplier,
                  (input_tokens + output_tokens + cache_read + cache_write) AS tok,
                  cost / NULLIF(billing_multiplier, 0) AS cost_official,
                  created_at
             FROM usage_records
            WHERE oauth_account_id = $1
              AND created_at > now() - INTERVAL '30 days'
         )
         SELECT
           COALESCE(SUM(cost) FILTER (WHERE created_at > now() - INTERVAL '5 hours'), 0)::numeric AS cost_5h,
           COALESCE(SUM(cost) FILTER (WHERE created_at > now() - INTERVAL '7 days'), 0)::numeric AS cost_7d,
           COALESCE(SUM(cost) FILTER (WHERE created_at > now() - INTERVAL '30 days'), 0)::numeric AS cost_30d,
           COALESCE(SUM(cost_official) FILTER (WHERE created_at > now() - INTERVAL '5 hours'), 0)::numeric AS cost_official_5h,
           COALESCE(SUM(cost_official) FILTER (WHERE created_at > now() - INTERVAL '7 days'), 0)::numeric AS cost_official_7d,
           COALESCE(SUM(cost_official) FILTER (WHERE created_at > now() - INTERVAL '30 days'), 0)::numeric AS cost_official_30d,
           COALESCE(SUM(tok) FILTER (WHERE created_at > now() - INTERVAL '5 hours'), 0)::bigint AS tokens_5h,
           COALESCE(SUM(tok) FILTER (WHERE created_at > now() - INTERVAL '7 days'), 0)::bigint AS tokens_7d,
           COALESCE(SUM(tok) FILTER (WHERE created_at > now() - INTERVAL '30 days'), 0)::bigint AS tokens_30d,
           COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '5 hours')::int AS req_5h,
           COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '7 days')::int AS req_7d,
           COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '30 days')::int AS req_30d
         FROM base`,
        [req.params.id],
      ),
    ])

    const stats = await fetchRedisStats(req.params.id)
    const skipLog = await readSkipLogFromRedis(req.params.id)

    const row = { ...base.rows[0] } as any
    // Scrub any accidentally selected token fields just in case.
    delete row.access_token
    delete row.refresh_token

    const cw = costWindows.rows[0] ?? {}
    const cost_windows = {
      // 计费价 (已乘 group multiplier) — 跟今日费用 / 账单同口径
      cost_5h: parseFloat(cw.cost_5h ?? '0') || 0,
      cost_7d: parseFloat(cw.cost_7d ?? '0') || 0,
      cost_30d: parseFloat(cw.cost_30d ?? '0') || 0,
      // 官方 1× 原价 — 对账 Anthropic 真实开支用
      cost_official_5h: parseFloat(cw.cost_official_5h ?? '0') || 0,
      cost_official_7d: parseFloat(cw.cost_official_7d ?? '0') || 0,
      cost_official_30d: parseFloat(cw.cost_official_30d ?? '0') || 0,
      tokens_5h: Number(cw.tokens_5h ?? 0),
      tokens_7d: Number(cw.tokens_7d ?? 0),
      tokens_30d: Number(cw.tokens_30d ?? 0),
      req_5h: cw.req_5h ?? 0,
      req_7d: cw.req_7d ?? 0,
      req_30d: cw.req_30d ?? 0,
    }

    res.json({
      account: row,
      stats,
      trend: trend.rows,
      errors: errors.rows,
      recent_errors: recent.rows,
      cost_windows,
      // Pool-selection skip events (Redis-backed, not in request_logs).
      // See src/account-pool.ts:recordBlockedReason — consecutive dupes
      // collapse into {count}, stored as LIST(50 max) with 7d TTL.
      skip_log: skipLog,
    })
  } catch (err) {
    console.error('Get oauth account detail error:', err)
    res.status(500).json({ error: 'Failed to load account detail' })
  }
})

// POST /api/admin/oauth-accounts — add new account
router.post('/', async (req, res) => {
  try {
    const {
      name, refresh_token, access_token, expires_at, account_type,
      max_rpm, max_tpm, max_concurrent, max_sessions,
      max_daily_req, max_daily_tok, max_daily_cost,
      weight, models, cooldown_seconds, max_retries,
      session_ttl_seconds,
      identity_profile_id, outbound_proxy_id, canonical_identity,
      group_id, group_ids, cc_template_id,
      options,   // 完整 AccountOptions JSON;缺省由后端用 OAUTH_DEFAULT_OPTIONS_PAYLOAD 兜底
    } = req.body

    if (!name || !refresh_token) {
      res.status(400).json({ error: 'name and refresh_token are required' })
      return
    }

    const templateId = await requireCCTemplate(cc_template_id, res)
    if (!templateId) return

    // Normalize group inputs: prefer group_ids[]; fall back to single group_id.
    const resolvedGroupIds: string[] = Array.isArray(group_ids)
      ? (group_ids as unknown[]).filter((g): g is string => typeof g === 'string' && g.length > 0)
      : (typeof group_id === 'string' && group_id.length > 0 ? [group_id] : [])
    const primaryGroupId: string | null = resolvedGroupIds[0] ?? null

    // If no profile explicitly selected, fall back to the default profile.
    let profileId: string | null = identity_profile_id ?? null
    if (!profileId) {
      const def = await query(`SELECT id FROM identity_profiles WHERE is_default = TRUE LIMIT 1`)
      if (def.rows.length > 0) profileId = def.rows[0].id
    }

    const finalOptions = (options && typeof options === 'object')
      ? options
      : OAUTH_DEFAULT_OPTIONS_PAYLOAD
    const result = await query(
      `INSERT INTO oauth_accounts
         (name, refresh_token, access_token, expires_at, account_type,
          max_rpm, max_tpm, max_concurrent, max_sessions,
          max_daily_req, max_daily_tok, max_daily_cost,
          weight, models, cooldown_seconds, max_retries, session_ttl_seconds,
          identity_profile_id, outbound_proxy_id, canonical_identity,
          group_id, deployment, cc_template_id, options)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       RETURNING *`,
      [
        name, refresh_token, access_token ?? null, expires_at ?? 0,
        account_type ?? 'pro',
        max_rpm ?? 60, max_tpm ?? 80000, max_concurrent ?? 5, max_sessions ?? 0,
        max_daily_req ?? 0, max_daily_tok ?? 0, max_daily_cost ?? 0,
        weight ?? 10, models ?? null, cooldown_seconds ?? 60, max_retries ?? 2,
        session_ttl_seconds ?? 0,
        profileId,
        outbound_proxy_id ?? null,
        canonical_identity ? JSON.stringify(canonical_identity) : null,
        primaryGroupId,
        DEPLOYMENT, templateId,
        JSON.stringify(finalOptions),
      ]
    )
    const account = result.rows[0]

    // Sync many-to-many oauth_account_groups.
    if (resolvedGroupIds.length > 0) {
      for (const gid of resolvedGroupIds) {
        await query(
          `INSERT INTO oauth_account_groups (account_id, group_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [account.id, gid],
        )
      }
    }

    await audit(req, {
      action: 'account.create',
      resource_type: 'account',
      resource_id: account.id,
      before: null,
      after: { ...account, group_ids: resolvedGroupIds }, // audit.sanitize strips refresh_token / access_token
      summary: `oauth account ${account.name} created`,
    })
    await notifyReload()
    res.json({ ...account, group_ids: resolvedGroupIds })
  } catch (err) {
    console.error('Create oauth account error:', err)
    res.status(500).json({ error: 'Failed to create account' })
  }
})

// PATCH /api/admin/oauth-accounts/:id — update account
router.patch('/:id', async (req, res) => {
  try {
    const fields: string[] = []
    const params: any[] = []
    let idx = 1
    const allowed = [
      'name', 'refresh_token', 'status', 'account_type',
      'max_rpm', 'max_tpm', 'max_concurrent', 'max_sessions',
      'max_daily_req', 'max_daily_tok', 'max_daily_cost',
      'weight', 'models', 'cooldown_seconds', 'max_retries',
      'session_ttl_seconds',
      'identity_profile_id', 'outbound_proxy_id',
    ]
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = $${idx++}`)
        params.push(req.body[key])
      }
    }
    // options JSONB:整体替换;校验:所有 known keys 都存在(浅校验,完整 zod
    // 校验在前端 + admin schema)
    if (req.body.options !== undefined && req.body.options !== null && typeof req.body.options === 'object') {
      fields.push(`options = $${idx++}`)
      params.push(JSON.stringify(req.body.options))
    }
    if (req.body.canonical_identity !== undefined) {
      fields.push(`canonical_identity = $${idx++}`)
      params.push(req.body.canonical_identity ? JSON.stringify(req.body.canonical_identity) : null)
    }

    // Normalize group changes: group_ids[] wins, group_id is back-compat.
    let nextGroupIds: string[] | null = null
    if (Array.isArray(req.body.group_ids)) {
      nextGroupIds = (req.body.group_ids as unknown[]).filter(
        (g): g is string => typeof g === 'string' && g.length > 0,
      )
    } else if (req.body.group_id !== undefined) {
      if (req.body.group_id === null || req.body.group_id === '') {
        nextGroupIds = []
      } else if (typeof req.body.group_id === 'string') {
        nextGroupIds = [req.body.group_id]
      }
    }
    if (nextGroupIds !== null) {
      // Keep oauth_accounts.group_id as primary (first) for compat display.
      fields.push(`group_id = $${idx++}`)
      params.push(nextGroupIds[0] ?? null)
    }

    if (fields.length === 0) {
      res.status(400).json({ error: 'Nothing to update' })
      return
    }
    const beforeRes = await query(
      `SELECT * FROM oauth_accounts WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    const before = beforeRes.rows[0] ?? null
    fields.push(`updated_at = now()`)
    params.push(req.params.id)
    params.push(DEPLOYMENT)
    const deploymentIdx = idx + 1
    const result = await query(
      `UPDATE oauth_accounts SET ${fields.join(', ')} WHERE id = $${idx} AND deployment = $${deploymentIdx} RETURNING *`,
      params,
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Account not found' })
      return
    }
    const after = result.rows[0]

    // Rewrite many-to-many mapping if caller passed group_ids/group_id.
    if (nextGroupIds !== null) {
      await query(`DELETE FROM oauth_account_groups WHERE account_id = $1`, [after.id])
      for (const gid of nextGroupIds) {
        await query(
          `INSERT INTO oauth_account_groups (account_id, group_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [after.id, gid],
        )
      }
      ;(after as any).group_ids = nextGroupIds
    }
    // Derive action from status transition for clarity.
    let action = 'account.update'
    if (req.body.status !== undefined && before && req.body.status !== before.status) {
      action = req.body.status === 'disabled' ? 'account.disable' : 'account.enable'
    }
    await audit(req, {
      action,
      resource_type: 'account',
      resource_id: after.id,
      before,
      after,
      summary: `account ${after.name} ${action.split('.')[1]}`,
    })
    await notifyReload()
    res.json(after)
  } catch (err) {
    console.error('Update oauth account error:', err)
    res.status(500).json({ error: 'Failed to update account' })
  }
})

// DELETE /api/admin/oauth-accounts/:id — delete (with draining)
router.delete('/:id', async (req, res) => {
  try {
    const beforeRes = await query(
      `SELECT id, name, account_type, status , banned_at FROM oauth_accounts WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    const before = beforeRes.rows[0] ?? null
    // Soft-drain first: mark as disabled
    await query(`UPDATE oauth_accounts SET status = 'disabled', updated_at = now() WHERE id = $1 AND deployment = $2`, [req.params.id, DEPLOYMENT])

    // Cleanup Redis state
    const redis = getRedis()
    if (redis) {
      await Promise.all([
        redis.del(`concurrent:${req.params.id}`),
        redis.del(`rpm:${req.params.id}`),
        redis.del(`tpm:${req.params.id}`),
        redis.del(`sessions:${req.params.id}`),
        redis.del(`cooldown:${req.params.id}`),
        redis.del(`errors:${req.params.id}`),
      ]).catch(() => {})
    }

    // Remember the bound proxy before deleting (for orphan cleanup)
    const proxyIdResult = await query(
      `SELECT outbound_proxy_id FROM oauth_accounts WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    const boundProxyId = proxyIdResult.rows[0]?.outbound_proxy_id ?? null

    // Hard delete
    const result = await query(`DELETE FROM oauth_accounts WHERE id = $1 AND deployment = $2 RETURNING id`, [req.params.id, DEPLOYMENT])
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Account not found' })
      return
    }

    // Orphan-proxy cleanup: if the bound proxy is no longer referenced by any
    // account, delete it from outbound_proxies too. This keeps the proxy pool
    // clean when accounts are removed.
    if (boundProxyId) {
      const refCount = await query(
        `SELECT COUNT(*)::int AS n FROM oauth_accounts WHERE outbound_proxy_id = $1`,
        [boundProxyId],
      )
      if ((refCount.rows[0]?.n ?? 0) === 0) {
        await query(`DELETE FROM outbound_proxies WHERE id = $1`, [boundProxyId])
        console.log(`[delete-account] cascade-deleted orphan proxy ${boundProxyId}`)
      }
    }
    await audit(req, {
      action: 'account.delete',
      resource_type: 'account',
      resource_id: req.params.id,
      before,
      after: null,
      summary: `oauth account ${before?.name ?? req.params.id} deleted`,
    })
    await notifyReload()
    res.json({ ok: true, id: result.rows[0].id })
  } catch (err) {
    console.error('Delete oauth account error:', err)
    res.status(500).json({ error: 'Failed to delete account' })
  }
})

// GET /api/admin/oauth-accounts/:id/sessions — list sessions for account
router.get('/:id/sessions', async (req, res) => {
  try {
    const redis = getRedis()
    if (!redis) {
      res.json({ sessions: [] })
      return
    }
    const keys = await redis.smembers(`sessions:${req.params.id}`)
    const sessions = await Promise.all(keys.map(async (key) => {
      const data = await redis.get(key)
      if (!data) return null
      try {
        const parsed = JSON.parse(data)
        return { key, ...parsed }
      } catch {
        return { key }
      }
    }))
    res.json({ sessions: sessions.filter(Boolean) })
  } catch (err) {
    console.error('List sessions error:', err)
    res.status(500).json({ error: 'Failed to list sessions' })
  }
})

// GET /api/admin/oauth-accounts/:id/session-slots — list session slots and history
router.get('/:id/session-slots', async (req, res) => {
  const { id } = req.params
  try {
    const acctResult = await query(
      'SELECT max_sessions FROM oauth_accounts WHERE id = $1 AND deployment = $2', [id, DEPLOYMENT]
    )
    if (acctResult.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }
    const maxSessions = acctResult.rows[0].max_sessions

    const slotsResult = await query(
      `SELECT slot_index, derived_session_id, bound_keys, reuse_count, last_used_at, created_at
       FROM session_slots WHERE account_id = $1 ORDER BY slot_index`,
      [id]
    )

    const historyResult = await query(
      `SELECT slot_index, action, client_name, evicted_client, idle_duration_ms, reuse_number, created_at
       FROM session_slot_history WHERE account_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [id]
    )

    const slots = slotsResult.rows.map((r: any) => ({
      slot_index: r.slot_index,
      derived_session_id: r.derived_session_id,
      bound_clients: r.bound_keys || [],
      reuse_count: r.reuse_count,
      last_used_at: r.last_used_at,
      created_at: r.created_at,
      status: (Date.now() - new Date(r.last_used_at).getTime()) < 300_000 ? 'active' : 'idle',
    }))

    res.json({ max_sessions: maxSessions, slots, history: historyResult.rows })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/admin/oauth-accounts/:id/disguise-status — template bound to this account (from DB)
router.get('/:id/disguise-status', async (req, res) => {
  const { id } = req.params
  try {
    const result = await query(
      `SELECT oa.cc_template_id,
              t.name, t.description, t.source, t.source_ua, t.tools, t.system_blocks,
              t.updated_at
         FROM oauth_accounts oa
         LEFT JOIN cc_disguise_templates t ON t.id = oa.cc_template_id
        WHERE oa.id = $1 AND oa.deployment = $2`,
      [id, DEPLOYMENT],
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }
    const row = result.rows[0]
    if (!row.cc_template_id) {
      return res.json({ status: 'not_learned', using_defaults: true })
    }

    const tools: any[] = Array.isArray(row.tools) ? row.tools : []
    const systemBlocks: any[] = Array.isArray(row.system_blocks) ? row.system_blocks : []
    return res.json({
      status: 'learned',
      template_id: row.cc_template_id,
      template_name: row.name,
      template_description: row.description,
      template_source: row.source,
      source_ua: row.source_ua,
      learned_at: row.updated_at ? new Date(row.updated_at).getTime() : null,
      tools_count: tools.length,
      tool_names: tools.map((t: any) => t?.name ?? t).filter(Boolean),
      system_blocks_count: systemBlocks.length,
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/admin/oauth-accounts/:id/cc-template — bind account to a specific template
router.put('/:id/cc-template', async (req, res) => {
  const { id } = req.params
  const templateId = req.body?.template_id
  try {
    if (!templateId || typeof templateId !== 'string') {
      res.status(400).json({ error: 'template_id required' })
      return
    }
    const tpl = await query(
      `SELECT id, name FROM cc_disguise_templates WHERE id = $1 AND deployment = $2`,
      [templateId, DEPLOYMENT],
    )
    if (tpl.rows.length === 0) {
      res.status(404).json({ error: 'Template not found' })
      return
    }
    const acct = await query(
      `UPDATE oauth_accounts SET cc_template_id = $1 WHERE id = $2 AND deployment = $3 RETURNING id, name`,
      [templateId, id, DEPLOYMENT],
    )
    if (acct.rows.length === 0) {
      res.status(404).json({ error: 'Account not found' })
      return
    }
    await notifyReload()
    res.json({ bound: true, template_id: templateId, template_name: tpl.rows[0].name })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/admin/oauth-accounts/:id/disguise-template — unbind account from its template
// (does NOT delete the template row; next CC request will auto-learn a new one).
router.delete('/:id/disguise-template', async (req, res) => {
  const { id } = req.params
  try {
    const result = await query(
      `UPDATE oauth_accounts SET cc_template_id = NULL
        WHERE id = $1 AND deployment = $2 AND cc_template_id IS NOT NULL
        RETURNING id`,
      [id, DEPLOYMENT],
    )
    const cleared = result.rows.length > 0
    if (cleared) await notifyReload()
    return res.json({ cleared })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/admin/oauth-accounts/:id/sessions/:sessionKey — terminate a specific session
router.delete('/:id/sessions/:sessionKey', async (req, res) => {
  try {
    const redis = getRedis()
    if (!redis) {
      res.status(503).json({ error: 'Redis not available' })
      return
    }
    const sessionKey = req.params.sessionKey  // e.g. "sess:abc123" or "sess:client:xyz"
    await Promise.all([
      redis.del(sessionKey),
      redis.srem(`sessions:${req.params.id}`, sessionKey),
    ])
    res.json({ ok: true })
  } catch (err) {
    console.error('Delete session error:', err)
    res.status(500).json({ error: 'Failed to delete session' })
  }
})

// POST /api/admin/oauth-accounts/:id/reveal-credentials — return full credentials with audit log.
// Used by admin "凭据" tab in account drawer. Each call writes an audit_logs row so
// access is traceable (who, when, which account).
router.post('/:id/reveal-credentials', async (req, res) => {
  try {
    const r = await query(
      `SELECT a.id, a.name, a.refresh_token, a.access_token, a.source_session_key,
              a.source_proxy_id_at_import, a.outbound_proxy_id, a.created_at, a.expires_at,
              p1.scheme AS import_scheme, p1.host AS import_host, p1.port AS import_port,
              p1.username AS import_username,
              p2.scheme AS current_scheme, p2.host AS current_host, p2.port AS current_port,
              p2.username AS current_username
         FROM oauth_accounts a
         LEFT JOIN outbound_proxies p1 ON p1.id = a.source_proxy_id_at_import
         LEFT JOIN outbound_proxies p2 ON p2.id = a.outbound_proxy_id
        WHERE a.id = $1 AND a.deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    if (r.rows.length === 0) {
      res.status(404).json({ error: 'Account not found' })
      return
    }
    const row = r.rows[0]
    const buildUrl = (scheme: string | null, host: string | null, port: number | null, user: string | null): string | null => {
      if (!scheme || !host || !port) return null
      const auth = user ? `${user}:***@` : ''
      return `${scheme}://${auth}${host}:${port}`
    }

    await audit(req, {
      action: 'account.reveal_credentials',
      resource_type: 'account',
      resource_id: row.id,
      before: null,
      after: { id: row.id, name: row.name },
      summary: `admin revealed credentials for account ${row.name}`,
    })

    res.json({
      id: row.id,
      name: row.name,
      source_session_key: row.source_session_key ?? null,
      refresh_token: row.refresh_token ?? null,
      access_token: row.access_token ?? null,
      expires_at: row.expires_at ? Number(row.expires_at) : null,
      created_at: row.created_at,
      source_proxy_at_import: buildUrl(row.import_scheme, row.import_host, row.import_port, row.import_username),
      current_proxy: buildUrl(row.current_scheme, row.current_host, row.current_port, row.current_username),
    })
  } catch (err) {
    console.error('Reveal credentials error:', err)
    res.status(500).json({ error: 'Failed to reveal credentials' })
  }
})

// POST /api/admin/oauth-accounts/:id/refresh — force token refresh
router.post('/:id/refresh', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, refresh_token, outbound_proxy_id FROM oauth_accounts WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Account not found' })
      return
    }
    const account = result.rows[0]

    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: account.refresh_token,
      client_id: CLIENT_ID,
      scope: SCOPES.join(' '),
    })

    const url = new URL(TOKEN_URL)
    const tokenResp = await requestExternal(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
      body,
      timeoutMs: 15_000,
      proxyId: account.outbound_proxy_id ?? null,
    })
    const tokenResult = tokenResp.text ? JSON.parse(tokenResp.text) : {}

    if (tokenResult.access_token) {
      const expiresAt = Date.now() + (tokenResult.expires_in ?? 3600) * 1000
      const newRefresh = tokenResult.refresh_token ?? account.refresh_token
      // 重置 status='active' + 清 last_error:手动 refresh 成功意味着账号本质可用,
      // 之前因为 refresh race 等被错误标 'error' 的状态应该自动恢复,不用运维再点一次启用。
      await query(
        `UPDATE oauth_accounts SET access_token = $1, expires_at = $2, refresh_token = $3,
         health_status = 'healthy', status = 'active', last_error = NULL, updated_at = now()
         WHERE id = $4 AND deployment = $5`,
        [tokenResult.access_token, expiresAt, newRefresh, account.id, DEPLOYMENT],
      )
      await audit(req, {
        action: 'account.reset_token',
        resource_type: 'account',
        resource_id: account.id,
        before: null,
        after: { id: account.id, name: account.name, expires_at: expiresAt },
        summary: `account ${account.name} token refreshed`,
      })
      res.json({ ok: true, expires_at: expiresAt })
    } else {
      await query(
        `UPDATE oauth_accounts SET health_status = 'failed', last_error = $1, updated_at = now() WHERE id = $2 AND deployment = $3`,
        [JSON.stringify(tokenResult).slice(0, 500), account.id, DEPLOYMENT],
      )
      res.status(502).json({ error: 'Token refresh failed', detail: tokenResult })
    }
  } catch (err) {
    console.error('Refresh token error:', err)
    res.status(500).json({ error: 'Failed to refresh token' })
  }
})

// POST /api/admin/oauth-accounts/:id/refresh-usage — manually refresh /api/oauth/usage cache
router.post('/:id/refresh-usage', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, access_token, outbound_proxy_id FROM oauth_accounts WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Account not found' })
      return
    }
    const account = result.rows[0]
    if (!account.access_token) {
      res.status(400).json({ error: 'Account has no access token; refresh token first' })
      return
    }

    const url = new URL(USAGE_URL)
    const usageResp = await requestExternal(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${account.access_token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'claude-code/2.1.90',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      timeoutMs: 10_000,
      proxyId: account.outbound_proxy_id ?? null,
    })

    if (usageResp.statusCode !== 200) {
      let detail: any = usageResp.text
      try { detail = usageResp.text ? JSON.parse(usageResp.text) : null } catch {}
      res.status(usageResp.statusCode).json({ error: 'Usage refresh failed', detail })
      return
    }

    let parsed: any = null
    try {
      parsed = usageResp.text ? JSON.parse(usageResp.text) : null
    } catch {
      parsed = null
    }
    if (!parsed) {
      res.status(502).json({ error: 'Usage refresh failed', detail: 'Invalid JSON response' })
      return
    }

    const redis = getRedis()
    if (!redis) {
      res.status(503).json({ error: 'Redis not available' })
      return
    }
    await Promise.all([
      redis.set(`claude_utilization:${account.id}`, JSON.stringify(parsed), 'EX', 600),
      redis.set(`claude_utilization:${account.id}:updated_at`, new Date().toISOString(), 'EX', 600),
    ])

    res.json({ ok: true, utilization: parsed })
  } catch (err) {
    console.error('Refresh usage error:', err)
    res.status(500).json({ error: 'Failed to refresh usage' })
  }
})

// POST /api/admin/oauth-accounts/:id/clear-error — 只清错误状态,不动费用 / 流量统计
//
// 历史问题:之前同时清 daily_req / daily_tok / daily_cost / rpm / tpm / concurrent,
// 导致 UI 上今天累计的请求 / token / 费用归零,运营查账时数据消失。
// 新策略:只清"标识账号有问题"的字段:
//   - DB: status / health_status / last_error
//   - Redis: cooldown:* (强制下线) + errors:* (失败计数器,触发自动冷却)
// 不动 daily_* (cost / req / tok 等业务统计) 和 rpm/tpm/concurrent (60s 窗口自然过期)。
router.post('/:id/clear-error', async (req, res) => {
  try {
    const result = await query(
      `UPDATE oauth_accounts
          SET status = 'active',
              health_status = 'unknown',
              last_error = NULL,
              updated_at = now()
        WHERE id = $1 AND deployment = $2
        RETURNING id, name`,
      [req.params.id, DEPLOYMENT],
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Account not found' })
      return
    }

    const redis = getRedis()
    if (redis) {
      await Promise.all([
        redis.del(`cooldown:${req.params.id}`),
        redis.del(`errors:${req.params.id}`),
      ]).catch(() => {})
    }

    res.json({ ok: true, account: result.rows[0] })
  } catch (err) {
    console.error('Clear error state failed:', err)
    res.status(500).json({ error: 'Failed to clear error state' })
  }
})

// POST /api/admin/oauth-accounts/:id/pull-identity — fetch real email + account_uuid via OAuth profile API
router.post('/:id/pull-identity', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, access_token, expires_at, canonical_identity, outbound_proxy_id FROM oauth_accounts WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Account not found' })
      return
    }
    const account = result.rows[0]
    if (!account.access_token) {
      res.status(400).json({ error: 'Account has no access_token — refresh first' })
      return
    }

    const profileResp = await requestExternal('https://api.anthropic.com/api/oauth/profile', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${account.access_token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      },
      timeoutMs: 15_000,
      proxyId: account.outbound_proxy_id ?? null,
    })
    if (profileResp.statusCode >= 400) {
      throw new Error(`oauth/profile HTTP ${profileResp.statusCode}: ${profileResp.text.slice(0, 200)}`)
    }
    const profile = profileResp.text ? JSON.parse(profileResp.text) : {}

    const accountUuid = profile?.account?.uuid
    const email = profile?.account?.email
    const organizationUuid = profile?.organization?.uuid ?? null
    if (!accountUuid || !email) {
      res.status(502).json({ error: 'OAuth profile response missing account.uuid or account.email', profile })
      return
    }

    // Preserve an existing device_id if set; otherwise generate a fresh 64-hex one.
    const existingId = account.canonical_identity
      ? (typeof account.canonical_identity === 'string'
          ? JSON.parse(account.canonical_identity)
          : account.canonical_identity)
      : null
    const deviceId = existingId?.device_id ?? randomBytes(32).toString('hex')

    const canonicalIdentity = {
      device_id: deviceId,
      email,
      account_uuid: accountUuid,
    }

    await query(
      `UPDATE oauth_accounts
          SET canonical_identity = $1,
              organization_uuid = $2,
              account_uuid = $3,
              updated_at = now()
        WHERE id = $4 AND deployment = $5`,
      [JSON.stringify(canonicalIdentity), organizationUuid, accountUuid, account.id, DEPLOYMENT],
    )
    await notifyReload()

    res.json({ ok: true, canonical_identity: canonicalIdentity, organization_uuid: organizationUuid, profile })
  } catch (err) {
    console.error('Pull identity error:', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to pull identity' })
  }
})

// POST /api/admin/oauth-accounts/:id/test — run a gateway-routed request forced to a specific account
router.post('/:id/test', async (req, res) => {
  try {
    const accountResult = await query(
      `SELECT id, name, account_type, status, models
         FROM oauth_accounts
        WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    if (accountResult.rows.length === 0) {
      res.status(404).json({ error: 'Account not found' })
      return
    }

    const account = accountResult.rows[0]
    if (account.status === 'disabled') {
      res.json({
        ok: false,
        error: 'Account is disabled',
        account: { id: account.id, name: account.name },
      })
      return
    }

    const clientToken = await getSystemClientToken()
    if (!clientToken) {
      res.status(500).json({ error: 'No active system client token available for gateway tests' })
      return
    }

    const model = Array.isArray(account.models) && account.models.length > 0
      ? account.models[0]
      : 'claude-sonnet-4-6'
    const sessionId = `admin-test-${randomUUID()}`
    const gatewayBaseUrl = (process.env.GATEWAY_INTERNAL_URL ?? 'https://127.0.0.1:8443').replace(/\/+$/, '')
    const requestBody = {
      model,
      max_tokens: 1024,
      stream: false,
      // Anthropic OAuth gates the API behind a Claude Code system prompt;
      // requests without it return 429 rate_limit_error (anti-abuse, not real quota).
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      metadata: {
        user_id: `user_admin_test_account__session_${sessionId}`,
      },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Reply with exactly OK.' },
          ],
        },
      ],
    }

    const startedAt = Date.now()
    const response = await fetch(`${gatewayBaseUrl}/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'claude-cli/2.1.90 (external, cli)',
        'x-api-key': clientToken,
        'x-app': 'cli',
        'x-claude-code-session-id': sessionId,
        'x-ccg-force-account-id': account.id,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219,prompt-caching-scope-2026-01-05',
        'x-stainless-lang': 'js',
        'x-stainless-runtime': 'node',
        'x-stainless-runtime-version': process.version,
        'x-stainless-os': process.platform,
        'x-stainless-arch': process.arch,
        'x-stainless-package-version': '0.74.0',
        'x-stainless-timeout': '30',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30_000),
    })

    const latencyMs = Date.now() - startedAt
    const rawText = await response.text()
    let parsed: any = null
    try {
      parsed = rawText ? JSON.parse(rawText) : null
    } catch {
      parsed = null
    }

    const selectedAccountId = response.headers.get('x-ccg-selected-account-id')
    const selectedAccountName = response.headers.get('x-ccg-selected-account-name')
    const selectionMode = response.headers.get('x-ccg-selection-mode')
    const preview = parsed ? extractTextPreview(parsed) : rawText.slice(0, 500)
    const forcedMatch = selectedAccountId === account.id
    const errorText = response.ok
      ? null
      : extractTextPreview(parsed?.error ?? parsed ?? `HTTP ${response.status}`) || `HTTP ${response.status}`

    res.json({
      ok: response.ok && forcedMatch,
      account: { id: account.id, name: account.name },
      gateway_status: response.status,
      latency_ms: latencyMs,
      model,
      selected_account_id: selectedAccountId,
      selected_account_name: selectedAccountName,
      selection_mode: selectionMode,
      forced_match: forcedMatch,
      preview,
      raw_excerpt: rawText.slice(0, 1000),
      error: errorText,
    })
  } catch (err: any) {
    console.error('Test oauth account error:', err)
    res.status(500).json({ error: 'Failed to test account', detail: err.message })
  }
})

// POST /api/admin/oauth-accounts/auth-url — build PKCE authorization URL + stash verifier in Redis
router.post('/auth-url', async (req, res) => {
  try {
    const { outbound_proxy_id, name } = req.body ?? {}
    const state = randomBytes(16).toString('hex')
    const verifier = b64url(randomBytes(32))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    const url = new URL(AUTHORIZE_URL)
    url.searchParams.set('code', 'true')
    url.searchParams.set('client_id', CLIENT_ID)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', MANUAL_REDIRECT_URL)
    url.searchParams.set('scope', SCOPES.join(' '))
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', state)

    const redis = getRedis()
    const pending: PendingOAuth = {
      state,
      codeVerifier: verifier,
      outboundProxyId: outbound_proxy_id ?? null,
      name: name ?? null,
      createdAt: Date.now(),
    }
    if (redis) {
      await redis.set(`oauth_pending:${state}`, JSON.stringify(pending), 'EX', 600)
    }
    res.json({ url: url.toString(), state, expires_in: 600 })
  } catch (err) {
    console.error('auth-url error:', err)
    res.status(500).json({ error: 'Failed to build authorization URL' })
  }
})

// POST /api/admin/oauth-accounts/exchange — exchange authorization code#state for tokens
router.post('/exchange', async (req, res) => {
  try {
    const {
      code, name, cc_template_id,
      account_type, max_rpm, max_tpm, max_concurrent, max_sessions,
      max_daily_req, max_daily_tok, max_daily_cost,
      weight, cooldown_seconds, max_retries,
      session_ttl_seconds,
      group_ids,
    } = req.body ?? {}
    const policy: PolicyInput = {
      account_type, max_rpm, max_tpm, max_concurrent, max_sessions,
      max_daily_req, max_daily_tok, max_daily_cost,
      weight, cooldown_seconds, max_retries,
      session_ttl_seconds, group_ids,
    }
    if (typeof code !== 'string' || !code.includes('#')) {
      res.status(400).json({ error: 'code must be "<code>#<state>"' })
      return
    }
    const ccTemplateId = await requireCCTemplate(cc_template_id, res)
    if (!ccTemplateId) return
    const [codeValue, state] = code.split('#')
    if (!codeValue || !state) {
      res.status(400).json({ error: 'invalid code#state payload' })
      return
    }
    const redis = getRedis()
    if (!redis) {
      res.status(503).json({ error: 'Redis unavailable; cannot resolve pending OAuth state' })
      return
    }
    const raw = await redis.get(`oauth_pending:${state}`)
    if (!raw) {
      res.status(400).json({ error: 'state expired or unknown; restart authorization' })
      return
    }
    const pending: PendingOAuth = JSON.parse(raw)

    const body = JSON.stringify({
      grant_type: 'authorization_code',
      code: codeValue,
      state,
      redirect_uri: MANUAL_REDIRECT_URL,
      code_verifier: pending.codeVerifier,
      client_id: CLIENT_ID,
    })
    const tokenResp = await requestExternal(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) },
      body,
      timeoutMs: 15_000,
      proxyId: pending.outboundProxyId,
    })
    const parsed = tokenResp.text ? JSON.parse(tokenResp.text) : {}
    if (tokenResp.statusCode !== 200 || !parsed.access_token || !parsed.refresh_token) {
      res.status(502).json({ error: 'Token exchange failed', detail: parsed })
      return
    }
    const accessToken = parsed.access_token as string
    const refreshToken = parsed.refresh_token as string
    const expiresAt = Date.now() + (parsed.expires_in ?? 3600) * 1000

    // Name fallback: body > pending > email prefix > uuid prefix > random hex.
    // finalizeOAuthAccount fetches the profile internally, so we pre-fetch
    // here to resolve email before insert (avoids an UPDATE on rename).
    const placeholderName = name ?? pending.name ?? `oauth-${randomBytes(4).toString('hex')}`
    const finalized = await finalizeOAuthAccount({
      name: placeholderName,
      refreshToken,
      accessToken,
      expiresAt,
      outboundProxyId: pending.outboundProxyId,
      ccTemplateId,
      policy,
    })

    if (!name && !pending.name) {
      let resolved: string | null = null
      if (finalized.email) {
        const prefix = finalized.email.split('@')[0]
        if (prefix) resolved = prefix
      }
      if (!resolved && finalized.accountUuid) {
        resolved = `oauth-${finalized.accountUuid.slice(0, 8)}`
      }
      if (resolved) {
        await query(
          `UPDATE oauth_accounts SET name = $1 WHERE id = $2 AND deployment = $3`,
          [resolved, finalized.id, DEPLOYMENT],
        ).catch(() => {})
      }
    }

    await redis.del(`oauth_pending:${state}`)
    await notifyReload()

    await audit(req, {
      action: 'account.create',
      resource_type: 'account',
      resource_id: finalized.id,
      before: null,
      after: { id: finalized.id, email: finalized.email, account_uuid: finalized.accountUuid, auth_kind: 'oauth' },
      summary: `oauth account ${finalized.email ?? finalized.id} created via PKCE exchange`,
    })

    res.json({ id: finalized.id, email: finalized.email, account_uuid: finalized.accountUuid })
  } catch (err) {
    console.error('exchange error:', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to exchange code' })
  }
})

// POST /api/admin/oauth-accounts/import-rt — import an existing refresh_token (+ optional access_token)
router.post('/import-rt', async (req, res) => {
  try {
    const {
      name, refresh_token, access_token, outbound_proxy_id, cc_template_id,
      account_type, max_rpm, max_tpm, max_concurrent, max_sessions,
      max_daily_req, max_daily_tok, max_daily_cost,
      weight, cooldown_seconds, max_retries,
      session_ttl_seconds,
      group_ids,
    } = req.body ?? {}
    const policy: PolicyInput = {
      account_type, max_rpm, max_tpm, max_concurrent, max_sessions,
      max_daily_req, max_daily_tok, max_daily_cost,
      weight, cooldown_seconds, max_retries,
      session_ttl_seconds, group_ids,
    }
    if (typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'name is required' })
      return
    }
    if (typeof refresh_token !== 'string' || refresh_token.trim().length === 0) {
      res.status(400).json({ error: 'refresh_token is required' })
      return
    }
    const ccTemplateId = await requireCCTemplate(cc_template_id, res)
    if (!ccTemplateId) return
    const outboundProxyId: string | null = outbound_proxy_id ?? null
    let accessToken: string
    let expiresAt: number
    let refreshTokenFinal: string = refresh_token
    if (typeof access_token === 'string' && access_token.length > 0) {
      accessToken = access_token
      expiresAt = Date.now() + 3600_000
    } else {
      const exchanged = await exchangeRefreshToken(refresh_token, outboundProxyId)
      accessToken = exchanged.accessToken
      expiresAt = exchanged.expiresAt
      refreshTokenFinal = exchanged.refreshToken
    }

    const finalized = await finalizeOAuthAccount({
      name,
      refreshToken: refreshTokenFinal,
      accessToken,
      expiresAt,
      outboundProxyId,
      ccTemplateId,
      policy,
    })

    await audit(req, {
      action: 'account.create',
      resource_type: 'account',
      resource_id: finalized.id,
      before: null,
      after: { id: finalized.id, email: finalized.email, account_uuid: finalized.accountUuid, auth_kind: 'oauth' },
      summary: `oauth account ${name} imported via refresh_token`,
    })

    await notifyReload()
    res.json({ id: finalized.id, email: finalized.email, account_uuid: finalized.accountUuid })
  } catch (err) {
    console.error('import-rt error:', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to import refresh token' })
  }
})

// POST /api/admin/oauth-accounts/api-key — add a static API-key backed account (no OAuth)
router.post('/api-key', async (req, res) => {
  try {
    const {
      name, provider, api_base_url, api_key, simulate_fingerprint, outbound_proxy_id,
      account_type, max_rpm, max_tpm, max_concurrent, max_sessions,
      max_daily_req, max_daily_tok, max_daily_cost,
      weight, cooldown_seconds, max_retries,
      session_ttl_seconds,
      group_ids,
      options,   // 完整 AccountOptions JSON;缺省由后端用 APIKEY_DEFAULT_OPTIONS_PAYLOAD 兜底
    } = req.body ?? {}
    if (typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'name is required' })
      return
    }
    if (provider !== 'anthropic' && provider !== 'openai') {
      res.status(400).json({ error: 'provider must be "anthropic" or "openai"' })
      return
    }
    if (typeof api_base_url !== 'string' || api_base_url.trim().length === 0) {
      res.status(400).json({ error: 'api_base_url is required' })
      return
    }
    if (typeof api_key !== 'string' || api_key.trim().length === 0) {
      res.status(400).json({ error: 'api_key is required' })
      return
    }

    const def = await query('SELECT id FROM identity_profiles WHERE is_default = TRUE LIMIT 1')
    const profileId = def.rows[0]?.id ?? null

    const groupIds = normalizeGroupIds(group_ids)
    const primaryGroupId = groupIds[0] ?? null

    const finalOptions = (options && typeof options === 'object')
      ? options
      : APIKEY_DEFAULT_OPTIONS_PAYLOAD
    const inserted = await query(
      `INSERT INTO oauth_accounts
         (name, auth_kind, provider, api_key, api_base_url,
          simulate_fingerprint, account_type,
          max_rpm, max_tpm, max_concurrent, max_sessions,
          max_daily_req, max_daily_tok, max_daily_cost,
          weight, cooldown_seconds, max_retries, session_ttl_seconds,
          identity_profile_id, outbound_proxy_id, group_id, deployment,
          refresh_token, options)
       VALUES ($1,'api_key',$2,$3,$4,$5,$6,
               $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
               $18,$19,$20,$21,
               NULL,$22)
       RETURNING id`,
      [
        name, provider, api_key, api_base_url,
        simulate_fingerprint === true,
        account_type ?? 'pro',
        max_rpm ?? 60, max_tpm ?? 80000, max_concurrent ?? 5, max_sessions ?? 0,
        max_daily_req ?? 0, max_daily_tok ?? 0, max_daily_cost ?? 0,
        weight ?? 10, cooldown_seconds ?? 60, max_retries ?? 2,
        session_ttl_seconds ?? 0,
        profileId,
        outbound_proxy_id ?? null,
        primaryGroupId,
        DEPLOYMENT,
        JSON.stringify(finalOptions),
      ],
    )
    const accountId: string = inserted.rows[0].id
    await syncGroupLinks(accountId, groupIds)

    await audit(req, {
      action: 'account.create',
      resource_type: 'account',
      resource_id: accountId,
      before: null,
      after: {
        id: accountId,
        name,
        auth_kind: 'api_key',
        provider,
        api_base_url,
        simulate_fingerprint: simulate_fingerprint === true,
        options: finalOptions,
      },
      summary: `api_key account ${name} (${provider}) created`,
    })

    await notifyReload()
    res.json({ id: accountId, name })
  } catch (err) {
    console.error('api-key error:', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create api_key account' })
  }
})

export { router as oauthAccountsRouter }

// ── CK (sessionKey) Import: self-hosted PKCE flow ─────────────────────────
// POST /api/admin/oauth-accounts/import-by-session-key
router.post('/import-by-session-key', async (req, res) => {
  try {
    const {
      session_key, name, cc_template_id, outbound_proxy_id, group_ids,
      step1_proxy_url,
    } = req.body ?? {}
    if (!session_key || typeof session_key !== 'string') {
      res.status(400).json({ error: 'session_key required' })
      return
    }

    let templateId: string | null = cc_template_id ?? null
    if (!templateId) {
      const def = await query(
        `SELECT id FROM cc_disguise_templates WHERE deployment = $1 AND is_default = TRUE LIMIT 1`,
        [DEPLOYMENT]
      )
      if (def.rows.length > 0) templateId = def.rows[0].id
    }
    if (!templateId) {
      res.status(400).json({ error: 'cc_template_id is required (or set a default template)' })
      return
    }

    const p = req.body ?? {}
    const policy = {
      account_type: typeof p.account_type === 'string' && p.account_type.trim() ? p.account_type.trim() : 'pro',
      max_rpm: Number.isFinite(Number(p.max_rpm)) ? Number(p.max_rpm) : 60,
      max_tpm: Number.isFinite(Number(p.max_tpm)) ? Number(p.max_tpm) : 80000,
      max_concurrent: Number.isFinite(Number(p.max_concurrent)) ? Number(p.max_concurrent) : 5,
      max_sessions: Number.isFinite(Number(p.max_sessions)) ? Number(p.max_sessions) : 0,
      session_ttl_seconds: Number.isFinite(Number(p.session_ttl_seconds)) ? Number(p.session_ttl_seconds) : 0,
      cooldown_seconds: Number.isFinite(Number(p.cooldown_seconds)) ? Number(p.cooldown_seconds) : 60,
      max_retries: Number.isFinite(Number(p.max_retries)) ? Number(p.max_retries) : 2,
      max_daily_req: Number.isFinite(Number(p.max_daily_req)) ? Number(p.max_daily_req) : 0,
      max_daily_tok: Number.isFinite(Number(p.max_daily_tok)) ? Number(p.max_daily_tok) : 0,
      max_daily_cost: Number.isFinite(Number(p.max_daily_cost)) ? Number(p.max_daily_cost) : 0,
      weight: Number.isFinite(Number(p.weight)) ? Number(p.weight) : 10,
    }
    const defaultOptions = {
      validate: { body: true, shape: true, shapeAutoComplete: false, aggressiveDisguise: false, normalizeTemperature: true, model: true, fastMode: true, requireStream: false },
      clean: { ccHeaders: false, ccBetaFlags: false, systemText: false, metadata: false, toolUseTrailing: true, capCacheControl: true, canonicalizeNonCCTools: false },
      override: {
        userAgent: { mode: 'omit', value: null },
        anthropicVersion: { mode: 'omit', value: null },
        anthropicBeta: { mode: 'omit', value: null },
        extraHeaders: {},
      },
      events: { emitTengu: true },
      canonicalCcMessages: true,
    }
    const resolvedOptions = (p.options && typeof p.options === 'object') ? p.options : defaultOptions

    const tok = await cookieAuth(session_key, outbound_proxy_id, step1_proxy_url)
    const accountName = (typeof name === 'string' && name.trim()) ? name.trim() : (tok.email_address || `ck-${Date.now()}`)
    const resolvedAccountType = policy.account_type !== 'pro' ? policy.account_type : (tok.subscription_type || 'pro')

    if (tok.organization_uuid || tok.account_uuid) {
      const dupRes = await query(
        `SELECT id, name FROM oauth_accounts
           WHERE deployment = $1 AND (
             ($2::text IS NOT NULL AND organization_uuid = $2::text)
             OR ($3::text IS NOT NULL AND account_uuid = $3::text)
           ) LIMIT 1`,
        [DEPLOYMENT, tok.organization_uuid || null, tok.account_uuid || null],
      )
      if (dupRes.rows.length > 0) {
        const existing = dupRes.rows[0]
        res.status(409).json({
          ok: false, duplicate: true,
          error: `Already exists: ${existing.name} (id=${existing.id})`,
          existing: { id: existing.id, name: existing.name },
        })
        return
      }
    }

    const expiresAtMs = Number(tok.expires_at) * 1000
    const inserted = await query(
      `INSERT INTO oauth_accounts
         (name, refresh_token, access_token, expires_at, status, account_type,
          max_rpm, max_tpm, max_concurrent, max_sessions,
          session_ttl_seconds, cooldown_seconds, max_retries,
          max_daily_req, max_daily_tok, max_daily_cost, weight,
          deployment, cc_template_id, organization_uuid, account_uuid,
          auth_kind, provider, outbound_proxy_id, options, group_id,
          source_session_key, source_proxy_id_at_import)
       VALUES ($1, $2, $3, $4, 'active', $5,
               $6, $7, $8, $9,
               $10, $11, $12,
               $13, $14, $15, $16,
               $17, $18, $19, $20,
               'oauth', 'anthropic', $21, $22::jsonb, $23,
               $24, $25)
       RETURNING id, name, account_type, status, organization_uuid`,
      [
        accountName, tok.refresh_token, tok.access_token, expiresAtMs,
        resolvedAccountType,
        policy.max_rpm, policy.max_tpm, policy.max_concurrent, policy.max_sessions,
        policy.session_ttl_seconds, policy.cooldown_seconds, policy.max_retries,
        policy.max_daily_req, policy.max_daily_tok, policy.max_daily_cost, policy.weight,
        DEPLOYMENT, templateId,
        tok.organization_uuid || null, tok.account_uuid || null,
        outbound_proxy_id || null,
        JSON.stringify(resolvedOptions),
        Array.isArray(group_ids) && group_ids.length > 0 ? group_ids[0] : null,
        session_key, outbound_proxy_id || null,
      ],
    )
    const account = inserted.rows[0]

    if (Array.isArray(group_ids) && group_ids.length > 0) {
      for (const gid of group_ids) {
        await query(
          `INSERT INTO oauth_account_groups (account_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [account.id, gid],
        )
      }
    }

    await audit(req, {
      action: 'account.import_ck',
      resource_type: 'account',
      resource_id: account.id,
      before: null,
      after: { id: account.id, name: account.name, email: tok.email_address, sub: tok.subscription_type },
      summary: `imported CK account ${account.name}`,
    })

    res.json({
      ok: true,
      account: {
        id: account.id, name: account.name,
        account_type: account.account_type, status: account.status,
        organization_uuid: account.organization_uuid,
        email: tok.email_address,
      },
    })
  } catch (err: any) {
    console.error('import-by-session-key error:', err)
    res.status(500).json({ ok: false, error: err?.message ?? 'Failed to import CK' })
  }
})


// ── CK Batch Import ────────────────────────────────────────────────────
// POST /api/admin/oauth-accounts/import-by-session-key/batch
// Body: {
//   session_keys: string[],
//   proxy_source: { mode: 'existing'|'new', existing_ids?: string[], new_proxy_urls?: string[] },
//   accounts_per_proxy: number,  // default 1, range 1-100
//   cc_template_id?: string,
//   group_ids?: string[],
//   name_prefix?: string,
// }
// Round-robin: account[i] → pool[ Math.floor(i / accountsPerProxy) % pool.length ]
router.post('/import-by-session-key/batch', async (req, res) => {
  try {
    const {
      session_keys, proxy_source, accounts_per_proxy,
      cc_template_id, group_ids, name_prefix,
      step1_proxy_url, concurrency: concurrencyInput,
    } = req.body ?? {}
    const concurrency = Math.max(1, Math.min(10, Number(concurrencyInput) || 5))

    const sks: string[] = Array.isArray(session_keys)
      ? session_keys.map((s: any) => String(s ?? '').trim()).filter(Boolean)
      : []
    if (sks.length === 0) {
      res.status(400).json({ error: 'session_keys cannot be empty' })
      return
    }
    if (sks.length > 500) {
      res.status(400).json({ error: 'max 500 sessionKeys per batch' })
      return
    }

    const apProxy = Math.max(1, Math.min(100, Number(accounts_per_proxy) || 1))

    let templateId: string | null = cc_template_id ?? null
    if (!templateId) {
      const def = await query(
        `SELECT id FROM cc_disguise_templates WHERE deployment = $1 AND is_default = TRUE LIMIT 1`,
        [DEPLOYMENT]
      )
      if (def.rows.length > 0) templateId = def.rows[0].id
    }
    if (!templateId) {
      res.status(400).json({ error: 'cc_template_id required (or set a default template)' })
      return
    }

    const p = req.body ?? {}
    const policy = {
      account_type: typeof p.account_type === 'string' && p.account_type.trim() ? p.account_type.trim() : 'pro',
      max_rpm: Number.isFinite(Number(p.max_rpm)) ? Number(p.max_rpm) : 60,
      max_tpm: Number.isFinite(Number(p.max_tpm)) ? Number(p.max_tpm) : 80000,
      max_concurrent: Number.isFinite(Number(p.max_concurrent)) ? Number(p.max_concurrent) : 5,
      max_sessions: Number.isFinite(Number(p.max_sessions)) ? Number(p.max_sessions) : 0,
      session_ttl_seconds: Number.isFinite(Number(p.session_ttl_seconds)) ? Number(p.session_ttl_seconds) : 0,
      cooldown_seconds: Number.isFinite(Number(p.cooldown_seconds)) ? Number(p.cooldown_seconds) : 60,
      max_retries: Number.isFinite(Number(p.max_retries)) ? Number(p.max_retries) : 2,
      max_daily_req: Number.isFinite(Number(p.max_daily_req)) ? Number(p.max_daily_req) : 0,
      max_daily_tok: Number.isFinite(Number(p.max_daily_tok)) ? Number(p.max_daily_tok) : 0,
      max_daily_cost: Number.isFinite(Number(p.max_daily_cost)) ? Number(p.max_daily_cost) : 0,
      weight: Number.isFinite(Number(p.weight)) ? Number(p.weight) : 10,
    }
    const defaultOptions = {
      validate: { body: true, shape: true, shapeAutoComplete: false, aggressiveDisguise: false, normalizeTemperature: true, model: true, fastMode: true, requireStream: false },
      clean: { ccHeaders: false, ccBetaFlags: false, systemText: false, metadata: false, toolUseTrailing: true, capCacheControl: true, canonicalizeNonCCTools: false },
      override: {
        userAgent: { mode: 'omit', value: null },
        anthropicVersion: { mode: 'omit', value: null },
        anthropicBeta: { mode: 'omit', value: null },
        extraHeaders: {},
      },
      events: { emitTengu: true },
      canonicalCcMessages: true,
    }
    const resolvedOptions = (p.options && typeof p.options === 'object') ? p.options : defaultOptions

    // Build proxy pool
    const proxyPool: Array<{ id: string; url: string }> = []
    const proxyErrors: Array<{ index: number; input: string; error: string }> = []

    const psMode = proxy_source?.mode ?? 'existing'
    if (psMode === 'existing') {
      const ids: string[] = Array.isArray(proxy_source?.existing_ids) ? proxy_source.existing_ids : []
      if (ids.length > 0) {
        const r = await query(
          `SELECT id, scheme, host, port, username, password FROM outbound_proxies WHERE id = ANY($1) AND status = 'active'`,
          [ids],
        )
        for (const row of r.rows) {
          const auth = row.username && row.password
            ? `${encodeURIComponent(row.username)}:${encodeURIComponent(row.password)}@`
            : (row.username ? `${encodeURIComponent(row.username)}@` : '')
          proxyPool.push({
            id: row.id,
            url: `${row.scheme}://${auth}${row.host}:${row.port}`,
          })
        }
      }
    } else if (psMode === 'new') {
      const urls: string[] = Array.isArray(proxy_source?.new_proxy_urls) ? proxy_source.new_proxy_urls : []
      for (let i = 0; i < urls.length; i++) {
        const raw = String(urls[i] ?? '').trim()
        if (!raw) continue
        try {
          const parsed = parseProxyInput(raw)
          const ins = await query(
            `INSERT INTO outbound_proxies
               (name, fingerprint, scheme, host, port, username, password, status, weight, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'active',10,now())
             ON CONFLICT (fingerprint) DO UPDATE SET
               name = EXCLUDED.name, status = 'active', updated_at = now()
             RETURNING id`,
            [parsed.name, parsed.fingerprint, parsed.scheme, parsed.host, parsed.port, parsed.username, parsed.password],
          )
          proxyPool.push({ id: ins.rows[0].id, url: parsed.normalizedUrl })
        } catch (err: any) {
          proxyErrors.push({ index: i, input: raw, error: err?.message ?? 'parse failed' })
        }
      }
      if (proxyPool.length > 0) {
        await reloadOutboundProxies()
      }
    } else if (psMode === 'direct') {
      // 直连模式: 不分配 proxy
      proxyPool.push({ id: '', url: '' })
    } else {
      res.status(400).json({ error: 'proxy_source.mode must be existing/new/direct' })
      return
    }

    if (proxyPool.length === 0) {
      res.status(400).json({ error: 'proxy pool is empty', proxy_errors: proxyErrors })
      return
    }

    // Capacity check (skip for direct mode)
    if (psMode !== 'direct') {
      const capacity = proxyPool.length * apProxy
      if (sks.length > capacity) {
        res.status(400).json({
          error: `${sks.length} accounts exceeds capacity ${capacity} (${proxyPool.length} proxies × ${apProxy})`,
          proxy_errors: proxyErrors,
        })
        return
      }
    }

    const results: Array<{
      ok: boolean
      index: number
      session_key_hint: string
      proxy_id?: string
      account?: any
      error?: string
      duplicate?: boolean
    }> = new Array(sks.length)

    // Concurrent worker pool — `concurrency` parallel cookieAuth flows in flight.
    // Each task writes results[i] by index, so ordering is preserved.
    // Errors are caught per-task; one bad sk does NOT abort the batch.
    let nextIdx = 0
    const runOne = async (i: number): Promise<void> => {
      const sk = sks[i]
      const proxy = proxyPool[Math.floor(i / apProxy) % proxyPool.length]
      const sessionKeyHint = sk.slice(0, 15) + '...'
      try {
        const tok = await cookieAuth(sk, proxy.id || undefined, step1_proxy_url)
        const accountName = name_prefix
          ? `${name_prefix}${i + 1}`
          : (tok.email_address || `ck-${Date.now()}-${i}`)
        const resolvedAccountType =
          policy.account_type !== 'pro' ? policy.account_type : (tok.subscription_type || 'pro')

        if (tok.organization_uuid || tok.account_uuid) {
          const dupRes = await query(
            `SELECT id, name FROM oauth_accounts
               WHERE deployment = $1 AND (
                 ($2::text IS NOT NULL AND organization_uuid = $2::text)
                 OR ($3::text IS NOT NULL AND account_uuid = $3::text)
               ) LIMIT 1`,
            [DEPLOYMENT, tok.organization_uuid || null, tok.account_uuid || null],
          )
          if (dupRes.rows.length > 0) {
            const existing = dupRes.rows[0]
            results[i] = {
              ok: false, duplicate: true, index: i,
              session_key_hint: sessionKeyHint,
              proxy_id: proxy.id || undefined,
              error: `Already exists: ${existing.name}`,
            }
            return
          }
        }

        const expiresAtMs = Number(tok.expires_at) * 1000
        const inserted = await query(
          `INSERT INTO oauth_accounts
             (name, refresh_token, access_token, expires_at, status, account_type,
              max_rpm, max_tpm, max_concurrent, max_sessions,
              session_ttl_seconds, cooldown_seconds, max_retries,
              max_daily_req, max_daily_tok, max_daily_cost, weight,
              deployment, cc_template_id, organization_uuid, account_uuid,
              auth_kind, provider, outbound_proxy_id, options, group_id,
              source_session_key, source_proxy_id_at_import)
           VALUES ($1, $2, $3, $4, 'active', $5,
                   $6, $7, $8, $9,
                   $10, $11, $12,
                   $13, $14, $15, $16,
                   $17, $18, $19, $20,
                   'oauth', 'anthropic', $21, $22::jsonb, $23,
                   $24, $25)
           RETURNING id, name, account_type`,
          [
            accountName, tok.refresh_token, tok.access_token, expiresAtMs,
            resolvedAccountType,
            policy.max_rpm, policy.max_tpm, policy.max_concurrent, policy.max_sessions,
            policy.session_ttl_seconds, policy.cooldown_seconds, policy.max_retries,
            policy.max_daily_req, policy.max_daily_tok, policy.max_daily_cost, policy.weight,
            DEPLOYMENT, templateId,
            tok.organization_uuid || null, tok.account_uuid || null,
            proxy.id || null,
            JSON.stringify(resolvedOptions),
            Array.isArray(group_ids) && group_ids.length > 0 ? group_ids[0] : null,
            sk, proxy.id || null,
          ],
        )
        const account = inserted.rows[0]
        if (Array.isArray(group_ids) && group_ids.length > 0) {
          for (const gid of group_ids) {
            await query(
              `INSERT INTO oauth_account_groups (account_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
              [account.id, gid],
            )
          }
        }
        results[i] = {
          ok: true, index: i,
          session_key_hint: sessionKeyHint,
          proxy_id: proxy.id || undefined,
          account: { id: account.id, name: account.name, email: tok.email_address, plan: tok.subscription_type },
        }
      } catch (err: any) {
        results[i] = {
          ok: false, index: i,
          session_key_hint: sessionKeyHint,
          proxy_id: proxy.id || undefined,
          error: err?.message ?? 'unknown',
        }
      }
    }
    const worker = async (): Promise<void> => {
      while (true) {
        const i = nextIdx++
        if (i >= sks.length) return
        await runOne(i)
      }
    }
    await Promise.all(
      Array(Math.min(concurrency, sks.length)).fill(0).map(() => worker())
    )

    const ok = results.filter(r => r.ok).length
    const duplicate = results.filter(r => r.duplicate).length
    const failed = results.length - ok - duplicate
    res.json({
      total: sks.length,
      ok, duplicate, failed,
      proxy_pool_size: proxyPool.length,
      accounts_per_proxy: apProxy,
      proxy_errors: proxyErrors,
      results,
    })
  } catch (err: any) {
    console.error('import-by-session-key/batch error:', err)
    res.status(500).json({ error: err?.message ?? 'Failed to batch import' })
  }
})


// POST /api/admin/oauth-accounts/bulk-update — patch a list of accounts at once.
// Body: { account_ids: string[], updates: { ...same fields as PATCH /:id... } }
// Whitelisted update fields (same as PATCH): name, status, account_type, weight,
//   max_rpm, max_tpm, max_concurrent, max_sessions, session_ttl_seconds,
//   max_daily_req, max_daily_tok, max_daily_cost, cooldown_seconds, max_retries,
//   models, identity_profile_id, outbound_proxy_id, options, canonical_identity,
//   group_ids (array, replaces M:N), group_id (single, back-compat)
// POST /api/admin/oauth-accounts/bulk-delete — delete a list of accounts in one call.
// Body: { ids: string[] }
// Runs the same per-account drain/cleanup/delete pipeline as DELETE /:id,
// plus orphan-proxy cleanup (proxies bound only to deleted accounts get removed).
router.post('/bulk-delete', async (req, res) => {
  try {
    const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : []
    const ids = rawIds
      .map((v: any) => String(v ?? '').trim())
      .filter((v: string) => /^[0-9a-fA-F-]{30,40}$/.test(v))
    if (ids.length === 0) {
      res.status(400).json({ error: 'ids is empty or invalid' })
      return
    }
    if (ids.length > 500) {
      res.status(400).json({ error: 'too many ids in one batch (max 500)' })
      return
    }

    const redis = getRedis()
    const failed: Array<{ id: string; error: string }> = []
    const deleted: Array<{ id: string; name: string }> = []
    // Track which proxies were bound to deleted accounts, for orphan cleanup later.
    const candidateProxyIds = new Set<string>()

    for (const id of ids) {
      try {
        const beforeRes = await query(
          `SELECT id, name, account_type, status, outbound_proxy_id FROM oauth_accounts WHERE id = $1 AND deployment = $2`,
          [id, DEPLOYMENT],
        )
        const before = beforeRes.rows[0] ?? null
        if (!before) {
          failed.push({ id, error: 'not found' })
          continue
        }
        if (before.outbound_proxy_id) candidateProxyIds.add(before.outbound_proxy_id)

        // Soft-drain
        await query(
          `UPDATE oauth_accounts SET status = 'disabled', updated_at = now() WHERE id = $1 AND deployment = $2`,
          [id, DEPLOYMENT],
        )
        if (redis) {
          await Promise.all([
            redis.del(`concurrent:${id}`),
            redis.del(`rpm:${id}`),
            redis.del(`tpm:${id}`),
            redis.del(`sessions:${id}`),
            redis.del(`cooldown:${id}`),
            redis.del(`errors:${id}`),
          ]).catch(() => {})
        }
        const result = await query(
          `DELETE FROM oauth_accounts WHERE id = $1 AND deployment = $2 RETURNING id`,
          [id, DEPLOYMENT],
        )
        if (result.rows.length === 0) {
          failed.push({ id, error: 'delete returned 0 rows' })
          continue
        }
        await audit(req, {
          action: 'account.delete',
          resource_type: 'account',
          resource_id: id,
          before,
          after: null,
          summary: `oauth account ${before.name} bulk-deleted`,
        })
        deleted.push({ id, name: before.name })
      } catch (err: any) {
        failed.push({ id, error: err?.message ?? String(err) })
      }
    }

    // Orphan-proxy cleanup: for each proxy that was bound to one of the deleted
    // accounts, check if any other accounts still reference it. If not, delete it.
    const orphanProxiesDeleted: string[] = []
    for (const proxyId of candidateProxyIds) {
      try {
        const refCount = await query(
          `SELECT COUNT(*)::int AS n FROM oauth_accounts WHERE outbound_proxy_id = $1`,
          [proxyId],
        )
        if ((refCount.rows[0]?.n ?? 0) === 0) {
          await query(`DELETE FROM outbound_proxies WHERE id = $1`, [proxyId])
          orphanProxiesDeleted.push(proxyId)
          console.log(`[bulk-delete] cascade-deleted orphan proxy ${proxyId}`)
        }
      } catch (err) {
        console.error(`[bulk-delete] orphan proxy cleanup failed for ${proxyId}:`, err)
      }
    }

    if (deleted.length > 0) await notifyReload()
    res.json({
      deleted: deleted.length,
      failed,
      deleted_accounts: deleted,
      orphan_proxies_deleted: orphanProxiesDeleted,
    })
  } catch (err: any) {
    console.error('Bulk delete oauth accounts error:', err)
    res.status(500).json({ error: 'Failed to bulk delete accounts' })
  }
})


router.post('/bulk-update', async (req, res) => {
  try {
    const { account_ids, updates } = req.body ?? {}
    if (!Array.isArray(account_ids) || account_ids.length === 0) {
      res.status(400).json({ error: 'account_ids required (non-empty array)' })
      return
    }
    if (account_ids.length > 500) {
      res.status(400).json({ error: 'too many ids (max 500)' })
      return
    }
    if (!updates || typeof updates !== 'object') {
      res.status(400).json({ error: 'updates object required' })
      return
    }

    const allowed = [
      'name', 'status', 'account_type', 'weight',
      'max_rpm', 'max_tpm', 'max_concurrent', 'max_sessions',
      'session_ttl_seconds', 'cooldown_seconds', 'max_retries',
      'max_daily_req', 'max_daily_tok', 'max_daily_cost',
      'models', 'identity_profile_id', 'outbound_proxy_id',
    ]

    // Resolve group_ids once (same logic as PATCH /:id)
    let nextGroupIds: string[] | null = null
    if (Array.isArray(updates.group_ids)) {
      nextGroupIds = (updates.group_ids as unknown[]).filter(
        (g): g is string => typeof g === 'string' && g.length > 0,
      )
    } else if (updates.group_id !== undefined) {
      if (updates.group_id === null || updates.group_id === '') nextGroupIds = []
      else if (typeof updates.group_id === 'string') nextGroupIds = [updates.group_id]
    }

    const updated: Array<{ id: string; name: string }> = []
    const failed: Array<{ id: string; error: string }> = []

    for (const id of account_ids) {
      try {
        const fields: string[] = []
        const params: any[] = []
        let idx = 1
        for (const key of allowed) {
          if (updates[key] !== undefined) {
            fields.push(`${key} = $${idx++}`)
            params.push(updates[key])
          }
        }
        if (updates.options !== undefined && updates.options !== null && typeof updates.options === 'object') {
          fields.push(`options = $${idx++}`)
          params.push(JSON.stringify(updates.options))
        }
        if (updates.canonical_identity !== undefined) {
          fields.push(`canonical_identity = $${idx++}`)
          params.push(updates.canonical_identity ? JSON.stringify(updates.canonical_identity) : null)
        }
        if (nextGroupIds !== null) {
          fields.push(`group_id = $${idx++}`)
          params.push(nextGroupIds[0] ?? null)
        }

        if (fields.length === 0) {
          failed.push({ id, error: 'no updatable fields' })
          continue
        }

        fields.push(`updated_at = now()`)
        params.push(id)
        params.push(DEPLOYMENT)
        const deploymentIdx = idx + 1
        const r = await query(
          `UPDATE oauth_accounts SET ${fields.join(', ')} WHERE id = $${idx} AND deployment = $${deploymentIdx} RETURNING id, name`,
          params,
        )
        if (r.rows.length === 0) {
          failed.push({ id, error: 'not found' })
          continue
        }

        // Rewrite M:N group mapping if group_ids was provided
        if (nextGroupIds !== null) {
          await query(`DELETE FROM oauth_account_groups WHERE account_id = $1`, [id])
          for (const gid of nextGroupIds) {
            await query(
              `INSERT INTO oauth_account_groups (account_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
              [id, gid],
            )
          }
        }

        updated.push({ id: r.rows[0].id, name: r.rows[0].name })
      } catch (err: any) {
        failed.push({ id, error: err?.message ?? 'unknown' })
      }
    }

    await audit(req, {
      action: 'account.bulk_update',
      resource_type: 'account',
      resource_id: account_ids.join(','),
      before: null,
      after: { updated: updated.length, failed: failed.length, updates: { ...updates, group_ids: nextGroupIds } },
      summary: `bulk-updated ${updated.length}/${account_ids.length} accounts`,
    })
    await notifyReload()

    res.json({
      ok: true,
      updated: updated.length,
      failed: failed.length,
      results: { updated, failed },
    })
  } catch (err: any) {
    console.error('Bulk update oauth accounts error:', err)
    res.status(500).json({ error: 'Failed to bulk update accounts' })
  }
})


export default router
