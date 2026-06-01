import { query, DEPLOYMENT } from './db.js'
import { log } from './logger.js'
import { getQuotaRules, getClientById, type SyncedQuotaRule } from './sync.js'

/**
 * Reserve a prebill chunk against the client's quota before forwarding upstream.
 * Increments clients.reserved_usd so a concurrent quota check sees the pending
 * draw. Must be paired with reconcileClientPrebill after the request lifecycle
 * ends (success OR error) to release the hold.
 */
export async function deductClientPrebill(clientId: string, prebill: number): Promise<void> {
  if (!clientId || prebill <= 0) return
  try {
    await query(
      `UPDATE clients SET reserved_usd = reserved_usd + $1, updated_at = now()
       WHERE id = $2::uuid AND deployment = $3`,
      [prebill, clientId, DEPLOYMENT],
    )
  } catch (err) {
    log('error', `Client prebill deduct error (client=${clientId}): ${err}`)
  }
}

/**
 * Release the prebill hold once the request lifecycle ends. Real cost is
 * recorded separately via metering.recordUsage → usage_records (naturally
 * accumulated by SUM(cost)). GREATEST(0, …) prevents underflow from
 * stale/duplicate reconciles.
 */
export async function reconcileClientPrebill(clientId: string, prebill: number): Promise<void> {
  if (!clientId || prebill <= 0) return
  try {
    await query(
      `UPDATE clients
         SET reserved_usd = GREATEST(0::numeric, reserved_usd - $1),
             updated_at = now()
       WHERE id = $2::uuid AND deployment = $3`,
      [prebill, clientId, DEPLOYMENT],
    )
  } catch (err) {
    log('error', `Client prebill reconcile error (client=${clientId}): ${err}`)
  }
}

export type QuotaCheckResult = {
  allowed: boolean
  rule?: SyncedQuotaRule
  used?: number
  message?: string
  // 'exhausted' = 客户端累计额度耗尽 (402); 'rate_limited' = 时间窗口规则触发 (429)
  reason?: 'exhausted' | 'rate_limited'
}

export async function checkQuota(clientId: string, userId?: string): Promise<QuotaCheckResult> {
  // 1. 客户端级累计 USD 额度上限 (clients.quota_usd):无窗口约束。
  //    比较 (SUM(usage_records.cost) + clients.reserved_usd) 与 quota_usd:
  //    reserved_usd 是入口处对预扣金额的占用,出口释放;同时把它纳入用量计算
  //    可防止单次大请求穿越限额(因为 prebill 已经占住额度)。
  //    null quota = 无限,跳过。
  const client = getClientById(clientId)
  if (client && client.quotaUsd !== null && client.quotaUsd >= 0) {
    const r = await query<{ used: string; reserved: string }>(
      `SELECT
         COALESCE((SELECT SUM(cost) FROM usage_records WHERE client_id = $1::uuid), 0)::text AS used,
         COALESCE((SELECT reserved_usd FROM clients WHERE id = $1::uuid), 0)::text AS reserved`,
      [clientId],
    )
    const usedUsd = parseFloat(r.rows[0].used)
    const reservedUsd = parseFloat(r.rows[0].reserved)
    const totalDrawn = usedUsd + reservedUsd
    if (totalDrawn >= client.quotaUsd) {
      const message = `Client quota exhausted: used $${usedUsd.toFixed(4)} + reserved $${reservedUsd.toFixed(4)} >= limit $${client.quotaUsd.toFixed(4)}`
      log('warn', `Quota rejected: client=${clientId} ${message}`)
      return { allowed: false, used: totalDrawn, message, reason: 'exhausted' }
    }
  }

  const rules = getQuotaRules()

  for (const rule of rules) {
    const matches =
      (rule.targetType === 'client' && rule.targetId === clientId) ||
      (rule.targetType === 'user' && userId && rule.targetId === userId)

    if (!matches) continue

    const windowStart = new Date(Date.now() - rule.windowSeconds * 1000)

    // Scope to current deployment when matching on user (sub-query against clients)
    // For `client` rules the target id is already deployment-scoped (clients are loaded
    // via sync.ts which already filters by deployment).
    const targetClause = rule.targetType === 'client'
      ? 'client_id = $1'
      : 'client_id IN (SELECT id FROM clients WHERE user_id = $1 AND deployment = $3)'
    const targetValue = rule.targetType === 'client' ? clientId : userId
    const params: any[] = [targetValue, windowStart]
    if (rule.targetType !== 'client') params.push(DEPLOYMENT)

    let usedValue: number

    if (rule.metric === 'tokens') {
      const result = await query<{ total: string }>(
        `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read + cache_write), 0)::text AS total
         FROM usage_records
         WHERE ${targetClause} AND created_at > $2`,
        params,
      )
      usedValue = parseFloat(result.rows[0].total)
    } else if (rule.metric === 'cost') {
      const result = await query<{ total: string }>(
        `SELECT COALESCE(SUM(cost), 0)::text AS total
         FROM usage_records
         WHERE ${targetClause} AND created_at > $2`,
        params,
      )
      usedValue = parseFloat(result.rows[0].total)
    } else if (rule.metric === 'requests') {
      const result = await query<{ total: string }>(
        `SELECT COUNT(*)::text AS total
         FROM usage_records
         WHERE ${targetClause} AND created_at > $2`,
        params,
      )
      usedValue = parseFloat(result.rows[0].total)
    } else {
      continue
    }

    if (usedValue >= rule.maxValue) {
      const windowHours = Math.round(rule.windowSeconds / 3600)
      const message = `Quota exceeded: ${rule.metric} limit ${rule.maxValue} per ${windowHours}h (used: ${usedValue})`

      if (rule.action === 'reject') {
        log('warn', `Quota rejected: ${rule.targetType}=${rule.targetId} ${message}`)
        return { allowed: false, rule, used: usedValue, message, reason: 'rate_limited' }
      } else if (rule.action === 'notify') {
        log('info', `Quota notify: ${rule.targetType}=${rule.targetId} ${message}`)
      }
    }
  }

  return { allowed: true }
}
