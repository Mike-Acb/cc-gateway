import { Router } from 'express'
import { query, DEPLOYMENT } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { adminMiddleware } from '../middleware/admin.js'

const router = Router()
const adminRouter = Router()

// All routes require authentication
router.use(authMiddleware)
adminRouter.use(authMiddleware, adminMiddleware)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDateRange(range: string | undefined, from: string | undefined, to: string | undefined) {
  const now = new Date()
  let start: Date
  let end: Date = now

  switch (range) {
    case '5m':
      start = new Date(now.getTime() - 5 * 60 * 1000)
      break
    case '15m':
      start = new Date(now.getTime() - 15 * 60 * 1000)
      break
    case '1h':
      start = new Date(now.getTime() - 60 * 60 * 1000)
      break
    case '5h':
      start = new Date(now.getTime() - 5 * 60 * 60 * 1000)
      break
    case '1d':
      start = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      break
    case 'today':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      break
    case '7d':
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      break
    case '30d':
      start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      break
    case '90d':
      start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
      break
    case 'custom':
      if (!from || !to) throw new Error('from and to are required for custom range')
      start = new Date(from)
      end = new Date(to + 'T23:59:59.999Z')
      break
    default:
      start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  }

  return { start, end }
}

function num(v: unknown): number {
  return Number(v) || 0
}

/** Build a WHERE clause that scopes to the user's own clients (unless admin). */
function userScopeCondition(isAdmin: boolean, userId: string, params: unknown[], alias = 'ur') {
  if (isAdmin) {
    // Admin still scoped to current deployment
    params.push(DEPLOYMENT)
    return ` AND ${alias}.client_id IN (SELECT id FROM clients WHERE deployment = $${params.length})`
  }
  params.push(userId)
  const userIdx = params.length
  params.push(DEPLOYMENT)
  const depIdx = params.length
  return ` AND ${alias}.client_id IN (SELECT id FROM clients WHERE user_id = $${userIdx} AND deployment = $${depIdx})`
}

// ---------------------------------------------------------------------------
// User routes — mounted at /api/usage
// ---------------------------------------------------------------------------

// GET /api/usage/summary
router.get('/summary', async (req, res) => {
  try {
    const { range, from, to } = req.query as Record<string, string | undefined>
    const { start, end } = parseDateRange(range, from, to)
    const isAdmin = req.user!.role === 'admin'

    const params: unknown[] = [start, end]
    const scope = userScopeCondition(isAdmin, req.user!.userId, params)

    // Totals
    const totals = await query(
      `SELECT
         COUNT(*)::bigint            AS total_requests,
         COALESCE(SUM(input_tokens), 0)  AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
         COALESCE(SUM(cache_read), 0)    AS total_cache_read,
         COALESCE(SUM(cache_write), 0)   AS total_cache_write,
         COALESCE(SUM(cost), 0)          AS total_cost
       FROM usage_records ur
       WHERE ur.created_at >= $1 AND ur.created_at <= $2${scope}`,
      params
    )

    // By model
    const modelParams: unknown[] = [start, end]
    const modelScope = userScopeCondition(isAdmin, req.user!.userId, modelParams)
    const byModel = await query(
      `SELECT
         model,
         COALESCE(SUM(input_tokens), 0)  AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cost), 0)          AS cost
       FROM usage_records ur
       WHERE ur.created_at >= $1 AND ur.created_at <= $2${modelScope}
       GROUP BY model
       ORDER BY cost DESC`,
      modelParams
    )

    // By client
    const clientParams: unknown[] = [start, end]
    const clientScope = userScopeCondition(isAdmin, req.user!.userId, clientParams)
    const byClient = await query(
      `SELECT
         ur.client_id,
         c.name AS client_name,
         c.status AS client_status,
         u.username AS owner_username,
         COUNT(*)::bigint AS requests,
         COALESCE(SUM(ur.input_tokens), 0) AS input_tokens,
         COALESCE(SUM(ur.output_tokens), 0) AS output_tokens,
         COALESCE(SUM(ur.cache_read), 0) AS cache_read,
         COALESCE(SUM(ur.cache_write), 0) AS cache_write,
         COALESCE(SUM(ur.input_tokens + ur.output_tokens + ur.cache_read + ur.cache_write), 0) AS total_tokens,
         COALESCE(SUM(ur.cost), 0) AS cost
       FROM usage_records ur
       JOIN clients c ON c.id = ur.client_id
       JOIN users u ON c.user_id = u.id
       WHERE ur.created_at >= $1 AND ur.created_at <= $2${clientScope}
       GROUP BY ur.client_id, c.name, c.status, u.username
       ORDER BY cost DESC`,
      clientParams
    )

    const row = totals.rows[0]
    res.json({
      total_requests: num(row.total_requests),
      total_input_tokens: num(row.total_input_tokens),
      total_output_tokens: num(row.total_output_tokens),
      total_cache_read: num(row.total_cache_read),
      total_cache_write: num(row.total_cache_write),
      total_cost: num(row.total_cost),
      by_model: byModel.rows.map((r: any) => ({
        model: r.model,
        input_tokens: num(r.input_tokens),
        output_tokens: num(r.output_tokens),
        cost: num(r.cost),
      })),
      by_client: byClient.rows.map((r: any) => ({
        client_id: r.client_id,
        client_name: r.client_name,
        status: r.client_status,
        owner: r.owner_username,
        requests: num(r.requests),
        input_tokens: num(r.input_tokens),
        output_tokens: num(r.output_tokens),
        cache_read: num(r.cache_read),
        cache_write: num(r.cache_write),
        total_tokens: num(r.total_tokens),
        cost: num(r.cost),
      })),
    })
  } catch (err: any) {
    console.error('Usage summary error:', err)
    res.status(err.message?.includes('required') ? 400 : 500).json({ error: err.message ?? 'Failed to get usage summary' })
  }
})

