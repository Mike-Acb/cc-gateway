import { query, DEPLOYMENT } from './db.js'
import { log } from './logger.js'

// ── Types ──────────────────────────────────────────────────────

export type SyncedClient = {
  id: string
  userId: string
  name: string
  token: string
  status: string
  userStatus: string
  groupId: string | null
  // 累计 USD 额度上限;null = 无限。超限由 quota-checker 在请求路径强制执行。
  quotaUsd: number | null
  // 外部第三方客户端 (e.g. CherryStudio/Go 中转)。gateway 自动包装 CC 伪装。
  externalClient: boolean
}

export type SyncedRateLimit = {
  targetType: string
  targetId: string
  maxRpm: number
  maxRph: number | null
}

export type SyncedQuotaRule = {
  targetType: string
  targetId: string
  metric: string
  windowSeconds: number
  maxValue: number
  action: string
}

export type ModelPrice = {
  modelPattern: string
  inputMtok: number
  outputMtok: number
  cacheReadMtok: number
  cacheWriteMtok: number
}

// ── In-memory state ────────────────────────────────────────────

const clientsByToken = new Map<string, SyncedClient>()
let rateLimits: SyncedRateLimit[] = []
let quotaRules: SyncedQuotaRule[] = []
let modelPrices: ModelPrice[] = []
// account_groups.id → cost_multiplier (NUMERIC(6,3)); missing = 1.0
const groupMultipliers = new Map<string, number>()

let lastSyncAt = new Date(0) // epoch — triggers full load on first sync
let syncTimer: ReturnType<typeof setInterval> | null = null

// ── Getters ────────────────────────────────────────────────────

export function getClientByToken(token: string): SyncedClient | undefined {
  return clientsByToken.get(token)
}

export function getClientById(clientId: string): SyncedClient | undefined {
  for (const client of clientsByToken.values()) {
    if (client.id === clientId) return client
  }
  return undefined
}

/**
 * Resolve the in-memory group_id for a client id. Returns null if the client
 * is not in the cache (e.g. brand-new client not yet synced) so callers can
 * treat it as "default pool only" and still allow shared-pool accounts.
 */
export function getClientGroupId(clientId: string | null): string | null {
  if (!clientId) return null
  const client = getClientById(clientId)
  return client?.groupId ?? null
}

export function getAllClientNames(): string[] {
  return Array.from(clientsByToken.values()).map(c => c.name)
}

export function getRateLimits(): SyncedRateLimit[] {
  return rateLimits
}

export function getQuotaRules(): SyncedQuotaRule[] {
  return quotaRules
}

export function getModelPrices(): ModelPrice[] {
  return modelPrices
}

/**
 * Return the cost multiplier for a given account_groups.id. NULL or unknown
 * group → 1.0 (no multiplier). Callers pass the group actually used to serve
 * the request, which may differ from the client's configured group when the
 * client is in auto mode.
 */
export function getGroupMultiplier(groupId: string | null | undefined): number {
  if (!groupId) return 1
  const v = groupMultipliers.get(groupId)
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 1
}

export function findModelPrice(model: string): ModelPrice | undefined {
  // Exact match first
  const exact = modelPrices.find((p) => p.modelPattern === model)
  if (exact) return exact

  // Prefix match — longest prefix wins
  let best: ModelPrice | undefined
  let bestLen = 0
  for (const p of modelPrices) {
    if (model.startsWith(p.modelPattern) && p.modelPattern.length > bestLen) {
      best = p
      bestLen = p.modelPattern.length
    }
  }
  return best
}

// ── Sync logic ─────────────────────────────────────────────────

export async function syncFromDB(): Promise<void> {
  const syncStart = new Date()

  try {
    await syncClients()
  } catch (err) {
    log('error', `sync: clients failed: ${err instanceof Error ? err.message : err}`)
  }

  try {
    await syncRateLimits()
  } catch (err) {
    log('error', `sync: rate_limits failed: ${err instanceof Error ? err.message : err}`)
  }

  try {
    await syncQuotaRules()
  } catch (err) {
    log('error', `sync: quota_rules failed: ${err instanceof Error ? err.message : err}`)
  }

  try {
    await syncModelPrices()
  } catch (err) {
    log('error', `sync: model_pricing failed: ${err instanceof Error ? err.message : err}`)
  }

  try {
    await syncGroups()
  } catch (err) {
    log('error', `sync: account_groups failed: ${err instanceof Error ? err.message : err}`)
  }

  lastSyncAt = syncStart
}

async function syncGroups(): Promise<void> {
  const result = await query(`SELECT id, cost_multiplier FROM account_groups`)
  groupMultipliers.clear()
  for (const row of result.rows) {
    const v = parseFloat(String(row.cost_multiplier ?? '1'))
    groupMultipliers.set(row.id, Number.isFinite(v) && v > 0 ? v : 1)
  }
  log('info', `sync: account_groups loaded ${groupMultipliers.size} multipliers`)
}

