// GET /api/me/dashboard?window=24h|7d|30d — user dashboard aggregator.
//
// Returns KPIs + trend + top clients/models + recent blocks + current subscription
// for the authenticated user over the selected window.

import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { query } from '../db.js'
import { POOL_COLUMNS, buildCaps, computeUsable, type CapKind, type PoolCapState } from '../services/pool-wallet.js'

export type DashboardWindow = '24h' | '7d' | '30d'

export type TrendPoint = { bucket: string; success: number; blocked: number; total: number }
export type ModelTrendPoint = { bucket: string; model: string; count: number; tokens: number }

export type DashboardDTO = {
  window: DashboardWindow
  bucket: 'hour' | 'day'
  since: string
  until: string
  kpis: {
    requestCount: number
    successRate: number // 0..1
    blockedCount: number
    tokenCount: number
  }
  trend: TrendPoint[]
  modelTrend: ModelTrendPoint[]
  topClients: Array<{ name: string; count: number; tokens: number }>
  topModels: Array<{ model: string; count: number; tokens: number }>
  recentBlocks: Array<{
    id: string
    created_at: string
    client_name: string
    request_model: string | null
    block_reason: string | null
    block_source: string | null
    response_status: number | null
  }>
  wallet: {
    pool: {
      subscription_id: string
      plan_name: string
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
}

function parseWindow(raw: unknown): DashboardWindow {
  const v = String(raw ?? '24h')
  if (v === '24h' || v === '7d' || v === '30d') return v
  return '24h'
}

type WindowSpec = {
  intervalSql: string
  bucket: 'hour' | 'day'
  bucketSql: string
  seriesSql: string
}

function windowSpec(w: DashboardWindow): WindowSpec {
  // Bucket granularity: hour for 24h, day otherwise.
  if (w === '24h') {
    return {
      intervalSql: `INTERVAL '24 hours'`,
      bucket: 'hour',
      bucketSql: `date_trunc('hour', rl.created_at)`,
      seriesSql: `generate_series(date_trunc('hour', now() - INTERVAL '23 hours'), date_trunc('hour', now()), INTERVAL '1 hour')`,
    }
  }
  const days = w === '30d' ? 30 : 7
  return {
    intervalSql: `INTERVAL '${days} days'`,
    bucket: 'day',
    bucketSql: `date_trunc('day', rl.created_at)`,
    seriesSql: `generate_series((now() - INTERVAL '${days - 1} days')::date, now()::date, INTERVAL '1 day')`,
  }
}

export async function loadDashboardForUser(
  userId: string,
  windowKey: DashboardWindow = '24h',
): Promise<DashboardDTO> {
  const spec = windowSpec(windowKey)
  const until = new Date()
  const [
    kpiRes,
    trendRes,
    modelTrendRes,
    topClientsRes,
    topModelsRes,
    blockRes,
    poolRes,
    quotaRes,
  ] = await Promise.all([
    query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE rl.block_reason IS NULL AND rl.response_status BETWEEN 200 AND 299)::int AS ok_cnt,
         COUNT(*) FILTER (WHERE rl.block_reason IS NOT NULL)::int AS blocked_cnt,
         COALESCE((
           SELECT SUM(ur.input_tokens + ur.output_tokens + ur.cache_read + ur.cache_write)
             FROM usage_records ur
             JOIN clients c2 ON c2.id = ur.client_id
            WHERE c2.user_id = $1 AND ur.created_at >= now() - ${spec.intervalSql}
         ), 0)::bigint AS token_total
       FROM request_logs rl
       JOIN clients c ON c.id = rl.client_id
       WHERE c.user_id = $1 AND rl.created_at >= now() - ${spec.intervalSql}`,
      [userId],
    ),
    query(
      `WITH base AS (
         SELECT ${spec.bucketSql} AS bucket,
                (rl.block_reason IS NULL AND rl.response_status BETWEEN 200 AND 299) AS is_ok,
                (rl.block_reason IS NOT NULL) AS is_blocked
           FROM request_logs rl
           JOIN clients c ON c.id = rl.client_id
          WHERE c.user_id = $1 AND rl.created_at >= now() - ${spec.intervalSql}
       )
       SELECT to_char(s, 'YYYY-MM-DD"T"HH24:MI:SS') AS bucket,
              COALESCE(SUM(CASE WHEN b.is_ok      THEN 1 ELSE 0 END), 0)::int AS success,
              COALESCE(SUM(CASE WHEN b.is_blocked THEN 1 ELSE 0 END), 0)::int AS blocked,
              COALESCE(COUNT(b.*), 0)::int                                    AS total
         FROM ${spec.seriesSql} s
         LEFT JOIN base b ON b.bucket = s
         GROUP BY s ORDER BY s`,
      [userId],
    ),
    query(
      `SELECT to_char(${spec.bucketSql}, 'YYYY-MM-DD"T"HH24:MI:SS') AS bucket,
              COALESCE(rl.request_model, 'unknown') AS model,
              COUNT(*)::int AS count,
              COALESCE(SUM(ur.input_tokens + ur.output_tokens + ur.cache_read + ur.cache_write), 0)::bigint AS tokens
         FROM request_logs rl
         JOIN clients c ON c.id = rl.client_id
         LEFT JOIN LATERAL (
           SELECT SUM(input_tokens)  AS input_tokens,
                  SUM(output_tokens) AS output_tokens,
                  SUM(cache_read)    AS cache_read,
                  SUM(cache_write)   AS cache_write
             FROM usage_records
            WHERE trace_id = rl.trace_id
         ) ur ON TRUE
        WHERE c.user_id = $1 AND rl.created_at >= now() - ${spec.intervalSql}
        GROUP BY 1, 2 ORDER BY 1, 2`,
      [userId],
    ),
    query(
      `SELECT c.name,
              COUNT(*)::int AS count,
              COALESCE(SUM(ur.input_tokens + ur.output_tokens + ur.cache_read + ur.cache_write), 0)::bigint AS tokens
         FROM request_logs rl
         JOIN clients c ON c.id = rl.client_id
         LEFT JOIN LATERAL (
           SELECT SUM(input_tokens)  AS input_tokens,
                  SUM(output_tokens) AS output_tokens,
                  SUM(cache_read)    AS cache_read,
                  SUM(cache_write)   AS cache_write
             FROM usage_records
            WHERE trace_id = rl.trace_id
         ) ur ON TRUE
        WHERE c.user_id = $1 AND rl.created_at >= now() - ${spec.intervalSql}
        GROUP BY c.name ORDER BY 2 DESC LIMIT 5`,
      [userId],
    ),
    query(
      `SELECT rl.request_model AS model,
              COUNT(*)::int AS count,
              COALESCE(SUM(ur.input_tokens + ur.output_tokens + ur.cache_read + ur.cache_write), 0)::bigint AS tokens
         FROM request_logs rl
         JOIN clients c ON c.id = rl.client_id
         LEFT JOIN LATERAL (
           SELECT SUM(input_tokens)  AS input_tokens,
                  SUM(output_tokens) AS output_tokens,
                  SUM(cache_read)    AS cache_read,
                  SUM(cache_write)   AS cache_write
             FROM usage_records
            WHERE trace_id = rl.trace_id
         ) ur ON TRUE
        WHERE c.user_id = $1 AND rl.created_at >= now() - ${spec.intervalSql}
          AND rl.request_model IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
      [userId],
    ),
    query(
      `SELECT rl.id::text AS id, rl.created_at, c.name AS client_name,
              rl.request_model, rl.block_reason, rl.block_source, rl.response_status
         FROM request_logs rl
         JOIN clients c ON c.id = rl.client_id
        WHERE c.user_id = $1 AND rl.block_reason IS NOT NULL
          AND rl.created_at >= now() - ${spec.intervalSql}
        ORDER BY rl.created_at DESC LIMIT 10`,
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
  ])

  const k = kpiRes.rows[0] ?? { total: 0, ok_cnt: 0, blocked_cnt: 0 }
  const total = Number(k.total ?? 0)
  const ok = Number(k.ok_cnt ?? 0)
  const blocked = Number(k.blocked_cnt ?? 0)
  const poolRow = poolRes.rows[0] as any | undefined
  const quotaRow = quotaRes.rows[0] as any | undefined
  const sinceMs =
    windowKey === '24h'
      ? until.getTime() - 24 * 60 * 60 * 1000
      : until.getTime() - (windowKey === '30d' ? 30 : 7) * 24 * 60 * 60 * 1000
  return {
    window: windowKey,
    bucket: spec.bucket,
    since: new Date(sinceMs).toISOString(),
    until: until.toISOString(),
    kpis: {
      requestCount: total,
      successRate: total === 0 ? 1 : ok / total,
      blockedCount: blocked,
      tokenCount: Number(k.token_total ?? 0),
    },
    trend: trendRes.rows.map((r: any) => ({
      bucket: String(r.bucket),
      success: Number(r.success ?? 0),
      blocked: Number(r.blocked ?? 0),
      total: Number(r.total ?? 0),
    })),
    modelTrend: modelTrendRes.rows.map((r: any) => ({
      bucket: String(r.bucket),
      model: String(r.model),
      count: Number(r.count ?? 0),
      tokens: Number(r.tokens ?? 0),
    })),
    topClients: topClientsRes.rows.map((r: any) => ({
      name: String(r.name),
      count: Number(r.count ?? 0),
      tokens: Number(r.tokens ?? 0),
    })),
    topModels: topModelsRes.rows.map((r: any) => ({
      model: String(r.model),
      count: Number(r.count ?? 0),
      tokens: Number(r.tokens ?? 0),
    })),
    recentBlocks: blockRes.rows,
    wallet: {
      pool: poolRow
        ? {
            subscription_id: String(poolRow.id),
            plan_name: String(poolRow.plan_name),
            balance: Number(poolRow.balance ?? 0),
            expires_at: poolRow.expires_at ? new Date(poolRow.expires_at).toISOString() : null,
            starts_at: poolRow.starts_at ? new Date(poolRow.starts_at).toISOString() : null,
            usable: computeUsable(poolRow),
            caps: buildCaps(poolRow),
          }
        : null,
      quota: quotaRow
        ? {
            subscription_id: String(quotaRow.id),
            plan_name: String(quotaRow.plan_name),
            balance: Number(quotaRow.balance ?? 0),
          }
        : null,
      consumption_order: 'pool_first',
    },
  }
}

const router = Router()
router.get('/dashboard', authMiddleware, async (req, res) => {
  const userId = req.user!.userId
  const windowKey = parseWindow(req.query.window)
  res.json(await loadDashboardForUser(userId, windowKey))
})
export default router