// GET /api/usage/timeline
router.get('/timeline', async (req, res) => {
  try {
    const { range, granularity: gran } = req.query as Record<string, string | undefined>
    const { start, end } = parseDateRange(range, undefined, undefined)
    const isAdmin = req.user!.role === 'admin'

    // Map granularity to a SQL expression
    // PG date_trunc supports: minute, hour, day
    // For N-minute intervals, use floor(epoch / N) * N
    let timeExpr: string
    const g = gran ?? 'day'
    if (g === 'day' || g === 'hour' || g === 'minute') {
      timeExpr = `date_trunc('${g}', ur.created_at)`
    } else if (g === '5min') {
      timeExpr = `to_timestamp(floor(extract(epoch from ur.created_at) / 300) * 300)`
    } else if (g === '15min') {
      timeExpr = `to_timestamp(floor(extract(epoch from ur.created_at) / 900) * 900)`
    } else if (g === '1min') {
      timeExpr = `date_trunc('minute', ur.created_at)`
    } else {
      timeExpr = `date_trunc('day', ur.created_at)`
    }

    const params: unknown[] = [start, end]
    const scope = userScopeCondition(isAdmin, req.user!.userId, params)

    const result = await query(
      `SELECT
         ${timeExpr} AS time,
         COALESCE(SUM(input_tokens), 0)  AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read), 0)    AS cache_read,
         COALESCE(SUM(cache_write), 0)   AS cache_write,
         COALESCE(SUM(cost), 0)          AS cost,
         COUNT(*)::bigint                AS requests
       FROM usage_records ur
       WHERE ur.created_at >= $1 AND ur.created_at <= $2${scope}
       GROUP BY 1
       ORDER BY 1`,
      params
    )

    // Build a map of DB results keyed by timestamp
    const dataMap = new Map<number, any>()
    for (const r of result.rows) {
      const ts = new Date(r.time).getTime()
      dataMap.set(ts, {
        time: r.time,
        input_tokens: num(r.input_tokens),
        output_tokens: num(r.output_tokens),
        cache_read: num(r.cache_read),
        cache_write: num(r.cache_write),
        cost: num(r.cost),
        requests: num(r.requests),
      })
    }

    // Generate complete time series with empty slots
    const intervalMs: Record<string, number> = {
      '1min': 60_000,
      '5min': 300_000,
      '15min': 900_000,
      hour: 3_600_000,
      day: 86_400_000,
    }
    const step = intervalMs[g] ?? 3_600_000
    const startMs = Math.floor(start.getTime() / step) * step
    const endMs = end.getTime()
    const points: any[] = []

    for (let t = startMs; t <= endMs; t += step) {
      const existing = dataMap.get(t)
      if (existing) {
        points.push(existing)
      } else {
        points.push({
          time: new Date(t).toISOString(),
          input_tokens: 0,
          output_tokens: 0,
          cache_read: 0,
          cache_write: 0,
          cost: 0,
          requests: 0,
        })
      }
    }

    res.json({ points })
  } catch (err) {
    console.error('Usage timeline error:', err)
    res.status(500).json({ error: 'Failed to get usage timeline' })
  }
})

