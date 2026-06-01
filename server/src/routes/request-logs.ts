import { Router } from 'express'
import { query } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { adminMiddleware } from '../middleware/admin.js'

export const requestLogsRouter = Router()

requestLogsRouter.use(authMiddleware, adminMiddleware)

type SqlParam = string | number | string[]

const REDACT_HEADERS = new Set([
  'authorization',
  'cookie',
  'x-api-key',
  'proxy-authorization',
])

function redactHeaders(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value
  const src = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) {
    out[k] = REDACT_HEADERS.has(k.toLowerCase()) ? '***' : v
  }
  return out
}

interface RequestLogListRow {
  id: string
  trace_id: string | null
  operation_id: string | null
  root_trace_id: string | null
  parent_trace_id: string | null
  is_root: boolean
  request_family_in: string | null
  request_family_out: string | null
  shape_profile_in: string | null
  shape_profile_out: string | null
  client_name: string | null
  oauth_account_name: string | null
  selected_group_id: string | null
  selected_group_name: string | null
  selected_group_color: string | null
  method: string | null
  path: string | null
  request_model: string | null
  response_status: number | null
  latency_ms: number | null
  error_message: string | null
  created_at: string
  client_ip: string | null
  first_token_ms: number | null
  streaming: boolean | null
  block_reason: string | null
  block_source: string | null
  total_count: number
}