async function syncClients(): Promise<void> {
  const isFirstSync = lastSyncAt.getTime() === 0

  let sql: string
  let params: any[]

  if (isFirstSync) {
    sql = `
      SELECT c.id, c.user_id, c.name, c.token, c.status, c.group_id, c.quota_usd, COALESCE(c.external_client, FALSE) AS external_client, u.status AS user_status
      FROM clients c
      JOIN users u ON c.user_id = u.id
      WHERE c.deployment = $1 AND u.deployment = $1
    `
    params = [DEPLOYMENT]
  } else {
    sql = `
      SELECT c.id, c.user_id, c.name, c.token, c.status, c.group_id, c.quota_usd, COALESCE(c.external_client, FALSE) AS external_client, u.status AS user_status
      FROM clients c
      JOIN users u ON c.user_id = u.id
      WHERE (c.updated_at > $1 OR u.updated_at > $1)
        AND c.deployment = $2 AND u.deployment = $2
    `
    params = [lastSyncAt, DEPLOYMENT]
  }

  const result = await query(sql, params)
  for (const row of result.rows) {
    const q = row.quota_usd === null || row.quota_usd === undefined
      ? null
      : Number(row.quota_usd)
    clientsByToken.set(row.token, {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      token: row.token,
      status: row.status,
      userStatus: row.user_status,
      groupId: row.group_id ?? null,
      quotaUsd: q !== null && Number.isFinite(q) ? q : null,
      externalClient: row.external_client === true,
    })
  }

  log('info', `sync: clients loaded ${result.rows.length} rows (${isFirstSync ? 'full' : 'incremental'})`)
}

async function syncRateLimits(): Promise<void> {
  const result = await query(`
    SELECT target_type, target_id, max_rpm, max_rph
    FROM rate_limits
    WHERE enabled = true
  `)

  rateLimits = result.rows.map((row) => ({
    targetType: row.target_type,
    targetId: row.target_id,
    maxRpm: row.max_rpm,
    maxRph: row.max_rph ?? null,
  }))

  log('info', `sync: rate_limits loaded ${rateLimits.length} rules`)
}

async function syncQuotaRules(): Promise<void> {
  const result = await query(`
    SELECT target_type, target_id, metric,
           EXTRACT(EPOCH FROM "window")::int AS window_seconds,
           max_value, action
    FROM quota_rules
    WHERE enabled = true
  `)

  quotaRules = result.rows.map((row) => ({
    targetType: row.target_type,
    targetId: row.target_id,
    metric: row.metric,
    windowSeconds: row.window_seconds,
    maxValue: row.max_value,
    action: row.action,
  }))

  log('info', `sync: quota_rules loaded ${quotaRules.length} rules`)
}

async function syncModelPrices(): Promise<void> {
  const result = await query(`
    SELECT DISTINCT ON (model_pattern)
           model_pattern, input_mtok, output_mtok, cache_read_mtok, cache_write_mtok
    FROM model_pricing
    WHERE effective_from <= CURRENT_DATE
    ORDER BY model_pattern, effective_from DESC
  `)

  modelPrices = result.rows.map((row) => ({
    modelPattern: row.model_pattern,
    inputMtok: row.input_mtok,
    outputMtok: row.output_mtok,
    cacheReadMtok: row.cache_read_mtok,
    cacheWriteMtok: row.cache_write_mtok,
  }))

  log('info', `sync: model_pricing loaded ${modelPrices.length} prices`)
}

// ── Lifecycle ──────────────────────────────────────────────────

/**
 * Ensure config.yaml tokens have matching records in PG clients table.
 * Creates a system user and client records if they don't exist.
 */
export async function ensureConfigClients(configTokens: { name: string; token: string }[]): Promise<void> {
  if (configTokens.length === 0) return
  try {
    // Deployment-scoped system user so gw and gwbk don't collide on username UNIQUE.
    // gw keeps the legacy '_system' username; other deployments get '_system_<tag>'.
    const systemUsername = DEPLOYMENT === 'gw' ? '_system' : `_system_${DEPLOYMENT}`
    const systemEmail = DEPLOYMENT === 'gw' ? '_system@gateway' : `_system_${DEPLOYMENT}@gateway`
    const userResult = await query(
      `INSERT INTO users (username, email, password_hash, role, status, deployment)
       VALUES ($1, $2, '_no_login_', 'admin', 'active', $3)
       ON CONFLICT (username) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [systemUsername, systemEmail, DEPLOYMENT]
    )
    const systemUserId = userResult.rows[0].id

    for (const entry of configTokens) {
      await query(
        `INSERT INTO clients (user_id, name, token, status, deployment)
         VALUES ($1, $2, $3, 'active', $4)
         ON CONFLICT (token) DO NOTHING`,
        [systemUserId, entry.name, entry.token, DEPLOYMENT]
      )
    }
    log('info', `sync: ensured ${configTokens.length} config.yaml clients in PG (deployment=${DEPLOYMENT})`)
  } catch (err) {
    log('error', `sync: ensureConfigClients failed: ${err instanceof Error ? err.message : err}`)
  }
}

export function startSync(intervalMs = 30_000): void {
  // Fire initial sync (don't await — runs in background)
  syncFromDB().catch((err) => {
    log('error', `sync: initial sync failed: ${err instanceof Error ? err.message : err}`)
  })

  syncTimer = setInterval(() => {
    syncFromDB().catch((err) => {
      log('error', `sync: periodic sync failed: ${err instanceof Error ? err.message : err}`)
    })
  }, intervalMs)

  log('info', `sync: started with ${intervalMs}ms interval`)
}

export function stopSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
    log('info', 'sync: stopped')
  }
}
