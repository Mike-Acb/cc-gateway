// API-server mirror of gateway's plan-guard. Kept in sync for API-side checks.
// Pool > quota priority. Both use `balance` in USD.

import { query } from '../db.js'

export type PlanCheckResult = {
  allowed: boolean
  reason?: string
  subscriptionId?: string
  planType?: string
}

type ActiveRow = {
  id: string
  balance: string | number | null
  expires_at: Date | string | null
  remaining_uses: number | null
  plan_type: string
  plan_subtype: string | null
}

function isExhausted(sub: ActiveRow): boolean {
  if (sub.plan_subtype === 'per_use' && sub.remaining_uses !== null && sub.remaining_uses <= 0) return true
  return parseFloat(String(sub.balance ?? 0)) <= 0
}

function isExpired(sub: ActiveRow): boolean {
  return Boolean(sub.expires_at && new Date(sub.expires_at as any) < new Date())
}

export async function checkPlanLimits(userId: string): Promise<PlanCheckResult> {
  const result = await query(
    `SELECT s.id, s.balance, s.expires_at, s.remaining_uses,
            p.type AS plan_type, p.subtype AS plan_subtype
       FROM subscriptions s
       JOIN plans p ON s.plan_id = p.id
      WHERE s.user_id = $1 AND s.status = 'active'
      ORDER BY s.created_at DESC`,
    [userId],
  )
  const actives = result.rows as ActiveRow[]

  if (actives.length === 0) return { allowed: true }

  for (const sub of actives) {
    if (sub.plan_type === 'pool' && isExpired(sub)) {
      await query("UPDATE subscriptions SET status = 'expired', updated_at = now() WHERE id = $1", [sub.id])
    }
  }

  const pool = actives.find((s) => s.plan_type === 'pool' && !isExpired(s) && !isExhausted(s))
  if (pool) return { allowed: true, subscriptionId: pool.id, planType: 'pool' }

  const quota = actives.find((s) => s.plan_type === 'quota' && !isExhausted(s))
  if (quota) return { allowed: true, subscriptionId: quota.id, planType: 'quota' }

  return { allowed: false, reason: '套餐额度已用完，请续费或充值' }
}

export async function recordSubscriptionUsage(
  subscriptionId: string,
  _planType: string,
  cost: number,
): Promise<void> {
  await query(
    'UPDATE subscriptions SET balance = balance - $1, updated_at = now() WHERE id = $2',
    [cost, subscriptionId],
  )
}
