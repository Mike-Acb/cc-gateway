import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { adminMiddleware } from '../middleware/admin.js'
import { query } from '../db.js'

export type WindowKey = '1h' | '24h' | '7d'

const WINDOW_MS: Record<WindowKey, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
}

const MIN_SAMPLES_FOR_P95 = 50

export interface PercentileBlock {
  p50: number | null
  p95: number | null
  n: number
  note?: string
}

export interface PercentileByModel {
  model: string
  p50: number | null
  p95: number | null
  n: number
}

export interface ErrorReason {
  reason: string
  source: string | null
  n: number
}

export interface VolumeEntry {
  label: string
  n: number
}

export interface MetricsResult {
  window: WindowKey
  since: string
  until: string
  latency: PercentileBlock & { byModel: PercentileByModel[] }
  firstToken: PercentileBlock & { byModel: PercentileByModel[] }
  errorRate: {
    total: number
    ok: number
    gw: number
    up: number
    gwRate: number
    upRate: number
    byReason: ErrorReason[]
  }
  volume: {
    byModel: VolumeEntry[]
    byAccount: VolumeEntry[]
  }
}

function parseWindow(raw: unknown): WindowKey {
  const v = String(raw ?? '24h')
  if (v === '1h' || v === '24h' || v === '7d') return v
  return '24h'
}

function safePercentile(n: number, raw: unknown): number | null {
  if (n < MIN_SAMPLES_FOR_P95) return null
  const num = Number(raw)
  if (!Number.isFinite(num)) return null
  return Math.round(num)
}

function safeP50(n: number, raw: unknown): number | null {
  if (n <= 0) return null
  const num = Number(raw)
  if (!Number.isFinite(num)) return null
  return Math.round(num)
}

