// GET /api/me/logs — user request logs with filters + cursor pagination.
// GET /api/me/logs/:traceId — single log detail (sanitized headers).
//
// Authorization: JOIN clients ON c.user_id = req.user.userId.
// Cross-user trace_id lookups MUST return 404.

import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { query } from '../db.js'

export async function loadMyLogs(opts: {
  userId: string
  limit?: number
  cursorCreatedAt?: string
  cursorId?: string
  clientId?: string
  blocked?: boolean
  model?: string
}) {
  const limit = Math.min(opts.limit ?? 50, 200)
  const args: unknown[] = [opts.userId]
  let extra = ''
  if (opts.cursorCreatedAt && opts.cursorId) {
    args.push(opts.cursorCreatedAt, opts.cursorId)
    extra += ` AND (rl.created_at, rl.id) < ($${args.length - 1}::timestamptz, $${args.length}::bigint)`
  }
  if (opts.clientId) { args.push(opts.clientId); extra += ` AND rl.client_id = $${args.length}` }
  if (opts.blocked === true) extra += ` AND rl.block_reason IS NOT NULL`
  if (opts.blocked === false) extra += ` AND rl.block_reason IS NULL`
  if (opts.model) { args.push(opts.model); extra += ` AND rl.request_model = $${args.length}` }

  const { rows } = await query(
    `SELECT rl.id::text, rl.trace_id, rl.created_at,
            c.name AS client_name, rl.method, rl.path,
            rl.request_model, rl.response_status,
            rl.latency_ms, rl.first_token_ms, rl.streaming,
            rl.error_message, rl.retry_count,
            rl.block_reason, rl.block_source,
            COALESCE(ur.input_tokens, 0)  AS input_tokens,
            COALESCE(ur.output_tokens, 0) AS output_tokens,
            COALESCE(ur.cache_write, 0)   AS cache_write,
            COALESCE(ur.cache_read, 0)    AS cache_read,
            COALESCE(ur.total_tokens, 0)  AS total_tokens,
            ur.cost                        AS cost,
            mp.model_pattern,
            mp.input_mtok,
            mp.output_mtok,
            mp.cache_read_mtok,
            mp.cache_write_mtok,
            sur.subscription_id::text      AS consumed_subscription_id,
            sp.name                        AS consumed_plan_name,
            sp.type                        AS consumed_plan_type,
            sub.balance                    AS current_balance,
            -- Prefer the snapshot column (usage_records.balance_after)
            -- written at metering time. Fallback: reconstruct via
            -- current_balance + SUM(later deductions) for rows recorded
            -- before migration 024.
            CASE
              WHEN sur.subscription_id IS NULL THEN NULL
              WHEN sur.balance_after IS NOT NULL THEN sur.balance_after
              ELSE sub.balance + COALESCE((
                SELECT SUM(ur2.cost)
                  FROM usage_records ur2
                  JOIN request_logs rl2 ON rl2.trace_id = ur2.trace_id
                 WHERE ur2.subscription_id = sur.subscription_id
                   AND rl2.created_at > rl.created_at
              ), 0)
            END                            AS consumed_balance_after
       FROM request_logs rl
       JOIN clients c ON c.id = rl.client_id
       LEFT JOIN LATERAL (
         SELECT SUM(input_tokens)::BIGINT  AS input_tokens,
                SUM(output_tokens)::BIGINT AS output_tokens,
                SUM(cache_write)::BIGINT   AS cache_write,
                SUM(cache_read)::BIGINT    AS cache_read,
                SUM(input_tokens + output_tokens + cache_write + cache_read)::BIGINT AS total_tokens,
                SUM(cost)::NUMERIC(14,6)   AS cost
           FROM usage_records
          WHERE trace_id = rl.trace_id
       ) ur ON TRUE
       LEFT JOIN LATERAL (
         SELECT subscription_id, balance_after
           FROM usage_records
          WHERE trace_id = rl.trace_id AND subscription_id IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1
       ) sur ON TRUE
       LEFT JOIN subscriptions sub ON sub.id = sur.subscription_id
       LEFT JOIN plans sp ON sp.id = sub.plan_id
       LEFT JOIN LATERAL (
         SELECT model_pattern, input_mtok, output_mtok,
                cache_read_mtok, cache_write_mtok
           FROM model_pricing
          WHERE rl.request_model IS NOT NULL
            AND rl.request_model LIKE model_pattern || '%'
          ORDER BY length(model_pattern) DESC, effective_from DESC
          LIMIT 1
       ) mp ON TRUE
      WHERE c.user_id = $1 ${extra}
      ORDER BY rl.created_at DESC, rl.id DESC
      LIMIT ${limit + 1}`,
    args as any[],
  )
  const hasMore = rows.length > limit
  const items = rows.slice(0, limit)
  const cursor = hasMore
    ? { createdAt: items[items.length - 1].created_at, id: items[items.length - 1].id }
    : null
  return { items, cursor }
}

export async function loadMyLogDetail(opts: { userId: string; traceId: string }) {
  // User-visible detail: request shape (method/path/model) + response shape
  // (status/latency/retries/error) + aggregated token usage from usage_records
  // (matched by trace_id). Bodies and headers are admin-only — user never
  // needs raw token / prompt / model output.
  const { rows } = await query(
    `SELECT rl.id::text, rl.trace_id, rl.created_at,
            c.name AS client_name, rl.method, rl.path,
            rl.request_model, rl.response_status,
            rl.latency_ms, rl.first_token_ms, rl.streaming,
            rl.error_message, rl.retry_count,
            rl.block_reason, rl.block_source,
            COALESCE(ur.input_tokens, 0)  AS input_tokens,
            COALESCE(ur.output_tokens, 0) AS output_tokens,
            COALESCE(ur.cache_write, 0)   AS cache_write,
            COALESCE(ur.cache_read, 0)    AS cache_read
       FROM request_logs rl
       JOIN clients c ON c.id = rl.client_id
       LEFT JOIN LATERAL (
         SELECT SUM(input_tokens)::BIGINT  AS input_tokens,
                SUM(output_tokens)::BIGINT AS output_tokens,
                SUM(cache_write)::BIGINT   AS cache_write,
                SUM(cache_read)::BIGINT    AS cache_read
           FROM usage_records
          WHERE trace_id = rl.trace_id
       ) ur ON TRUE
      WHERE c.user_id = $1 AND rl.trace_id = $2
      LIMIT 1`,
    [opts.userId, opts.traceId],
  )
  if (rows.length === 0) return null
  return rows[0]
}

const router = Router()
router.get('/logs', authMiddleware, async (req, res) => {
  const userId = req.user!.userId
  res.json(await loadMyLogs({
    userId,
    limit: Number(req.query.limit) || 50,
    cursorCreatedAt: req.query.cursor_at ? String(req.query.cursor_at) : undefined,
    cursorId: req.query.cursor_id ? String(req.query.cursor_id) : undefined,
    clientId: req.query.client_id ? String(req.query.client_id) : undefined,
    blocked: req.query.blocked === 'true' ? true : req.query.blocked === 'false' ? false : undefined,
    model: req.query.model ? String(req.query.model) : undefined,
  }))
})
router.get('/logs/:traceId', authMiddleware, async (req, res) => {
  const userId = req.user!.userId
  const d = await loadMyLogDetail({ userId, traceId: String(req.params.traceId) })
  if (!d) {
    res.status(404).json({ error: 'not found' })
    return
  }
  res.json(d)
})
export default router
