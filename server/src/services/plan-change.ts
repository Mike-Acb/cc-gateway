// Plan-change decision engine. Given a user + target plan (+ optional overrides),
// resolve what "buying that plan" means *right now*: new / renew / upgrade / downgrade / merge.
// `applyDecision` executes the resolved action.
//
// Semantics:
//   • pool = USD allowance with expiry (balance refills on renew/upgrade)
//   • quota = USD wallet, no expiry
//   • Pool priority > quota priority at request time (handled in plan-guard).
//   • Switching pools: if new.price ≥ remaining_value_cny → bonus days on new pool.
//                     else → refund diff to quota (via cny_to_usd_rate).
//   • Multi-buy quota → merge into existing quota.

import { query, DEPLOYMENT } from '../db.js'

export const SYSTEM_QUOTA_PLAN_ID = '00000000-0000-0000-0000-000000000001'

export type DecisionKind =
  | 'new_pool'
  | 'renew_pool'
  | 'upgrade_pool'
  | 'downgrade_pool'
  | 'new_quota'
  | 'merge_quota'

export type PlanSummary = {
  id: string
  name: string
  type: 'pool' | 'quota'
  subtype: string | null
  price: number
  currency: string
  quota_amount: number
  duration_days: number | null
}

export type DecisionDetail = { label: string; value: string }

export type Decision = {
  kind: DecisionKind
  plan: PlanSummary
  charge_cny: number
  add_usd: number
  new_expires_at: Date | null
  rate: number
  summary: string
  details: DecisionDetail[]
  target_sub_id?: string
  from_sub_id?: string
  bonus_days?: number
  refund_cny?: number
  refund_usd?: number
  refund_target_sub_id?: string
}

export type DecisionOverride = {
  balance?: number | string
  expires_at?: string | Date | null
}

const toNum = (v: unknown): number => {
  const n = parseFloat(String(v ?? 0))
  return Number.isFinite(n) ? n : 0
}

const fmtDate = (d: Date | null | undefined): string =>
  d ? d.toISOString().slice(0, 10) : '—'

const fmtCny = (v: number) => `¥${v.toFixed(2)}`
const fmtUsd = (v: number) => `$${v.toFixed(2)}`

export async function getCnyToUsdRate(): Promise<number> {
  const r = await query("SELECT value FROM system_settings WHERE key = 'cny_to_usd_rate'")
  const v = toNum(r.rows[0]?.value ?? '1.0')
  return v > 0 ? v : 1.0
}

async function loadPlan(planId: string): Promise<PlanSummary | null> {
  const r = await query(
    `SELECT id, name, type, subtype, price, currency,
            COALESCE(quota_amount, 0) AS quota_amount, duration_days
       FROM plans WHERE id = $1`,
    [planId],
  )
  const p = r.rows[0]
  if (!p) return null
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    subtype: p.subtype,
    price: toNum(p.price),
    currency: p.currency,
    quota_amount: toNum(p.quota_amount),
    duration_days: p.duration_days,
  }
}

type ActiveSubRow = {
  id: string
  plan_id: string
  balance: string | number
  expires_at: string | Date | null
  starts_at: string | Date | null
  plan_type: 'pool' | 'quota'
  plan_subtype: string | null
  plan_name: string
  plan_price: string | number
  plan_quota_amount: string | number | null
  duration_days: number | null
  is_system: boolean
}

async function loadActives(userId: string): Promise<ActiveSubRow[]> {
  const r = await query(
    `SELECT s.id, s.plan_id, s.balance, s.expires_at, s.starts_at,
            p.type AS plan_type, p.subtype AS plan_subtype,
            p.name AS plan_name, p.price AS plan_price,
            p.quota_amount AS plan_quota_amount,
            p.duration_days, COALESCE(p.is_system, false) AS is_system
       FROM subscriptions s JOIN plans p ON s.plan_id = p.id
      WHERE s.user_id = $1 AND s.status = 'active'
      ORDER BY s.created_at DESC`,
    [userId],
  )
  return r.rows as ActiveSubRow[]
}

export type ResolveResult = { decision: Decision } | { error: string }

