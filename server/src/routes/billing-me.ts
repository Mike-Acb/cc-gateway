// GET /api/me/billing — user billing aggregator.
//
// Returns active subscription, subscription history, balance summary
// (current cash balance on active quota subscription, lifetime topup/spend),
// and recent payment (recharge) records for the authenticated user.

import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { query } from '../db.js'
import { POOL_COLUMNS, buildCaps, computeUsable, type CapKind, type PoolCapState } from '../services/pool-wallet.js'

export type ActiveSubscription = {
  id: string
  status: string
  plan_name: string
  plan_type: string
  plan_subtype: string | null
  starts_at: string | null
  expires_at: string | null
  balance: number
  price: number
  currency: string
}

export type SubscriptionHistoryRow = {
  id: string
  status: string
  plan_name: string
  plan_type: string
  plan_subtype: string | null
  starts_at: string | null
  expires_at: string | null
  balance: number
  price: number
  currency: string
  created_at: string
}

export type PaymentRow = {
  id: string
  amount: number
  out_trade_no: string
  trade_no: string | null
  status: string
  paid_at: string | null
  created_at: string
}

export type BillingSummary = {
  current_balance: number
  total_topup: number
  total_spend: number
  currency: string
}

export type Wallet = {
  pool: {
    subscription_id: string
    plan_name: string
    plan_subtype: string | null
    balance: number
    expires_at: string | null
    starts_at: string | null
    usable: boolean
    caps: Record<CapKind, PoolCapState>
  } | null
  quota: {
    subscription_id: string
    plan_name: string
    balance: number
  } | null
  consumption_order: 'pool_first'
}

export type DailyUsage = {
  day: string           // 'YYYY-MM-DD'
  spend_usd: number     // total cost from usage_records
  topup_cny: number     // total paid payments amount
}

export type BillingDTO = {
  activeSubscription: ActiveSubscription | null
  activeSubscriptions: ActiveSubscription[]
  wallet: Wallet
  dailyUsage: DailyUsage[]
  subscriptionHistory: SubscriptionHistoryRow[]
  balance: BillingSummary
  payments: PaymentRow[]
}

function num(v: unknown): number {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'string' ? parseFloat(v) : Number(v)
  return Number.isFinite(n) ? n : 0
}

