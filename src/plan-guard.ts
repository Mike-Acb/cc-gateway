import { query } from './db.js'
import { log } from './logger.js'
import type { BlockReason } from './request-logger.js'

export type PlanGuardResult = {
  allowed: boolean
  reason?: string
  blockReason?: BlockReason
  subscriptionId?: string
  planType?: string
  /** USD pre-charged against the subscription for this request (0.025 by default). */
  prebillUsd?: number
}

// ── Active subscription row ────────────────────────────────────
// Extended with 4-window cap state so pool eligibility can be judged
// without a second round-trip. window_*_start is NULL until the first
// request of that window; window_*_used is a running NUMERIC(12,6).

type ActiveRow = {
  id: string
  balance: string | number | null
  expires_at: Date | string | null
  starts_at: Date | string | null
  created_at: Date | string | null
  remaining_uses: number | null
  plan_type: string
  plan_subtype: string | null
  limit_5h_usd: string | number | null
  limit_1d_usd: string | number | null
  limit_7d_usd: string | number | null
  limit_30d_usd: string | number | null
  window_5h_start: Date | string | null
  window_5h_used: string | number | null
  window_1d_start: Date | string | null
  window_1d_used: string | number | null
  window_7d_start: Date | string | null
  window_7d_used: string | number | null
  window_30d_start: Date | string | null
  window_30d_used: string | number | null
}

async function fetchActives(userId: string): Promise<ActiveRow[]> {
  const result = await query(
    `SELECT s.id, s.balance, s.expires_at, s.starts_at, s.created_at, s.remaining_uses,
            p.type AS plan_type, p.subtype AS plan_subtype,
            p.limit_5h_usd, p.limit_1d_usd, p.limit_7d_usd, p.limit_30d_usd,
            s.window_5h_start,  s.window_5h_used,
            s.window_1d_start,  s.window_1d_used,
            s.window_7d_start,  s.window_7d_used,
            s.window_30d_start, s.window_30d_used
       FROM subscriptions s
       JOIN plans p ON s.plan_id = p.id
      WHERE s.user_id = $1 AND s.status = 'active'
      ORDER BY s.created_at DESC`,
    [userId],
  )
  return result.rows as ActiveRow[]
}

function isExhausted(sub: ActiveRow): boolean {
  if (sub.plan_subtype === 'per_use' && sub.remaining_uses !== null && sub.remaining_uses <= 0) return true
  // Pool eligibility is governed by 4-cap windows + expiry, not by balance. Balance
  // on pool is only a running audit tally (prebill deductions + reconciled cost).
  if (sub.plan_type === 'pool') return false
  return parseFloat(String(sub.balance ?? 0)) <= 0
}

function isExpired(sub: ActiveRow): boolean {
  return Boolean(sub.expires_at && new Date(sub.expires_at as any) < new Date())
}

function numOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