export async function resolvePlanChange(
  userId: string,
  planId: string,
  override: DecisionOverride = {},
): Promise<ResolveResult> {
  const plan = await loadPlan(planId)
  if (!plan) return { error: 'Plan not found' }

  const [actives, rate] = await Promise.all([loadActives(userId), getCnyToUsdRate()])

  const chargeCny = plan.price
  const poolDuration = plan.duration_days ?? 0
  const defaultExpires = poolDuration > 0
    ? new Date(Date.now() + poolDuration * 86400000)
    : null

  const overrideExpires = override.expires_at !== undefined
    ? (override.expires_at ? new Date(override.expires_at as any) : null)
    : undefined

  // ── Quota plan ────────────────────────────────────────────────
  if (plan.type === 'quota') {
    const addUsd = override.balance !== undefined ? toNum(override.balance) : plan.quota_amount
    const existing = actives.find((s) => s.plan_type === 'quota' && !s.is_system)

    if (existing) {
      const curBal = toNum(existing.balance)
      return {
        decision: {
          kind: 'merge_quota',
          plan,
          charge_cny: chargeCny,
          add_usd: addUsd,
          target_sub_id: existing.id,
          new_expires_at: null,
          rate,
          summary: `入账到现有额度：${existing.plan_name}`,
          details: [
            { label: '充值金额', value: fmtCny(chargeCny) },
            { label: '入账额度', value: `+ ${fmtUsd(addUsd)}` },
            { label: '目标账户', value: `${existing.plan_name}（当前 ${fmtUsd(curBal)}）` },
            { label: '入账后余额', value: fmtUsd(curBal + addUsd) },
          ],
        },
      }
    }

    return {
      decision: {
        kind: 'new_quota',
        plan,
        charge_cny: chargeCny,
        add_usd: addUsd,
        new_expires_at: null,
        rate,
        summary: `开通新额度：${plan.name}`,
        details: [
          { label: '充值金额', value: fmtCny(chargeCny) },
          { label: '入账额度', value: fmtUsd(addUsd) },
        ],
      },
    }
  }

  // ── Pool plan ─────────────────────────────────────────────────
  const poolBalance = override.balance !== undefined ? toNum(override.balance) : plan.quota_amount
  const currentPool = actives.find((s) => s.plan_type === 'pool')

  if (!currentPool) {
    const expiresAt = overrideExpires !== undefined ? overrideExpires : defaultExpires
    return {
      decision: {
        kind: 'new_pool',
        plan,
        charge_cny: chargeCny,
        add_usd: poolBalance,
        new_expires_at: expiresAt,
        rate,
        summary: `开通订阅：${plan.name}`,
        details: [
          { label: '订阅金额', value: fmtCny(chargeCny) },
          { label: '可用额度', value: fmtUsd(poolBalance) },
          { label: '有效期', value: poolDuration ? `${poolDuration} 天（至 ${fmtDate(expiresAt)}）` : '永久' },
        ],
      },
    }
  }

  const curPrice = toNum(currentPool.plan_price)
  const curDuration = currentPool.duration_days ?? 0
  const curExpiresAt = currentPool.expires_at ? new Date(currentPool.expires_at as any) : null
  const msRemaining = curExpiresAt ? Math.max(0, curExpiresAt.getTime() - Date.now()) : 0
  const daysRemaining = msRemaining / 86400000
  const timeRatio = curDuration > 0 ? Math.min(1, daysRemaining / curDuration) : 0
  const remainingValueCny = curPrice * timeRatio

  // Same plan → renew
  if (currentPool.plan_id === planId) {
    const base = curExpiresAt && curExpiresAt.getTime() > Date.now() ? curExpiresAt : new Date()
    const computed = poolDuration > 0 ? new Date(base.getTime() + poolDuration * 86400000) : null
    const newExpires = overrideExpires !== undefined ? overrideExpires : computed
    const curBal = toNum(currentPool.balance)
    return {
      decision: {
        kind: 'renew_pool',
        plan,
        charge_cny: chargeCny,
        add_usd: poolBalance,
        target_sub_id: currentPool.id,
        new_expires_at: newExpires,
        rate,
        summary: `续期 ${plan.name}`,
        details: [
          { label: '续期金额', value: fmtCny(chargeCny) },
          { label: '额度增加', value: `+ ${fmtUsd(poolBalance)}` },
          { label: '续期后余额', value: fmtUsd(curBal + poolBalance) },
          { label: '当前到期', value: fmtDate(curExpiresAt) },
          { label: '续期后到期', value: fmtDate(newExpires) },
        ],
      },
    }
  }

  // Different pool plan → upgrade (bonus days) vs downgrade (refund diff)
  if (plan.price >= remainingValueCny) {
    // Upgrade / swap / same-price → bonus days
    const bonusDays = plan.price > 0 && poolDuration > 0
      ? (remainingValueCny / plan.price) * poolDuration
      : 0
    const totalDays = poolDuration + bonusDays
    const computed = poolDuration > 0 ? new Date(Date.now() + totalDays * 86400000) : null
    const newExpires = overrideExpires !== undefined ? overrideExpires : computed
    const verb = plan.price > curPrice ? '升级' : '切换'
    return {
      decision: {
        kind: 'upgrade_pool',
        plan,
        charge_cny: chargeCny,
        add_usd: poolBalance,
        from_sub_id: currentPool.id,
        bonus_days: bonusDays,
        new_expires_at: newExpires,
        rate,
        summary: `${verb}至 ${plan.name}，原剩余折赠 ${bonusDays.toFixed(1)} 天`,
        details: [
          { label: '订阅金额', value: fmtCny(chargeCny) },
          { label: '原套餐', value: `${currentPool.plan_name}（剩余 ${daysRemaining.toFixed(1)} 天，价值 ${fmtCny(remainingValueCny)}）` },
          { label: '赠送天数', value: `+ ${bonusDays.toFixed(1)} 天` },
          { label: '新套餐有效期', value: `${totalDays.toFixed(1)} 天（至 ${fmtDate(newExpires)}）` },
          { label: '可用额度', value: fmtUsd(poolBalance) },
        ],
      },
    }
  }

  // Downgrade: remaining value exceeds new price → refund diff to quota
  const refundCny = remainingValueCny - plan.price
  const refundUsd = refundCny * rate
  const targetQuota = actives.find((s) => s.plan_type === 'quota' && !s.is_system)
  const newExpires = overrideExpires !== undefined ? overrideExpires : defaultExpires
  const targetDesc = targetQuota
    ? `${targetQuota.plan_name}（${fmtUsd(toNum(targetQuota.balance))} → ${fmtUsd(toNum(targetQuota.balance) + refundUsd)}）`
    : '系统补偿额度（新建）'

  return {
    decision: {
      kind: 'downgrade_pool',
      plan,
      charge_cny: chargeCny,
      add_usd: poolBalance,
      from_sub_id: currentPool.id,
      new_expires_at: newExpires,
      refund_cny: refundCny,
      refund_usd: refundUsd,
      refund_target_sub_id: targetQuota?.id,
      rate,
      summary: `降级至 ${plan.name}，差价 ${fmtCny(refundCny)} 折 ${fmtUsd(refundUsd)} 入额度`,
      details: [
        { label: '订阅金额', value: fmtCny(chargeCny) },
        { label: '原套餐', value: `${currentPool.plan_name}（剩余 ${daysRemaining.toFixed(1)} 天，价值 ${fmtCny(remainingValueCny)}）` },
        { label: '差价退回', value: `${fmtCny(refundCny)} → ${fmtUsd(refundUsd)}（汇率 ${rate}）` },
        { label: '退款入账', value: targetDesc },
        { label: '新订阅有效期', value: poolDuration ? `${poolDuration} 天（至 ${fmtDate(newExpires)}）` : '永久' },
        { label: '可用额度', value: fmtUsd(poolBalance) },
      ],
    },
  }
}