// GET /api/usage/records
router.get('/records', async (req, res) => {
  try {
    const { client_id, page: pageStr, limit: limitStr } = req.query as Record<string, string | undefined>
    const page = Math.max(1, parseInt(pageStr ?? '1', 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(limitStr ?? '50', 10) || 50))
    const offset = (page - 1) * limit
    const isAdmin = req.user!.role === 'admin'

    const conditions: string[] = []
    const params: unknown[] = []

    if (client_id) {
      params.push(client_id)
      conditions.push(`ur.client_id = $${params.length}`)
    }

    if (!isAdmin) {
      params.push(req.user!.userId)
      const userIdx = params.length
      params.push(DEPLOYMENT)
      const depIdx = params.length
      conditions.push(`ur.client_id IN (SELECT id FROM clients WHERE user_id = $${userIdx} AND deployment = $${depIdx})`)
    } else {
      params.push(DEPLOYMENT)
      conditions.push(`ur.client_id IN (SELECT id FROM clients WHERE deployment = $${params.length})`)
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''

    // Count
    const countResult = await query(
      `SELECT COUNT(*)::bigint AS total FROM usage_records ur ${where}`,
      params
    )
    const total = num(countResult.rows[0].total)
    const pages = Math.ceil(total / limit) || 1

    // Data
    const dataParams = [...params, limit, offset]
    const result = await query(
      `SELECT
         ur.id, ur.client_id, c.name AS client_name, ur.model,
         ur.input_tokens, ur.output_tokens, ur.cache_read, ur.cache_write,
         ur.cost, ur.latency_ms, ur.status_code, ur.created_at
       FROM usage_records ur
       JOIN clients c ON c.id = ur.client_id
       ${where}
       ORDER BY ur.created_at DESC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    )

    res.json({
      data: result.rows.map((r: any) => ({
        id: r.id,
        client_id: r.client_id,
        client_name: r.client_name,
        model: r.model,
        input_tokens: num(r.input_tokens),
        output_tokens: num(r.output_tokens),
        cache_read: num(r.cache_read),
        cache_write: num(r.cache_write),
        cost: num(r.cost),
        latency_ms: num(r.latency_ms),
        status_code: num(r.status_code),
        created_at: r.created_at,
      })),
      total,
      page,
      pages,
    })
  } catch (err) {
    console.error('Usage records error:', err)
    res.status(500).json({ error: 'Failed to get usage records' })
  }
})

// ---------------------------------------------------------------------------
// Admin routes — mounted at /api/admin/usage
// ---------------------------------------------------------------------------

// GET /api/admin/usage/overview
adminRouter.get('/overview', async (_req, res) => {
  try {
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

    const [usersResult, clientsResult, todayResult, monthResult] = await Promise.all([
      query(`SELECT COUNT(*)::bigint AS total FROM users WHERE deployment = $1`, [DEPLOYMENT]),
      query(`SELECT COUNT(*)::bigint AS total FROM clients WHERE status = 'active' AND deployment = $1`, [DEPLOYMENT]),
      query(
        `SELECT COUNT(*)::bigint AS total_requests, COALESCE(SUM(cost), 0) AS total_cost
         FROM usage_records ur
         WHERE ur.created_at >= $1
           AND ur.client_id IN (SELECT id FROM clients WHERE deployment = $2)`,
        [todayStart, DEPLOYMENT]
      ),
      query(
        `SELECT COUNT(*)::bigint AS total_requests, COALESCE(SUM(cost), 0) AS total_cost
         FROM usage_records ur
         WHERE ur.created_at >= $1
           AND ur.client_id IN (SELECT id FROM clients WHERE deployment = $2)`,
        [monthStart, DEPLOYMENT]
      ),
    ])

    res.json({
      total_users: num(usersResult.rows[0].total),
      active_clients: num(clientsResult.rows[0].total),
      total_requests_today: num(todayResult.rows[0].total_requests),
      total_cost_today: num(todayResult.rows[0].total_cost),
      total_requests_month: num(monthResult.rows[0].total_requests),
      total_cost_month: num(monthResult.rows[0].total_cost),
    })
  } catch (err) {
    console.error('Admin usage overview error:', err)
    res.status(500).json({ error: 'Failed to get usage overview' })
  }
})

// GET /api/admin/usage/ranking
adminRouter.get('/ranking', async (req, res) => {
  try {
    const { range, metric, limit: limitStr } = req.query as Record<string, string | undefined>
    const limit = Math.min(100, Math.max(1, parseInt(limitStr ?? '10', 10) || 10))
    const { start, end } = parseDateRange(range ?? '30d', undefined, undefined)

    let orderCol: string
    switch (metric) {
      case 'tokens':
        orderCol = 'total_tokens'
        break
      case 'requests':
        orderCol = 'request_count'
        break
      case 'cost':
      default:
        orderCol = 'total_cost'
    }

    const result = await query(
      `SELECT
         u.id AS user_id,
         u.username,
         COALESCE(SUM(ur.input_tokens + ur.output_tokens), 0) AS total_tokens,
         COALESCE(SUM(ur.cost), 0)   AS total_cost,
         COUNT(*)::bigint            AS request_count
       FROM usage_records ur
       JOIN clients c ON c.id = ur.client_id
       JOIN users u ON u.id = c.user_id
       WHERE ur.created_at >= $1 AND ur.created_at <= $2
         AND c.deployment = $4 AND u.deployment = $4
       GROUP BY u.id, u.username
       ORDER BY ${orderCol} DESC
       LIMIT $3`,
      [start, end, limit, DEPLOYMENT]
    )

    res.json({
      rankings: result.rows.map((r: any) => ({
        user_id: r.user_id,
        username: r.username,
        total_tokens: num(r.total_tokens),
        total_cost: num(r.total_cost),
        request_count: num(r.request_count),
      })),
    })
  } catch (err) {
    console.error('Admin usage ranking error:', err)
    res.status(500).json({ error: 'Failed to get usage ranking' })
  }
})

export { router as usageRouter, adminRouter as adminUsageRouter }
export default router