interface RequestLogDetailRow {
  id: string
  trace_id: string
  operation_id: string | null
  root_trace_id: string | null
  parent_trace_id: string | null
  related_trace_ids: unknown
  is_root: boolean
  session_key: string | null
  request_family_in: string | null
  request_family_out: string | null
  shape_profile_in: string | null
  shape_profile_out: string | null
  shape_confidence_in: number | null
  shape_confidence_out: number | null
  shape_reason: unknown
  client_id: string | null
  client_name: string
  oauth_account_id: string | null
  oauth_account_name: string | null
  selected_group_id: string | null
  selected_group_name: string | null
  selected_group_color: string | null
  method: string
  path: string
  client_ip: string | null
  request_model: string | null
  request_body: string | null
  response_status: number | null
  response_body: string | null
  latency_ms: number | null
  error_message: string | null
  retry_count: number
  created_at: string
  request_headers_in: unknown
  request_headers_out: unknown
  request_body_out: string | null
  response_headers: unknown
  first_token_ms: number | null
  streaming: boolean | null
  block_reason: string | null
  block_source: string | null
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function getStringQuery(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

requestLogsRouter.get('/', async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page, 1)
    const limit = Math.min(parsePositiveInt(req.query.limit, 50), 200)
    const offset = (page - 1) * limit

    const whereClauses: string[] = []
    const params: SqlParam[] = []

    const addParam = (value: SqlParam): string => {
      params.push(value)
      return `$${params.length}`
    }

    const clientName = getStringQuery(req.query.client_name)
    if (clientName) {
      whereClauses.push(`rl.client_name ILIKE ${addParam(`%${clientName}%`)}`)
    }

    const oauthAccountName = getStringQuery(req.query.oauth_account_name)
    if (oauthAccountName) {
      whereClauses.push(`rl.oauth_account_name ILIKE ${addParam(`%${oauthAccountName}%`)}`)
    }

    const clientIdQuery = getStringQuery(req.query.client_id)
    if (clientIdQuery) {
      whereClauses.push(`rl.client_id = ${addParam(clientIdQuery)}::uuid`)
    }

    // group_id 过滤:'__none__' = 共享池(selected_group_id IS NULL);其余 UUID 精确匹配。
    const groupIdQuery = getStringQuery(req.query.group_id)
    if (groupIdQuery === '__none__') {
      whereClauses.push(`rl.selected_group_id IS NULL`)
    } else if (groupIdQuery) {
      whereClauses.push(`rl.selected_group_id = ${addParam(groupIdQuery)}::uuid`)
    }

    // user_email — requires JOIN clients/users (additive filter only).
    const userEmail = getStringQuery(req.query.user_email)
    if (userEmail) {
      const placeholder = addParam(`%${userEmail}%`)
      whereClauses.push(
        `EXISTS (SELECT 1 FROM clients c JOIN users u ON u.id = c.user_id
                 WHERE c.id = rl.client_id AND u.email ILIKE ${placeholder})`,
      )
    }

    const status = getStringQuery(req.query.status).toLowerCase()
    if (status === 'success') {
      whereClauses.push(`rl.response_status BETWEEN 200 AND 299`)
    } else if (status === 'error') {
      whereClauses.push(`(rl.response_status IS NULL OR rl.response_status < 200 OR rl.response_status >= 300)`)
    }

    const path = getStringQuery(req.query.path)
    if (path) {
      whereClauses.push(`rl.path ILIKE ${addParam(`%${path}%`)}`)
    }

    const search = getStringQuery(req.query.search)
    if (search) {
      const placeholder = addParam(`%${search}%`)
      whereClauses.push(`(rl.error_message ILIKE ${placeholder} OR rl.path ILIKE ${placeholder})`)
    }

    const dateFrom = getStringQuery(req.query.date_from)
    if (dateFrom) {
      whereClauses.push(`rl.created_at >= ${addParam(dateFrom)}::date`)
    }

    const dateTo = getStringQuery(req.query.date_to)
    if (dateTo) {
      whereClauses.push(`rl.created_at < (${addParam(dateTo)}::date + INTERVAL '1 day')`)
    }

    const since = getStringQuery(req.query.since)
    if (since) {
      whereClauses.push(`rl.created_at >= ${addParam(since)}::timestamptz`)
    }

    const until = getStringQuery(req.query.until)
    if (until) {
      whereClauses.push(`rl.created_at < ${addParam(until)}::timestamptz`)
    }

    const model = getStringQuery(req.query.model)
    if (model) {
      whereClauses.push(`rl.request_model ILIKE ${addParam(`%${model}%`)}`)
    }

    // Allowed block_reason values — must match the enum in the spec.
    // Parameterised to prevent injection; invalid tokens dropped.
    const ALLOWED_BLOCK_REASONS = new Set([
      'rate_limited',
      'plan_forbidden_model',
      'quota_exceeded',
      'auth_missing',
      'malformed_block',
      'upstream_5xx',
      'upstream_429',
    ])
    const blockReasonQuery = getStringQuery(req.query.block_reason)
    if (blockReasonQuery) {
      const reasons = blockReasonQuery
        .split(',')
        .map((s) => s.trim())
        .filter((s) => ALLOWED_BLOCK_REASONS.has(s))
      if (reasons.length > 0) {
        const placeholders = reasons.map((r) => addParam(r)).join(', ')
        whereClauses.push(`rl.block_reason IN (${placeholders})`)
      }
    }

    const blockSource = getStringQuery(req.query.block_source).toLowerCase()
    if (blockSource === 'gw') {
      whereClauses.push(`rl.block_source = 'gw'`)
    } else if (blockSource === 'up') {
      whereClauses.push(`rl.block_source = 'up'`)
    }

    const blockedFlag = getStringQuery(req.query.blocked).toLowerCase()
    if (blockedFlag === 'true') {
      whereClauses.push(`rl.block_reason IS NOT NULL`)
    } else if (blockedFlag === 'false') {
      whereClauses.push(`rl.block_reason IS NULL`)
    }

    const streamingFlag = getStringQuery(req.query.streaming).toLowerCase()
    if (streamingFlag === 'true') {
      whereClauses.push(`rl.streaming = true`)
    } else if (streamingFlag === 'false') {
      whereClauses.push(`rl.streaming = false`)
    }

    // Cursor pagination (preferred). If cursor_at/cursor_id present, use
    // (created_at, id) tuple comparison instead of OFFSET. Legacy page/limit
    // still works for existing user-facing callers.
    const cursorAt = getStringQuery(req.query.cursor_at)
    const cursorId = getStringQuery(req.query.cursor_id)
    const useCursor = Boolean(cursorAt && cursorId)
    if (useCursor) {
      const atPh = addParam(cursorAt)
      const idPh = addParam(cursorId)
      whereClauses.push(`(rl.created_at, rl.id) < (${atPh}::timestamptz, ${idPh}::bigint)`)
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''

    if (useCursor) {
      const fetchLimit = limit + 1
      const limitPlaceholder = addParam(fetchLimit)
      const result = await query<RequestLogListRow>(
        `SELECT
           rl.id::text AS id,
           rl.trace_id,
           rl.operation_id::text AS operation_id,
           rl.root_trace_id,
           rl.parent_trace_id,
           rl.is_root,
           rl.request_family_in,
           rl.request_family_out,
           rl.shape_profile_in,
           rl.shape_profile_out,
           rl.client_name,
           rl.oauth_account_name,
           rl.selected_group_id::text AS selected_group_id,
           ag.name AS selected_group_name,
           ag.color AS selected_group_color,
           rl.method,
           rl.path,
           rl.request_model,
           rl.response_status,
           rl.latency_ms,
           LEFT(rl.error_message, 100) AS error_message,
           rl.created_at,
           rl.client_ip,
           rl.first_token_ms,
           rl.streaming,
           rl.block_reason,
           rl.block_source,
           0 AS total_count
         FROM request_logs rl
         LEFT JOIN account_groups ag ON ag.id = rl.selected_group_id
         ${whereSql}
         ORDER BY rl.created_at DESC, rl.id DESC
         LIMIT ${limitPlaceholder}`,
        params,
      )
      const hasMore = result.rows.length > limit
      const items = result.rows.slice(0, limit).map(({ total_count: _totalCount, ...row }: any) => row)
      const nextCursor = hasMore && items.length > 0
        ? { createdAt: items[items.length - 1].created_at, id: items[items.length - 1].id }
        : null
      res.json({ logs: items, items, cursor: nextCursor, limit })
      return
    }

    const limitPlaceholder = addParam(limit)
    const offsetPlaceholder = addParam(offset)

    const result = await query<RequestLogListRow>(
      `SELECT
         rl.id::text AS id,
         rl.trace_id,
         rl.operation_id::text AS operation_id,
         rl.root_trace_id,
         rl.parent_trace_id,
         rl.is_root,
         rl.request_family_in,
         rl.request_family_out,
         rl.shape_profile_in,
         rl.shape_profile_out,
         rl.client_name,
         rl.oauth_account_name,
         rl.selected_group_id::text AS selected_group_id,
         ag.name AS selected_group_name,
         rl.method,
         rl.path,
         rl.request_model,
         rl.response_status,
         rl.latency_ms,
         LEFT(rl.error_message, 100) AS error_message,
         rl.created_at,
         rl.client_ip,
         rl.first_token_ms,
         rl.streaming,
         rl.block_reason,
         rl.block_source,
         COUNT(*) OVER()::int AS total_count
       FROM request_logs rl
       LEFT JOIN account_groups ag ON ag.id = rl.selected_group_id
       ${whereSql}
       ORDER BY rl.created_at DESC, rl.id DESC
       LIMIT ${limitPlaceholder}
       OFFSET ${offsetPlaceholder}`,
      params,
    )

    const items = result.rows.map(({ total_count: _totalCount, ...row }: any) => row)
    res.json({
      logs: items,
      items,
      total: result.rows[0]?.total_count ?? 0,
      page,
      limit,
    })
  } catch (err) {
    console.error('List request logs error:', err)
    res.status(500).json({ error: 'Failed to list request logs' })
  }
})

