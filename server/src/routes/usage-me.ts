// GET /api/me/usage — user usage with granularity + filters.
//
// Aggregates request_logs (joined to usage_records via trace_id for tokens)
// for the authenticated user, bucketed by day/hour with optional
// client_id / model filters.

import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { query } from '../db.js'

export type UsageBucket = {
  t: string
  client_id: string
  client_name: string
  model: string
  count: number
  tokens: number
  input_tokens: number
  output_tokens: number
  cache_read: number
  cache_write: number
  blocked: number
}

export async function loadUsage(opts: {
  userId: string
  granularity: 'hour' | 'day'
  since: Date
  until: Date
  clientId?: string
  model?: string
}): Promise<{ buckets: UsageBucket[] }> {
  const trunc = opts.granularity === 'hour' ? 'hour' : 'day'
  const args: unknown[] = [opts.userId, opts.since.toISOString(), opts.until.toISOString()]
  let extra = ''
  if (opts.clientId) { args.push(opts.clientId); extra += ` AND rl.client_id = $${args.length}` }
  if (opts.model)    { args.push(opts.model);    extra += ` AND rl.request_model = $${args.length}` }

  const { rows } = await query(
    `SELECT
       date_trunc('${trunc}', rl.created_at) AS t,
       rl.client_id::text AS client_id,
       c.name AS client_name,
       COALESCE(rl.request_model, 'unknown') AS model,
       COUNT(*)::int AS count,
       COALESCE(SUM(ur.input_tokens),  0)::bigint AS input_tokens,
       COALESCE(SUM(ur.output_tokens), 0)::bigint AS output_tokens,
       COALESCE(SUM(ur.cache_read),    0)::bigint AS cache_read,
       COALESCE(SUM(ur.cache_write),   0)::bigint AS cache_write,
       COALESCE(SUM(ur.input_tokens + ur.output_tokens + ur.cache_read + ur.cache_write), 0)::bigint AS tokens,
       COUNT(*) FILTER (WHERE rl.block_reason IS NOT NULL)::int AS blocked
     FROM request_logs rl
     JOIN clients c ON c.id = rl.client_id
     LEFT JOIN usage_records ur ON ur.trace_id = rl.trace_id
     WHERE c.user_id = $1 AND rl.created_at >= $2 AND rl.created_at < $3
     ${extra}
     GROUP BY t, rl.client_id, c.name, COALESCE(rl.request_model,'unknown')
     ORDER BY t, client_name, model`,
    args as any[],
  )
  return {
    buckets: rows.map((r: any) => ({
      t: r.t && typeof r.t.toISOString === 'function' ? r.t.toISOString() : String(r.t),
      client_id: r.client_id,
      client_name: r.client_name,
      model: r.model,
      count: Number(r.count ?? 0),
      tokens: Number(r.tokens ?? 0),
      input_tokens: Number(r.input_tokens ?? 0),
      output_tokens: Number(r.output_tokens ?? 0),
      cache_read: Number(r.cache_read ?? 0),
      cache_write: Number(r.cache_write ?? 0),
      blocked: Number(r.blocked ?? 0),
    })),
  }
}

const router = Router()
router.get('/usage', authMiddleware, async (req, res) => {
  const userId = req.user!.userId
  const granularity = (req.query.granularity === 'hour' ? 'hour' : 'day') as 'hour' | 'day'
  const since = req.query.since
    ? new Date(String(req.query.since))
    : new Date(Date.now() - (granularity === 'hour' ? 86400_000 : 30 * 86400_000))
  const until = req.query.until ? new Date(String(req.query.until)) : new Date()
  const clientId = req.query.client_id ? String(req.query.client_id) : undefined
  const model = req.query.model ? String(req.query.model) : undefined
  res.json(await loadUsage({ userId, granularity, since, until, clientId, model }))
})
export default router
