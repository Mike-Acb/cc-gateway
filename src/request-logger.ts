import { randomBytes } from 'crypto'
import { query } from './db.js'
import { log } from './logger.js'
import { closeRequestOperation } from './request-operations.js'

/**
 * Generate a unique trace ID for request tracking.
 * Format: ccg-<base36_timestamp>-<12_hex_random>  (always ≤ 32 chars)
 */
export function generateTraceId(): string {
  const ts = Date.now().toString(36)
  const rand = randomBytes(6).toString('hex')
  return `ccg-${ts}-${rand}`
}

/**
 * PostgreSQL JSONB does not accept the unicode escape \u0000.
 * Strip null bytes so updateRequestLog / insertRequestLog never fail with
 * "unsupported Unicode escape sequence" for binary-tainted client bodies.
 */
function stripNullBytes(value: string): string {
  return value.includes('\u0000') ? value.replace(/\u0000/g, '') : value
}

function truncateString(value: string, maxStr: number): string {
  const cleaned = stripNullBytes(value)
  return cleaned.length > maxStr ? cleaned.slice(0, maxStr) + `...(${cleaned.length})` : cleaned
}

/** Recursively truncate string values — keeps all keys intact */
function truncateDeep(val: any, maxStr: number): any {
  if (val === null || val === undefined) return val
  if (typeof val === 'string') {
    return truncateString(val, maxStr)
  }
  if (Array.isArray(val)) {
    return val.map(item => truncateDeep(item, maxStr))
  }
  if (typeof val === 'object') {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(val)) {
      out[k] = truncateDeep(v, maxStr)
    }
    return out
  }
  return val
}

/** Parse and truncate a body buffer. JSON bodies keep all keys; non-JSON bodies are stored as _raw_text. */
export function truncateBody(raw: Buffer, maxValueLen = 200): any {
  if (raw.length === 0) return null
  const text = raw.toString('utf-8')
  try {
    const obj = JSON.parse(text)
    return truncateDeep(obj, maxValueLen)
  } catch {
    return { _raw_text: truncateString(text, maxValueLen) }
  }
}

export function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> | null {
  const entries = Object.entries(headers)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const normalized = Array.isArray(value)
        ? value.map(v => stripNullBytes(String(v)))
        : stripNullBytes(String(value))
      return [key, normalized] as const
    })

  if (entries.length === 0) return null
  return Object.fromEntries(entries)
}

export type BlockReason =
  | 'rate_limited'
  | 'plan_forbidden_model'
  | 'quota_exceeded'
  | 'quota_exhausted'
  | 'auth_missing'
  | 'malformed_block'
  | 'shape_forbidden'
  | 'shape_forbidden_after_auto_complete'
  | 'upstream_5xx'
  | 'upstream_429'
  | 'non_cc_request'
  | 'no_template_bound'
  | 'fast_mode_blocked'
  | 'non_stream_blocked'
  | 'no_cc_template'
  | 'heartbeat_ok'
  | 'heartbeat_pool_empty'

export type BlockSource = 'gw' | 'up'

export type RequestLogEntry = {
  traceId: string
  operationId?: string | null
  rootTraceId?: string | null
  parentTraceId?: string | null
  relatedTraceIds?: string[] | null
  isRoot?: boolean
  sessionKey?: string | null
  requestFamilyIn?: string | null
  requestFamilyOut?: string | null
  shapeProfileIn?: string | null
  shapeProfileOut?: string | null
  shapeConfidenceIn?: number | null
  shapeConfidenceOut?: number | null
  shapeReason?: Record<string, any> | null
  clientId: string | null
  clientName: string
  oauthAccountId: string | null
  oauthAccountName: string | null
  method: string
  path: string
  clientIp: string
  requestModel: string | null
  requestBody: any | null
  requestHeadersIn?: Record<string, string | string[]> | null
  requestHeadersOut?: Record<string, string | string[]> | null
  requestBodyOut?: any | null
  streaming?: boolean | null
  blockReason?: BlockReason | null
  blockSource?: BlockSource | null
  /**
   * shapeAutoComplete 路径上 gateway 自动补齐的 body 字段标记
   * (如 ['temperature:1', 'shape_refined:toolless_side_query_generic_like->toolless_side_query_temperature_one_like'])。
   * null = 未触发补齐。
   */
  autoCompletedFields?: string[] | null
  /**
   * 本次请求实际命中的 account_groups.id (AccountSelection.selectedGroupId)。
   * null = 共享池 / 早退前还未完成 account 选择。
   */
  selectedGroupId?: string | null
}

