import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { adminMiddleware } from '../middleware/admin.js'
import { query } from '../db.js'

export type Slice = 'time' | 'group' | 'account' | 'user' | 'model'
export type Granularity = 'hour' | 'day'

export interface LoadOverviewOpts {
  slice: Slice
  granularity: Granularity
  since: Date
  until: Date
}

export interface OverviewKpis {
  total: number
  successRate: number
  blocked: number
  activeAccounts: number
  activeUsers: number
  totalTokens: number
}

export interface OverviewSeriesPoint {
  t: string | Date
  label: string
  v: number
}

export interface TopEntry {
  label: string
  v: number
}

export interface OverviewResult {
  kpis: OverviewKpis
  series: OverviewSeriesPoint[]
  top: {
    users: TopEntry[]
    models: TopEntry[]
    clients: TopEntry[]
    blocks: TopEntry[]
  }
  groupKey: string
}

const VALID_SLICES: Slice[] = ['time', 'group', 'account', 'user', 'model']

export async function loadOverview(opts: LoadOverviewOpts): Promise<OverviewResult> {
  const trunc = opts.granularity === 'hour' ? 'hour' : 'day'
  const args = [opts.since.toISOString(), opts.until.toISOString()]

  // KPIs: one query against request_logs + one against usage_records
  const kpiRes = await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE response_status BETWEEN 200 AND 299 AND block_reason IS NULL)::int AS ok,
       COUNT(*) FILTER (WHERE block_reason IS NOT NULL)::int AS blocked,
       COUNT(DISTINCT oauth_account_id) FILTER (WHERE oauth_account_id IS NOT NULL)::int AS active_accounts
     FROM request_logs
     WHERE created_at >= $1 AND created_at < $2`,
    args,
  )
  const kpi = kpiRes.rows[0] ?? { total: 0, ok: 0, blocked: 0, active_accounts: 0 }

  const activeUsersRes = await query(
    `SELECT COUNT(DISTINCT c.user_id)::int AS active_users
       FROM request_logs rl
       JOIN clients c ON c.id = rl.client_id
      WHERE rl.created_at >= $1 AND rl.created_at < $2`,
    args,
  )
  const activeUsers = activeUsersRes.rows[0]?.active_users ?? 0

  const tokensRes = await query(
    `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read + cache_write), 0)::bigint AS total_tokens
       FROM usage_records
      WHERE created_at >= $1 AND created_at < $2`,
    args,
  )
  const totalTokens = Number(tokensRes.rows[0]?.total_tokens ?? 0)

  // Series by slice — build dynamically with same parameterised time bounds.
  let groupKey = 'total'
  let series: OverviewSeriesPoint[] = []

  if (opts.slice === 'time') {
    const r = await query(
      `SELECT date_trunc('${trunc}', created_at) AS t, COUNT(*)::int AS v
         FROM request_logs
        WHERE created_at >= $1 AND created_at < $2
        GROUP BY t ORDER BY t`,
      args,
    )
    series = r.rows.map((row: any) => ({ t: row.t, label: 'total', v: row.v }))
  } else if (opts.slice === 'group') {
    groupKey = 'group_name'
    const r = await query(
      `SELECT date_trunc('${trunc}', rl.created_at) AS t,
              COALESCE(g.name, '(none)') AS label,
              COUNT(*)::int AS v
         FROM request_logs rl
         JOIN clients c ON c.id = rl.client_id
         LEFT JOIN account_groups g ON g.id = c.group_id
        WHERE rl.created_at >= $1 AND rl.created_at < $2
        GROUP BY t, label ORDER BY t`,
      args,
    )
    series = r.rows
  } else if (opts.slice === 'account') {
    groupKey = 'oauth_account'
    const r = await query(
      `SELECT date_trunc('${trunc}', rl.created_at) AS t,
              COALESCE(oa.name, rl.oauth_account_name, '(none)') AS label,
              COUNT(*)::int AS v
         FROM request_logs rl
         LEFT JOIN oauth_accounts oa ON oa.id = rl.oauth_account_id
        WHERE rl.created_at >= $1 AND rl.created_at < $2
        GROUP BY t, label ORDER BY t`,
      args,
    )
    series = r.rows
  } else if (opts.slice === 'user') {
    groupKey = 'user_email'
    const r = await query(
      `SELECT date_trunc('${trunc}', rl.created_at) AS t,
              COALESCE(u.email, '(unknown)') AS label,
              COUNT(*)::int AS v
         FROM request_logs rl
         JOIN clients c ON c.id = rl.client_id
         LEFT JOIN users u ON u.id = c.user_id
        WHERE rl.created_at >= $1 AND rl.created_at < $2
        GROUP BY t, label ORDER BY t`,
      args,
    )
    series = r.rows
  } else if (opts.slice === 'model') {
    groupKey = 'request_model'
    const r = await query(
      `SELECT date_trunc('${trunc}', created_at) AS t,
              COALESCE(request_model, 'unknown') AS label,
              COUNT(*)::int AS v
         FROM request_logs
        WHERE created_at >= $1 AND created_at < $2
        GROUP BY t, label ORDER BY t`,
      args,
    )
    series = r.rows
  }

  const [topUsers, topModels, topClients, topBlocks] = await Promise.all([
    query(
      `SELECT COALESCE(u.email, '(unknown)') AS label, COUNT(*)::int AS v
         FROM request_logs rl
         JOIN clients c ON c.id = rl.client_id
         LEFT JOIN users u ON u.id = c.user_id
        WHERE rl.created_at >= $1 AND rl.created_at < $2
        GROUP BY label ORDER BY v DESC LIMIT 10`,
      args,
    ),
    query(
      `SELECT COALESCE(request_model, 'unknown') AS label, COUNT(*)::int AS v
         FROM request_logs
        WHERE created_at >= $1 AND created_at < $2
        GROUP BY label ORDER BY v DESC LIMIT 10`,
      args,
    ),
    query(
      `SELECT COALESCE(c.name, rl.client_name, '(unknown)') AS label, COUNT(*)::int AS v
         FROM request_logs rl
         LEFT JOIN clients c ON c.id = rl.client_id
        WHERE rl.created_at >= $1 AND rl.created_at < $2
        GROUP BY label ORDER BY v DESC LIMIT 10`,
      args,
    ),
    query(
      `SELECT block_reason AS label, COUNT(*)::int AS v
         FROM request_logs
        WHERE created_at >= $1 AND created_at < $2
          AND block_reason IS NOT NULL
        GROUP BY label ORDER BY v DESC LIMIT 10`,
      args,
    ),
  ])

  const total = Number(kpi.total ?? 0)
  const ok = Number(kpi.ok ?? 0)
  const blocked = Number(kpi.blocked ?? 0)

  return {
    kpis: {
      total,
      successRate: total === 0 ? 1 : ok / total,
      blocked,
      activeAccounts: Number(kpi.active_accounts ?? 0),
      activeUsers: Number(activeUsers),
      totalTokens,
    },
    series,
    top: {
      users: topUsers.rows,
      models: topModels.rows,
      clients: topClients.rows,
      blocks: topBlocks.rows,
    },
    groupKey,
  }
}

const router = Router()

router.use(authMiddleware, adminMiddleware)

router.get('/overview', async (req, res, next) => {
  try {
    const rawSlice = String(req.query.slice ?? 'time')
    const slice: Slice = (VALID_SLICES as string[]).includes(rawSlice) ? (rawSlice as Slice) : 'time'
    const granularity: Granularity = req.query.granularity === 'hour' ? 'hour' : 'day'
    const until = req.query.until ? new Date(String(req.query.until)) : new Date()
    const since = req.query.since
      ? new Date(String(req.query.since))
      : new Date(until.getTime() - 7 * 86_400_000)
    const result = await loadOverview({ slice, granularity, since, until })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

export default router