function toDateOrNull(v: Date | string | null | undefined): Date | null {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

// ── Window helpers ─────────────────────────────────────────────
//
// All windows are judged from the client's perspective of "now":
//   - 5h : start rounded down to the hour of the first request, window = 5h
//   - 1d : start = first-request calendar day in Asia/Shanghai (UTC+8)
//   - 7d : start rounded down to the hour of the first request, window = 7d
//   - 30d: start = subscription.starts_at (or created_at), window = 30d; rolls
//
// Caps are evaluated on the CURRENT (un-expired) window's window_*_used.
// If the stored window has already lapsed, the used counter is treated as 0
// for gate purposes — the actual reset happens in recordPlanUsage.

function isWindowExpired(
  windowStart: Date | null,
  kind: '5h' | '1d' | '7d' | '30d',
  now: Date,
): boolean {
  if (!windowStart) return true  // never initialized — nothing consumed yet
  switch (kind) {
    case '5h':  return now.getTime() >= windowStart.getTime() + 5 * 60 * 60 * 1000
    case '1d': {
      // Treat [windowStart, windowStart + 24h) as the day. windowStart is set
      // by recordPlanUsage to the UTC+8 midnight of the first request — so the
      // next midnight is simply +24h later.
      return now.getTime() >= windowStart.getTime() + 24 * 60 * 60 * 1000
    }
    case '7d':  return now.getTime() >= windowStart.getTime() + 7 * 24 * 60 * 60 * 1000
    case '30d': return now.getTime() >= windowStart.getTime() + 30 * 24 * 60 * 60 * 1000
  }
}

/**
 * Decide if a pool subscription has exceeded ANY of the 4 configured caps.
 * Returns null if allowed; otherwise a short reason for logging.
 */
function poolCapExceeded(sub: ActiveRow, now: Date): string | null {
  const limits: Array<{ kind: '5h' | '1d' | '7d' | '30d'; limit: number | null; used: number; start: Date | null }> = [
    { kind: '5h',  limit: numOrNull(sub.limit_5h_usd),  used: parseFloat(String(sub.window_5h_used  ?? 0)), start: toDateOrNull(sub.window_5h_start) },
    { kind: '1d',  limit: numOrNull(sub.limit_1d_usd),  used: parseFloat(String(sub.window_1d_used  ?? 0)), start: toDateOrNull(sub.window_1d_start) },
    { kind: '7d',  limit: numOrNull(sub.limit_7d_usd),  used: parseFloat(String(sub.window_7d_used  ?? 0)), start: toDateOrNull(sub.window_7d_start) },
    { kind: '30d', limit: numOrNull(sub.limit_30d_usd), used: parseFloat(String(sub.window_30d_used ?? 0)), start: toDateOrNull(sub.window_30d_start) },
  ]
  for (const l of limits) {
    if (l.limit === null) continue             // NULL = unlimited
    if (isWindowExpired(l.start, l.kind, now)) continue  // lapsed → used treated as 0
    if (l.used >= l.limit) return `pool cap ${l.kind} exhausted (${l.used.toFixed(6)} / ${l.limit})`
  }
  return null
}

// ── Prebill cache ──────────────────────────────────────────────

const PREBILL_CACHE_MS = 30_000
let cachedPrebill = 0.025
let cachedPrebillAt = 0

export async function getPrebillUsd(): Promise<number> {
  const now = Date.now()
  if (now - cachedPrebillAt < PREBILL_CACHE_MS) return cachedPrebill
  try {
    const res = await query("SELECT value FROM system_settings WHERE key = 'prebill_usd'")
    if (res.rows.length > 0) {
      const v = parseFloat(String(res.rows[0].value))
      if (Number.isFinite(v) && v >= 0) cachedPrebill = v
    }
  } catch (err) {
    log('debug', `plan-guard: getPrebillUsd fallback: ${err}`)
  }
  cachedPrebillAt = now
  return cachedPrebill
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Check if user has an active subscription that allows this request, then
 * pre-charge `prebill_usd` from the chosen subscription's balance.
 *
 * Priority: pool (subscription) > quota (wallet).
 * Pool is preferred because it has a fixed expiry window — use it before it
 * lapses. A pool sub is considered unavailable when it is exhausted, expired,
 * or any of its 4 caps has been hit for the currently active window. In that
 * case we fall through to quota.
 *
 * Allowed → balance decremented by prebillUsd (may go negative; reconciled
 * post-response by recordPlanUsage). Window counters are NOT touched here:
 * they are updated with the real cost in recordPlanUsage.
 *
 * Returns allowed:true with no subscriptionId if the user is absent
 * (config.yaml client).
 */
export async function checkPlanGuard(userId: string | undefined): Promise<PlanGuardResult> {
  if (!userId) return { allowed: true }

  try {
    const actives = await fetchActives(userId)

    if (actives.length === 0) {
      const anySub = await query('SELECT 1 FROM subscriptions WHERE user_id = $1 LIMIT 1', [userId])
      if (anySub.rows.length > 0) {
        return { allowed: false, reason: 'Subscription expired. Please renew at https://gw.example.com/plans', blockReason: 'quota_exceeded' }
      }
      return { allowed: false, reason: 'No active subscription. Please subscribe at https://gw.example.com/plans', blockReason: 'quota_exceeded' }
    }

    // Lazy sweep of expired pool subs
    for (const sub of actives) {
      if (sub.plan_type === 'pool' && isExpired(sub)) {
        await query("UPDATE subscriptions SET status = 'expired', updated_at = now() WHERE id = $1", [sub.id])
      }
    }

    const now = new Date()
    const prebill = await getPrebillUsd()

    // Pool: must also pass 4-cap gate
    const pool = actives.find((s) =>
      s.plan_type === 'pool'
      && !isExpired(s)
      && !isExhausted(s)
      && poolCapExceeded(s, now) === null,
    )
    if (pool) {
      await deductPrebill(pool.id, prebill)
      return { allowed: true, subscriptionId: pool.id, planType: 'pool', prebillUsd: prebill }
    }

    const quota = actives.find((s) => s.plan_type === 'quota' && !isExhausted(s))
    if (quota) {
      await deductPrebill(quota.id, prebill)
      return { allowed: true, subscriptionId: quota.id, planType: 'quota', prebillUsd: prebill }
    }

    // Everything exhausted / expired / capped
    const hasPool = actives.some((s) => s.plan_type === 'pool')
    const hasQuota = actives.some((s) => s.plan_type === 'quota')
    const capHit = actives.find((s) => s.plan_type === 'pool' && !isExpired(s) && !isExhausted(s) && poolCapExceeded(s, now) !== null)
    const reason = capHit
      ? 'Subscription usage cap reached for this window. Please wait or upgrade at https://gw.example.com/plans'
      : hasPool && hasQuota
      ? 'Both subscription and quota exhausted. Please recharge at https://gw.example.com/plans'
      : hasPool
      ? 'Subscription usage exhausted. Please renew or add quota at https://gw.example.com/plans'
      : 'Quota exhausted. Please recharge at https://gw.example.com/plans'
    return { allowed: false, reason, blockReason: 'quota_exceeded' }
  } catch (err) {
    log('error', `Plan guard error: ${err}`)
    return { allowed: true }
  }
}

async function deductPrebill(subscriptionId: string, prebill: number): Promise<void> {
  if (prebill <= 0) return
  try {
    await query(
      'UPDATE subscriptions SET balance = balance - $1, updated_at = now() WHERE id = $2',
      [prebill, subscriptionId],
    )
  } catch (err) {
    log('error', `Plan guard prebill deduct error (sub=${subscriptionId}): ${err}`)
  }
}

/**
 * Reconcile the real cost after the upstream response completes.
 *
 * - Balance delta = realCost - prebillUsd (compensate the pre-charge).
 * - For pool subs only: increment the 4 window_*_used counters, resetting any
 *   window that has lapsed before adding this cost and stamping a fresh
 *   window_*_start. The 30d window start comes from starts_at / created_at
 *   initially, then rolls every 30 days. The 1d window snaps to UTC+8 midnight.
 *
 * All work is done in a single UPDATE using CASE expressions so that the state
 * transition (expired → reset vs. active → add) is atomic. `windowTimestamp`
 * should be the request start time (ms) so that late-arriving post-response
 * settlements still hit the window that was active when the request fired.
 */
export async function recordPlanUsage(
  subscriptionId: string,
  planType: string,
  realCost: number,
  prebillUsd: number = 0,
  windowTimestamp?: Date | number,
): Promise<number | null> {
  // Returns the balance AFTER this deduction, so the caller can snapshot it
  // onto usage_records. Returns null on error so callers can store NULL.
  const delta = realCost - prebillUsd
  try {
    if (planType !== 'pool') {
      const { rows } = await query(
        'UPDATE subscriptions SET balance = balance - $1, updated_at = now() WHERE id = $2 RETURNING balance',
        [delta, subscriptionId],
      )
      const b = rows[0]?.balance
      return b != null ? Number(b) : null
    }

    // Pool: balance + 4 windows in one round-trip.
    const ts = windowTimestamp
      ? (windowTimestamp instanceof Date ? windowTimestamp : new Date(windowTimestamp))
      : new Date()
    const tsIso = ts.toISOString()

    // Window start expressions. All are expressed as "start based on ts":
    //   5h / 7d : date_trunc('hour', ts) (UTC is fine; window length is a fixed
    //             multiple of hours so the hourly alignment is preserved under
    //             any TZ conversion).
    //   1d       : UTC+8 midnight of ts. We compute
    //              (ts AT TIME ZONE 'Asia/Shanghai')::date AT TIME ZONE
    //              'Asia/Shanghai' → TIMESTAMPTZ.
    //   30d      : preserved from existing window_30d_start (first-request ts);
    //              falls back to subscriptions.starts_at → created_at → ts.
    //              Rolls every 30 days by adding floor((ts - start)/30d)*30d.
    //
    // For each window: if stored start is NULL or the window has expired for
    // `ts`, reset used → cost and start → new anchor. Otherwise used += cost.

    const sql = `
      UPDATE subscriptions SET
        balance = balance - $1,
        updated_at = now(),

        window_5h_used = CASE
          WHEN window_5h_start IS NULL OR $3::timestamptz >= window_5h_start + INTERVAL '5 hours'
            THEN $2::numeric
          ELSE window_5h_used + $2::numeric
        END,
        window_5h_start = CASE
          WHEN window_5h_start IS NULL OR $3::timestamptz >= window_5h_start + INTERVAL '5 hours'
            THEN date_trunc('hour', $3::timestamptz)
          ELSE window_5h_start
        END,

        window_1d_used = CASE
          WHEN window_1d_start IS NULL OR $3::timestamptz >= window_1d_start + INTERVAL '1 day'
            THEN $2::numeric
          ELSE window_1d_used + $2::numeric
        END,
        window_1d_start = CASE
          WHEN window_1d_start IS NULL OR $3::timestamptz >= window_1d_start + INTERVAL '1 day'
            THEN (($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date::timestamp AT TIME ZONE 'Asia/Shanghai')
          ELSE window_1d_start
        END,

        window_7d_used = CASE
          WHEN window_7d_start IS NULL OR $3::timestamptz >= window_7d_start + INTERVAL '7 days'
            THEN $2::numeric
          ELSE window_7d_used + $2::numeric
        END,
        window_7d_start = CASE
          WHEN window_7d_start IS NULL OR $3::timestamptz >= window_7d_start + INTERVAL '7 days'
            THEN date_trunc('hour', $3::timestamptz)
          ELSE window_7d_start
        END,

        window_30d_used = CASE
          WHEN window_30d_start IS NULL THEN $2::numeric
          WHEN $3::timestamptz >= window_30d_start + INTERVAL '30 days'
            THEN $2::numeric
          ELSE window_30d_used + $2::numeric
        END,
        window_30d_start = CASE
          WHEN window_30d_start IS NULL
            THEN COALESCE(starts_at, created_at, $3::timestamptz)
          WHEN $3::timestamptz >= window_30d_start + INTERVAL '30 days'
            THEN window_30d_start + (
              (floor(EXTRACT(EPOCH FROM ($3::timestamptz - window_30d_start)) / (30 * 86400))::int)
              * INTERVAL '30 days'
            )
          ELSE window_30d_start
        END
      WHERE id = $4
      RETURNING balance
    `
    const { rows } = await query(sql, [delta, realCost, tsIso, subscriptionId])
    const b = rows[0]?.balance
    return b != null ? Number(b) : null
  } catch (err) {
    log('error', `Record plan usage error: ${err}`)
    return null
  }
}