/**
 * 已 insert 但还没 update 终态(response_status / latency_ms 等)的 trace 集合。
 * SIGTERM/SIGINT 时统一 flush 一条 "gateway_shutdown" 的 update,避免进程被 PM2
 * 反复 reload 时大量行卡 NULL 状态(UI 表现为"日志丢失")。insertRequestLog 完成
 * 时 add,updateRequestLog 完成时 delete,logEarlyExit 路径短暂经过此集合无害。
 */
const inflightTraces = new Set<string>()

/** Insert a request log row at the start of request processing. */
export async function insertRequestLog(entry: RequestLogEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO request_logs
         (trace_id, operation_id, root_trace_id, parent_trace_id, related_trace_ids,
          is_root, session_key, request_family_in, request_family_out,
          shape_profile_in, shape_profile_out, shape_confidence_in, shape_confidence_out,
          shape_reason, client_id, client_name, oauth_account_id, oauth_account_name,
          method, path, client_ip, request_model, request_body,
          request_headers_in, request_headers_out, request_body_out,
          streaming, block_reason, block_source, auto_completed_fields,
          selected_group_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb,
               $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30::jsonb,
               $31)`,
      [
        entry.traceId,
        entry.operationId ?? null,
        entry.rootTraceId ?? null,
        entry.parentTraceId ?? null,
        JSON.stringify(entry.relatedTraceIds ?? null),
        entry.isRoot ?? false,
        entry.sessionKey ?? null,
        entry.requestFamilyIn ?? null,
        entry.requestFamilyOut ?? null,
        entry.shapeProfileIn ?? null,
        entry.shapeProfileOut ?? null,
        entry.shapeConfidenceIn ?? null,
        entry.shapeConfidenceOut ?? null,
        JSON.stringify(entry.shapeReason ?? {}),
        entry.clientId,
        entry.clientName,
        entry.oauthAccountId,
        entry.oauthAccountName,
        entry.method,
        entry.path,
        entry.clientIp,
        entry.requestModel,
        null,  // privacy: body/headers not stored (was entry.requestBody)
        null,  // privacy: body/headers not stored (was entry.requestHeadersIn)
        null,  // privacy: body/headers not stored (was entry.requestHeadersOut)
        null,  // privacy: body/headers not stored (was entry.requestBodyOut)
        entry.streaming ?? null,
        entry.blockReason ?? null,
        entry.blockSource ?? null,
        entry.autoCompletedFields ? JSON.stringify(entry.autoCompletedFields) : null,
        entry.selectedGroupId ?? null,
      ],
    )
    inflightTraces.add(entry.traceId)
  } catch (err) {
    log('error', `Failed to insert request log: ${err}`)
  }
}

export type ResponseLogUpdate = {
  traceId: string
  responseStatus: number
  responseBody: any | null
  latencyMs: number
  errorMessage: string | null
  retryCount: number
  oauthAccountId?: string | null
  oauthAccountName?: string | null
  responseHeaders?: Record<string, string | string[]> | null
  requestHeadersOut?: Record<string, string | string[]> | null
  requestBodyOut?: any | null
  firstTokenMs?: number | null
  blockReason?: BlockReason | null
  blockSource?: BlockSource | null
}

/**
 * Update outbound-only fields: what we sent upstream, plus the account used.
 *
 * This must NOT touch response_status / response_body / latency_ms / etc.,
 * because it's called before the upstream response arrives and races with
 * the post-response update (fire-and-forget from both). If this function
 * touched those fields, a late-landing outbound-log query would overwrite a
 * correct response-status write with `0`/`null` ("日志丢失" in the UI).
 */
export type OutboundLogUpdate = {
  traceId: string
  retryCount: number
  oauthAccountId: string | null
  oauthAccountName: string | null
  requestFamilyOut?: string | null
  shapeProfileOut?: string | null
  shapeConfidenceOut?: number | null
  shapeReasonPatch?: Record<string, any> | null
  requestHeadersOut?: Record<string, string | string[]> | null
  requestBodyOut?: any | null
  /** 本次 retry 实际命中的 account_groups.id (重选后会变,以最后一次为准)。 */
  selectedGroupId?: string | null
}

export async function updateOutboundLog(update: OutboundLogUpdate): Promise<void> {
  try {
    await query(
      `UPDATE request_logs
       SET retry_count          = GREATEST($2, retry_count),
           oauth_account_id     = COALESCE($3, oauth_account_id),
           oauth_account_name   = COALESCE($4, oauth_account_name),
           request_family_out   = COALESCE($5, request_family_out),
           shape_profile_out    = COALESCE($6, shape_profile_out),
           shape_confidence_out = COALESCE($7, shape_confidence_out),
           shape_reason         = COALESCE(shape_reason, '{}'::jsonb) || COALESCE($8::jsonb, '{}'::jsonb),
           request_headers_out  = COALESCE($9, request_headers_out),
           request_body_out     = COALESCE($10, request_body_out),
           selected_group_id    = COALESCE($11::uuid, selected_group_id)
       WHERE trace_id = $1
         AND created_at >= now() - INTERVAL '5 minutes'`,
      [
        update.traceId,
        update.retryCount,
        update.oauthAccountId ?? null,
        update.oauthAccountName ?? null,
        update.requestFamilyOut ?? null,
        update.shapeProfileOut ?? null,
        update.shapeConfidenceOut ?? null,
        JSON.stringify(update.shapeReasonPatch ?? {}),
        null,  // privacy (was update.requestHeadersOut)
        null,  // privacy (was update.requestBodyOut)
        update.selectedGroupId ?? null,
      ],
    )
  } catch (err) {
    log('error', `Failed to update outbound request log: ${err}`)
  }
}

/** Update the request log row with response data after upstream responds. */
export async function updateRequestLog(update: ResponseLogUpdate): Promise<void> {
  try {
    const result = await query<{
      root_trace_id: string | null
      is_root: boolean
      operation_id: string | null
      response_status: number | null
      error_message: string | null
      block_reason: string | null
      request_family_in: string | null
      request_family_out: string | null
      shape_profile_in: string | null
      shape_profile_out: string | null
    }>(
      `UPDATE request_logs
       SET response_status = $2,
           response_body = $3,
           latency_ms = $4,
           error_message = $5,
           retry_count = $6,
           oauth_account_id = COALESCE($7, oauth_account_id),
           oauth_account_name = COALESCE($8, oauth_account_name),
           response_headers = COALESCE($9, response_headers),
           request_headers_out = COALESCE($10, request_headers_out),
           request_body_out = COALESCE($11, request_body_out),
           first_token_ms = COALESCE($12, first_token_ms),
           block_reason = COALESCE($13, block_reason),
           block_source = COALESCE($14, block_source)
       WHERE trace_id = $1
         AND created_at >= now() - INTERVAL '5 minutes'
       RETURNING root_trace_id, is_root, operation_id, response_status, error_message,
                 block_reason, request_family_in, request_family_out,
                 shape_profile_in, shape_profile_out`,
      [
        update.traceId,
        update.responseStatus,
        null,  // privacy (was update.responseBody)
        update.latencyMs,
        update.errorMessage,
        update.retryCount,
        update.oauthAccountId ?? null,
        update.oauthAccountName ?? null,
        null,  // privacy (was update.responseHeaders)
        null,  // privacy (was update.requestHeadersOut)
        null,  // privacy (was update.requestBodyOut)
        update.firstTokenMs ?? null,
        update.blockReason ?? null,
        update.blockSource ?? null,
      ],
    )
    const row = result.rows[0]
    if (row?.is_root && row.root_trace_id) {
      const status =
        row.response_status !== null && row.response_status < 400
          ? 'completed'
          : row.block_reason
            ? 'blocked'
            : 'failed'
      await closeRequestOperation(row.root_trace_id, status, {
        response_status: row.response_status,
        error_message: row.error_message,
        block_reason: row.block_reason,
        request_family_in: row.request_family_in,
        request_family_out: row.request_family_out,
        shape_profile_in: row.shape_profile_in,
        shape_profile_out: row.shape_profile_out,
      })
    }
    inflightTraces.delete(update.traceId)
  } catch (err) {
    log('error', `Failed to update request log: ${err}`)
  }
}

/**
 * SIGTERM/SIGINT 时由 index.ts 调用,把所有还在 inflight 的 trace 一次性标记为
 * 进程关闭终止 — 否则 PM2 reload 期间正在 stream 的请求会让 request_logs 行
 * 永远停留在 NULL 状态(UI 表现"日志丢失")。
 *
 * 并发 update,失败吞掉(进程要退出了,无 retry 价值);返回值=实际尝试的条数。
 */
export async function flushInflightLogs(reason: string): Promise<number> {
  const ids = [...inflightTraces]
  inflightTraces.clear()
  if (ids.length === 0) return 0
  await Promise.allSettled(ids.map(traceId =>
    updateRequestLog({
      traceId,
      responseStatus: 499,
      responseBody: null,
      latencyMs: 0,
      errorMessage: `gateway_shutdown:${reason}`,
      retryCount: 0,
      responseHeaders: null,
      blockReason: 'upstream_5xx',
      blockSource: 'gw',
    }),
  ))
  return ids.length
}