export async function loadMetrics(windowKey: WindowKey): Promise<MetricsResult> {
  const until = new Date()
  const since = new Date(until.getTime() - WINDOW_MS[windowKey])
  const args = [since.toISOString(), until.toISOString()]

  const [
    latencyAgg,
    latencyByModel,
    firstTokenAgg,
    firstTokenByModel,
    errorAgg,
    byReason,
    volumeByModel,
    volumeByAccount,
  ] = await Promise.all([
    // Metrics represent the /v1/messages inference surface. Outbound telemetry
    // (event_batch, session_init) and bootstrap calls are logged with the same
    // schema but are not user-facing traffic — excluding them keeps error rate,
    // latency and model mix meaningful.
    query(
      `SELECT
         percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_ms) AS p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
         COUNT(*)::int AS n
         FROM request_logs
        WHERE created_at >= $1 AND created_at < $2
          AND path LIKE '/v1/messages%'
          AND response_status BETWEEN 200 AND 299
          AND latency_ms IS NOT NULL`,
      args,
    ),
    query(
      `SELECT request_model AS model,
              percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_ms) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
              COUNT(*)::int AS n
         FROM request_logs
        WHERE created_at >= $1 AND created_at < $2
          AND path LIKE '/v1/messages%'
          AND request_model IS NOT NULL
          AND response_status BETWEEN 200 AND 299
          AND latency_ms IS NOT NULL
        GROUP BY 1
        ORDER BY n DESC
        LIMIT 12`,
      args,
    ),
    query(
      `SELECT
         percentile_cont(0.5)  WITHIN GROUP (ORDER BY first_token_ms) AS p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY first_token_ms) AS p95,
         COUNT(*)::int AS n
         FROM request_logs
        WHERE created_at >= $1 AND created_at < $2
          AND path LIKE '/v1/messages%'
          AND streaming = true
          AND first_token_ms IS NOT NULL`,
      args,
    ),
    query(
      `SELECT request_model AS model,
              percentile_cont(0.5)  WITHIN GROUP (ORDER BY first_token_ms) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY first_token_ms) AS p95,
              COUNT(*)::int AS n
         FROM request_logs
        WHERE created_at >= $1 AND created_at < $2
          AND path LIKE '/v1/messages%'
          AND request_model IS NOT NULL
          AND streaming = true
          AND first_token_ms IS NOT NULL
        GROUP BY 1
        ORDER BY n DESC
        LIMIT 12`,
      args,
    ),
    query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE response_status BETWEEN 200 AND 299 AND block_reason IS NULL)::int AS ok,
         COUNT(*) FILTER (WHERE block_source = 'gw')::int AS gw,
         COUNT(*) FILTER (WHERE block_source = 'up' OR response_status >= 500)::int AS up
         FROM request_logs
        WHERE created_at >= $1 AND created_at < $2
          AND path LIKE '/v1/messages%'`,
      args,
    ),
    query(
      `SELECT COALESCE(block_reason, 'unknown') AS reason,
              block_source AS source,
              COUNT(*)::int AS n
         FROM request_logs
        WHERE created_at >= $1 AND created_at < $2
          AND path LIKE '/v1/messages%'
          AND block_reason IS NOT NULL
        GROUP BY 1, 2
        ORDER BY n DESC
        LIMIT 12`,
      args,
    ),
    query(
      `SELECT request_model AS label, COUNT(*)::int AS n
         FROM request_logs
        WHERE created_at >= $1 AND created_at < $2
          AND path LIKE '/v1/messages%'
          AND request_model IS NOT NULL
        GROUP BY 1 ORDER BY n DESC LIMIT 12`,
      args,
    ),
    query(
      `SELECT COALESCE(oa.name, rl.oauth_account_name, '(none)') AS label,
              COUNT(*)::int AS n
         FROM request_logs rl
         LEFT JOIN oauth_accounts oa ON oa.id = rl.oauth_account_id
        WHERE rl.created_at >= $1 AND rl.created_at < $2
          AND rl.path LIKE '/v1/messages%'
        GROUP BY 1 ORDER BY n DESC LIMIT 12`,
      args,
    ),
  ])

  const L = latencyAgg.rows[0] ?? { p50: null, p95: null, n: 0 }
  const F = firstTokenAgg.rows[0] ?? { p50: null, p95: null, n: 0 }
  const E = errorAgg.rows[0] ?? { total: 0, ok: 0, gw: 0, up: 0 }

  const Ln = Number(L.n ?? 0)
  const Fn = Number(F.n ?? 0)
  const total = Number(E.total ?? 0)
  const ok = Number(E.ok ?? 0)
  const gw = Number(E.gw ?? 0)
  const up = Number(E.up ?? 0)

  const latency: PercentileBlock & { byModel: PercentileByModel[] } = {
    p50: safeP50(Ln, L.p50),
    p95: safePercentile(Ln, L.p95),
    n: Ln,
    byModel: latencyByModel.rows.map((r: any) => {
      const n = Number(r.n ?? 0)
      return {
        model: String(r.model ?? 'unknown'),
        p50: safeP50(n, r.p50),
        p95: safePercentile(n, r.p95),
        n,
      }
    }),
  }
  if (Ln < MIN_SAMPLES_FOR_P95) latency.note = 'insufficient sample'

  const firstToken: PercentileBlock & { byModel: PercentileByModel[] } = {
    p50: safeP50(Fn, F.p50),
    p95: safePercentile(Fn, F.p95),
    n: Fn,
    byModel: firstTokenByModel.rows.map((r: any) => {
      const n = Number(r.n ?? 0)
      return {
        model: String(r.model ?? 'unknown'),
        p50: safeP50(n, r.p50),
        p95: safePercentile(n, r.p95),
        n,
      }
    }),
  }
  if (Fn < MIN_SAMPLES_FOR_P95) firstToken.note = 'insufficient sample'

  return {
    window: windowKey,
    since: since.toISOString(),
    until: until.toISOString(),
    latency,
    firstToken,
    errorRate: {
      total,
      ok,
      gw,
      up,
      gwRate: total === 0 ? 0 : gw / total,
      upRate: total === 0 ? 0 : up / total,
      byReason: byReason.rows.map((r: any) => ({
        reason: String(r.reason ?? 'unknown'),
        source: r.source == null ? null : String(r.source),
        n: Number(r.n ?? 0),
      })),
    },
    volume: {
      byModel: volumeByModel.rows.map((r: any) => ({
        label: String(r.label ?? 'unknown'),
        n: Number(r.n ?? 0),
      })),
      byAccount: volumeByAccount.rows.map((r: any) => ({
        label: String(r.label ?? '(none)'),
        n: Number(r.n ?? 0),
      })),
    },
  }
}

const router = Router()

router.use(authMiddleware, adminMiddleware)

router.get('/metrics', async (req, res, next) => {
  try {
    const windowKey = parseWindow(req.query.window)
    const result = await loadMetrics(windowKey)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

export default router