function isoOrNull(v: unknown): string | null {
  if (!v) return null
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

export async function loadBilling(userId: string): Promise<BillingDTO> {
  const [historyRes, activeBalanceRes, topupRes, spendRes, paymentsRes, poolRes, quotaRes, dailyRes] = await Promise.all([
    query(
      `SELECT s.id, s.status, s.starts_at, s.expires_at, s.balance, s.created_at,
              p.name AS plan_name, p.type AS plan_type, p.subtype AS plan_subtype,
              p.price, p.currency
         FROM subscriptions s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.user_id = $1
        ORDER BY s.created_at DESC
        LIMIT 20`,
      [userId],
    ),
    query(
      `SELECT COALESCE(SUM(s.balance), 0) AS current_balance,
              MAX(p.currency) AS currency
         FROM subscriptions s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.user_id = $1 AND s.status = 'active' AND p.type = 'quota'`,
      [userId],
    ),
    query(
      `SELECT COALESCE(SUM(amount), 0) AS total_topup
         FROM payments
        WHERE user_id = $1 AND status = 'paid'`,
      [userId],
    ),
    query(
      `SELECT COALESCE(SUM(ur.cost), 0) AS total_spend
         FROM usage_records ur
         JOIN clients c ON c.id = ur.client_id
        WHERE c.user_id = $1`,
      [userId],
    ),
    query(
      `SELECT id, amount, out_trade_no, trade_no, status, paid_at, created_at
         FROM payments
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [userId],
    ),
    query(
      `SELECT ${POOL_COLUMNS}
         FROM subscriptions s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.user_id = $1 AND s.status = 'active' AND p.type = 'pool'
          AND (s.expires_at IS NULL OR s.expires_at > now())
        ORDER BY s.created_at DESC LIMIT 1`,
      [userId],
    ),
    query(
      `SELECT s.id, p.name AS plan_name, s.balance
         FROM subscriptions s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.user_id = $1 AND s.status = 'active' AND p.type = 'quota'
        ORDER BY s.created_at DESC LIMIT 1`,
      [userId],
    ),
    query(
      `WITH days AS (
         SELECT generate_series((now() - INTERVAL '29 days')::date, now()::date, INTERVAL '1 day')::date AS d
       ),
       spend AS (
         SELECT date_trunc('day', ur.created_at)::date AS d, COALESCE(SUM(ur.cost), 0) AS spend_usd
           FROM usage_records ur
           JOIN clients c ON c.id = ur.client_id
          WHERE c.user_id = $1 AND ur.created_at >= now() - INTERVAL '30 days'
          GROUP BY 1
       ),
       topup AS (
         SELECT date_trunc('day', paid_at)::date AS d, COALESCE(SUM(amount), 0) AS topup_cny
           FROM payments
          WHERE user_id = $1 AND status = 'paid' AND paid_at IS NOT NULL
            AND paid_at >= now() - INTERVAL '30 days'
          GROUP BY 1
       )
       SELECT to_char(days.d, 'YYYY-MM-DD') AS day,
              COALESCE(spend.spend_usd, 0)::float8 AS spend_usd,
              COALESCE(topup.topup_cny, 0)::float8 AS topup_cny
         FROM days
         LEFT JOIN spend ON spend.d = days.d
         LEFT JOIN topup ON topup.d = days.d
        ORDER BY days.d`,
      [userId],
    ),
  ])

  const historyRows = historyRes.rows as any[]
  const history: SubscriptionHistoryRow[] = historyRows.map((r) => ({
    id: String(r.id),
    status: String(r.status),
    plan_name: String(r.plan_name),
    plan_type: String(r.plan_type),
    plan_subtype: r.plan_subtype ?? null,
    starts_at: isoOrNull(r.starts_at),
    expires_at: isoOrNull(r.expires_at),
    balance: num(r.balance),
    price: num(r.price),
    currency: String(r.currency ?? 'CNY'),
    created_at: isoOrNull(r.created_at) ?? '',
  }))

  const actives = history.filter((r) => r.status === 'active')
  const activeSubscriptions: ActiveSubscription[] = actives.map((r) => ({
    id: r.id,
    status: r.status,
    plan_name: r.plan_name,
    plan_type: r.plan_type,
    plan_subtype: r.plan_subtype,
    starts_at: r.starts_at,
    expires_at: r.expires_at,
    balance: r.balance,
    price: r.price,
    currency: r.currency,
  }))
  // Back-compat: prefer quota-type active subscription; else most recent active.
  const preferredActive =
    activeSubscriptions.find((r) => r.plan_type === 'quota') ??
    activeSubscriptions[0] ??
    null
  const activeSubscription = preferredActive

  const activeBalanceRow = activeBalanceRes.rows[0] as any | undefined
  const balanceCurrency =
    (activeBalanceRow?.currency as string | undefined) ??
    preferredActive?.currency ??
    history[0]?.currency ??
    'CNY'

  const balance: BillingSummary = {
    current_balance: num(activeBalanceRow?.current_balance),
    total_topup: num((topupRes.rows[0] as any)?.total_topup),
    total_spend: num((spendRes.rows[0] as any)?.total_spend),
    currency: balanceCurrency,
  }

  const payments: PaymentRow[] = (paymentsRes.rows as any[]).map((r) => ({
    id: String(r.id),
    amount: num(r.amount),
    out_trade_no: String(r.out_trade_no ?? ''),
    trade_no: r.trade_no ?? null,
    status: String(r.status ?? ''),
    paid_at: isoOrNull(r.paid_at),
    created_at: isoOrNull(r.created_at) ?? '',
  }))

  const poolRow = poolRes.rows[0] as any | undefined
  const quotaRow = quotaRes.rows[0] as any | undefined

  const wallet: Wallet = {
    pool: poolRow
      ? {
          subscription_id: String(poolRow.id),
          plan_name: String(poolRow.plan_name),
          plan_subtype: poolRow.plan_subtype ?? null,
          balance: num(poolRow.balance),
          expires_at: isoOrNull(poolRow.expires_at),
          starts_at: isoOrNull(poolRow.starts_at),
          usable: computeUsable(poolRow),
          caps: buildCaps(poolRow),
        }
      : null,
    quota: quotaRow
      ? {
          subscription_id: String(quotaRow.id),
          plan_name: String(quotaRow.plan_name),
          balance: num(quotaRow.balance),
        }
      : null,
    consumption_order: 'pool_first',
  }

  const dailyUsage: DailyUsage[] = (dailyRes.rows as any[]).map((r) => ({
    day: String(r.day),
    spend_usd: num(r.spend_usd),
    topup_cny: num(r.topup_cny),
  }))

  return {
    activeSubscription,
    activeSubscriptions,
    wallet,
    dailyUsage,
    subscriptionHistory: history,
    balance,
    payments,
  }
}

const router = Router()
router.use(authMiddleware)
router.get('/billing', async (req, res) => {
  try {
    res.json(await loadBilling(req.user!.userId))
  } catch (err) {
    console.error('Billing fetch error:', err)
    res.status(500).json({ error: 'Failed to load billing' })
  }
})
export default router