export type ApplyResult = { subscription_id: string }

/**
 * Apply a resolved decision.
 *
 * When `pendingSubId` is provided (user payment flow), that subscription is either
 * activated (new_pool, new_quota, upgrade_pool, downgrade_pool) or marked merged
 * (merge_quota, renew_pool). When absent (admin grant), new rows are inserted directly.
 */
export async function applyDecision(
  userId: string,
  decision: Decision,
  pendingSubId?: string,
): Promise<ApplyResult> {
  const remainingUses = decision.plan.subtype === 'per_use' ? 1 : null

  const insertSub = async (planId: string, balance: number, expiresAt: Date | null): Promise<string> => {
    const r = await query(
      `INSERT INTO subscriptions (user_id, plan_id, status, balance, starts_at, expires_at, remaining_uses)
       VALUES ($1, $2, 'active', $3, now(), $4, $5)
       RETURNING id`,
      [userId, planId, balance, expiresAt, remainingUses],
    )
    return r.rows[0].id
  }

  const activatePending = async (balance: number, expiresAt: Date | null): Promise<string> => {
    await query(
      `UPDATE subscriptions
          SET status = 'active', balance = $1, starts_at = now(), expires_at = $2,
              remaining_uses = $3, updated_at = now()
        WHERE id = $4`,
      [balance, expiresAt, remainingUses, pendingSubId],
    )
    return pendingSubId!
  }

  const markPendingMerged = async () => {
    if (pendingSubId) {
      await query(
        "UPDATE subscriptions SET status = 'merged', updated_at = now() WHERE id = $1",
        [pendingSubId],
      )
    }
  }

  const setCurrent = async (subId: string): Promise<void> => {
    await query(
      `UPDATE users SET current_subscription_id = $1, updated_at = now()
        WHERE id = $2 AND deployment = $3`,
      [subId, userId, DEPLOYMENT],
    )
  }

  switch (decision.kind) {
    case 'new_pool':
    case 'new_quota': {
      const subId = pendingSubId
        ? await activatePending(decision.add_usd, decision.new_expires_at)
        : await insertSub(decision.plan.id, decision.add_usd, decision.new_expires_at)
      await setCurrent(subId)
      return { subscription_id: subId }
    }

    case 'merge_quota': {
      await query(
        `UPDATE subscriptions SET balance = balance + $1, updated_at = now() WHERE id = $2`,
        [decision.add_usd, decision.target_sub_id],
      )
      await markPendingMerged()
      return { subscription_id: decision.target_sub_id! }
    }

    case 'renew_pool': {
      await query(
        `UPDATE subscriptions
            SET balance = balance + $1, expires_at = $2, status = 'active', updated_at = now()
          WHERE id = $3`,
        [decision.add_usd, decision.new_expires_at, decision.target_sub_id],
      )
      await markPendingMerged()
      await setCurrent(decision.target_sub_id!)
      return { subscription_id: decision.target_sub_id! }
    }

    case 'upgrade_pool': {
      await query(
        "UPDATE subscriptions SET status = 'cancelled', updated_at = now() WHERE id = $1",
        [decision.from_sub_id],
      )
      const subId = pendingSubId
        ? await activatePending(decision.add_usd, decision.new_expires_at)
        : await insertSub(decision.plan.id, decision.add_usd, decision.new_expires_at)
      await setCurrent(subId)
      return { subscription_id: subId }
    }

    case 'downgrade_pool': {
      await query(
        "UPDATE subscriptions SET status = 'cancelled', updated_at = now() WHERE id = $1",
        [decision.from_sub_id],
      )

      const refundUsd = decision.refund_usd ?? 0
      if (refundUsd > 0) {
        if (decision.refund_target_sub_id) {
          await query(
            `UPDATE subscriptions SET balance = balance + $1, updated_at = now() WHERE id = $2`,
            [refundUsd, decision.refund_target_sub_id],
          )
        } else {
          await query(
            `INSERT INTO subscriptions (user_id, plan_id, status, balance, starts_at, remaining_uses)
             VALUES ($1, $2, 'active', $3, now(), NULL)`,
            [userId, SYSTEM_QUOTA_PLAN_ID, refundUsd],
          )
        }
      }

      const subId = pendingSubId
        ? await activatePending(decision.add_usd, decision.new_expires_at)
        : await insertSub(decision.plan.id, decision.add_usd, decision.new_expires_at)
      await setCurrent(subId)
      return { subscription_id: subId }
    }
  }
}