requestLogsRouter.get('/:id', async (req, res) => {
  try {
    const rawId = String(req.params.id ?? '').trim()
    const isNumeric = /^\d+$/.test(rawId)

    const result = await query<RequestLogDetailRow>(
      `SELECT
         rl.id::text AS id,
         rl.trace_id,
         rl.operation_id::text AS operation_id,
         rl.root_trace_id,
         rl.parent_trace_id,
         rl.related_trace_ids,
         rl.is_root,
         rl.session_key,
         rl.request_family_in,
         rl.request_family_out,
         rl.shape_profile_in,
         rl.shape_profile_out,
         rl.shape_confidence_in,
         rl.shape_confidence_out,
         rl.shape_reason,
         rl.client_id,
         rl.client_name,
         rl.oauth_account_id,
         rl.oauth_account_name,
         rl.selected_group_id::text AS selected_group_id,
         ag.name AS selected_group_name,
         ag.color AS selected_group_color,
         rl.method,
         rl.path,
         rl.client_ip,
         rl.request_model,
         rl.request_body::text AS request_body,
         rl.response_status,
         rl.response_body::text AS response_body,
         rl.latency_ms,
         rl.error_message,
         rl.retry_count,
         rl.created_at,
         rl.request_headers_in,
         rl.request_headers_out,
         rl.request_body_out::text AS request_body_out,
         rl.response_headers,
         rl.first_token_ms,
         rl.streaming,
         rl.block_reason,
         rl.block_source
       FROM request_logs rl
       LEFT JOIN account_groups ag ON ag.id = rl.selected_group_id
       WHERE ${isNumeric ? 'rl.id = $1::bigint' : 'rl.trace_id = $1'}
       ORDER BY rl.created_at DESC
       LIMIT 1`,
      [rawId],
    )

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Request log not found' })
      return
    }

    const row = result.rows[0]
    res.json({
      ...row,
      request_headers_in: redactHeaders(row.request_headers_in),
      request_headers_out: redactHeaders(row.request_headers_out),
      response_headers: redactHeaders(row.response_headers),
    })
  } catch (err) {
    console.error('Get request log detail error:', err)
    res.status(500).json({ error: 'Failed to get request log detail' })
  }
})

// DELETE / — clear all request logs
requestLogsRouter.delete('/', async (req, res) => {
  try {
    const result = await query('DELETE FROM request_logs')
    res.json({ deleted: result.rowCount ?? 0 })
  } catch (err) {
    console.error('Clear request logs error:', err)
    res.status(500).json({ error: 'Failed to clear request logs' })
  }
})

export default requestLogsRouter
