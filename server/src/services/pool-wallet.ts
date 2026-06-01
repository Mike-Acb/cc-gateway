// pool-wallet.ts — shape a pool subscription row into { usable, caps } for wallet APIs.
//
// In M2+, pool eligibility is governed by 4 time-window caps (5h/1d/7d/30d), not by
// the legacy `balance` field. This helper takes a DB row that has JOIN'd the plan's
// limit_* columns + the subscription's window_* counters and computes:
//   - usable: true iff not-expired AND no cap is hit for its currently active window
//   - caps:   per-window { limit, used } or null (null = unlimited)
//
// Used by billing-me, dashboard, and admin user-detail endpoints to replace the old
// "balance ≤ 0 → unusable" logic.

export type CapKind = '5h' | '1d' | '7d' | '30d'

// windowStart is the ISO timestamp of the current active window's start,
// or null when the window hasn't been initialized yet (no usage, or the
// stored window has lapsed and will be reset on the next request).
// Window duration by kind: 5h → 5h, 1d → 24h, 7d → 7d, 30d → 30d.
// Reset happens at windowStart + duration.
export type PoolCapState =
  | { limit: number; used: number; windowStart: string | null }
  | null

export type PoolRowWithCaps = {
  id: unknown
  plan_name: unknown
  plan_subtype?: unknown
  balance: unknown
  expires_at: unknown
  starts_at: unknown
  limit_5h_usd: unknown
  limit_1d_usd: unknown
  limit_7d_usd: unknown
  limit_30d_usd: unknown
  window_5h_start: unknown
  window_5h_used: unknown
  window_1d_start: unknown
  window_1d_used: unknown
  window_7d_start: unknown
  window_7d_used: unknown
  window_30d_start: unknown
  window_30d_used: unknown
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'string' ? parseFloat(v) : Number(v)
  return Number.isFinite(n) ? n : null
}

function num(v: unknown): number {
  return numOrNull(v) ?? 0
}

function toDateOrNull(v: unknown): Date | null {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v as any)
  return Number.isNaN(d.getTime()) ? null : d
}

function isWindowExpired(start: Date | null, kind: CapKind, now: Date): boolean {
  if (!start) return true
  switch (kind) {
    case '5h':  return now.getTime() >= start.getTime() + 5 * 3600 * 1000
    case '1d':  return now.getTime() >= start.getTime() + 24 * 3600 * 1000
    case '7d':  return now.getTime() >= start.getTime() + 7 * 24 * 3600 * 1000
    case '30d': return now.getTime() >= start.getTime() + 30 * 24 * 3600 * 1000
  }
}

/** Build { '5h', '1d', '7d', '30d' } → {limit, used} | null. */
export function buildCaps(row: PoolRowWithCaps, now: Date = new Date()): Record<CapKind, PoolCapState> {
  const entries: Array<{ kind: CapKind; limit: unknown; start: unknown; used: unknown }> = [
    { kind: '5h',  limit: row.limit_5h_usd,  start: row.window_5h_start,  used: row.window_5h_used  },
    { kind: '1d',  limit: row.limit_1d_usd,  start: row.window_1d_start,  used: row.window_1d_used  },
    { kind: '7d',  limit: row.limit_7d_usd,  start: row.window_7d_start,  used: row.window_7d_used  },
    { kind: '30d', limit: row.limit_30d_usd, start: row.window_30d_start, used: row.window_30d_used },
  ]
  const out: Record<CapKind, PoolCapState> = { '5h': null, '1d': null, '7d': null, '30d': null }
  for (const e of entries) {
    const lim = numOrNull(e.limit)
    if (lim === null || lim <= 0) continue   // null / 0 = unlimited
    const start = toDateOrNull(e.start)
    const lapsed = isWindowExpired(start, e.kind, now)
    out[e.kind] = {
      limit: lim,
      used: lapsed ? 0 : num(e.used),
      windowStart: lapsed || !start ? null : start.toISOString(),
    }
  }
  return out
}

/** Pool is usable iff not expired AND no cap is hit for its currently active window. */
export function computeUsable(row: PoolRowWithCaps, now: Date = new Date()): boolean {
  const exp = toDateOrNull(row.expires_at)
  if (exp && exp.getTime() <= now.getTime()) return false
  const caps = buildCaps(row, now)
  for (const k of ['5h', '1d', '7d', '30d'] as CapKind[]) {
    const c = caps[k]
    if (c && c.used >= c.limit) return false
  }
  return true
}

/** SQL column list shared by wallet queries. Use as: `SELECT ${POOL_COLUMNS} FROM ...`. */
export const POOL_COLUMNS = `
  s.id, s.balance, s.expires_at, s.starts_at,
  p.name AS plan_name, p.subtype AS plan_subtype,
  p.limit_5h_usd, p.limit_1d_usd, p.limit_7d_usd, p.limit_30d_usd,
  s.window_5h_start,  s.window_5h_used,
  s.window_1d_start,  s.window_1d_used,
  s.window_7d_start,  s.window_7d_used,
  s.window_30d_start, s.window_30d_used
`
