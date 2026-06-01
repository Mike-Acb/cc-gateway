import { createServer as createHttpsServer, type ServerOptions } from 'https'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomUUID, createHash } from 'crypto'
import { readFileSync } from 'fs'
import { request as httpsRequest } from 'https'
import { URL } from 'url'
import type { Config } from './config.js'
import { getUpstreamAuthMode } from './config.js'
import { authenticate, initAuth, type AuthResult } from './auth.js'
import { getAccessToken } from './oauth.js'
import { rewriteBody, rewriteHeaders, getLockedVersion, deriveFallbackSessionId, type RewriteOptions } from './rewriter.js'
import { MissingTemplateRedisError, NonCCRequestError, NoTemplateBoundError, validateThinkingParams, capBodyCacheControl, normalizeCacheControlTtlOrder } from './cc-disguise.js'
import { createToolNameReverseTransform } from './sse-tool-name-transform.js'
import { buildEffectiveProfile, extractStickyId } from './identity-rewrite.js'
import { getOrAssignSession } from './session-slots.js'
import { audit, log, shouldLog } from './logger.js'
import { getDirectAgent, getProxyAgentForProxyId, markProxyFailure, markProxySuccess } from './proxy-agent.js'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'zlib'
import { recordUsage, parseUsageFromJSON, parseUsageFromSSE, calculateCost } from './metering.js'
import { checkRateLimit } from './rate-limiter.js'
import { checkQuota, deductClientPrebill, reconcileClientPrebill } from './quota-checker.js'
import { checkPlanGuard, recordPlanUsage, getPrebillUsd } from './plan-guard.js'
import { generateTraceId, truncateBody, insertRequestLog, updateRequestLog, updateOutboundLog, normalizeHeaders, type BlockReason, type BlockSource } from './request-logger.js'
import { resolveRequestOperation, updateRequestOperationContext } from './request-operations.js'
import { classifyRequestShape, type RequestShape, validateRequestShape } from './request-shapes.js'
import { getAllClientNames, getModelPrices, getClientGroupId, getGroupMultiplier, getClientById } from './sync.js'
import { query, DEPLOYMENT } from './db.js'
import {
  isPoolEnabled,
  isPoolConfigured,
  selectAccount,
  hasAnyReadyAccount,
  getAccounts,
  ensureValidToken,
  describePoolUnavailability,
  onRequestStart,
  onRequestEnd,
  disableAccount,
  markAccountUnavailable,
  refreshAccountToken,
  getDefaultProfile,
  getSessionTtl,
  getUnsupportedModelReason,
  reloadAccountPool,
  resolveEffectiveGroup,
  type AccountSelection,
  type ObservedFingerprint,
  type OAuthAccount,
  type ApiKeyAccountVariant,
} from './account-pool.js'
import { startEventEmitter, emitApiQuery, emitApiSuccess, emitSessionInit, cacheOrgUuid, getProcessAgeMins } from './event-emitter.js'
import { OAUTH_DEFAULT_OPTIONS } from './features/options.js'
import { buildFeatures } from './features/build.js'
import { run as runFeaturePipeline } from './pipeline/runner.js'
import { createPipelineContext } from './pipeline/context.js'
import { bodyHasCacheControl, inferIsAgenticQuery } from './cc-betas.js'
import { matchHeartbeat, buildHeartbeatJsonBody, writeHeartbeatStream } from './heartbeat.js'
import {
  noteInvalidSignatureContext,
  noteSuccessfulSignatureContext,
  shouldStripSignatureBlocksForContext,
} from './signature-context.js'

// Cache for resolving config.yaml client names to PG client IDs
const configClientIdCache = new Map<string, string>()

type FingerprintProbe = {
  complete: boolean
  missing: string[]
  fingerprint: ObservedFingerprint | null
}

const REQUIRED_FINGERPRINT_FIELDS = [
  'user_agent',
  'x_app',
  'x_stainless_lang',
  'x_stainless_runtime',
  'x_stainless_runtime_version',
  'x_stainless_os',
  'x_stainless_arch',
  'x_stainless_package_version',
] as const

async function captureAnthropicLimits(accountId: string, headers: any): Promise<void> {
  if (!accountId) return
  try {
    const { getRedis, isRedisAvailable } = await import('./redis.js')
    if (!isRedisAvailable()) return
    const redis = getRedis()

    // Parse unified rate limit headers (Claude Code OAuth uses these)
    const get = (k: string) => typeof headers[k] === 'string' ? headers[k] : undefined
    const fiveUtil = get('anthropic-ratelimit-unified-5h-utilization')
    const fiveReset = get('anthropic-ratelimit-unified-5h-reset')
    const sevenUtil = get('anthropic-ratelimit-unified-7d-utilization')
    const sevenReset = get('anthropic-ratelimit-unified-7d-reset')

    if (!fiveUtil && !sevenUtil) return

    // Build utilization object in the same format as /api/oauth/usage returns
    const utilization: any = {}
    if (fiveUtil !== undefined) {
      utilization.five_hour = {
        utilization: parseFloat(fiveUtil) * 100,  // convert 0-1 to 0-100
        resets_at: fiveReset ? new Date(parseInt(fiveReset) * 1000).toISOString() : null,
      }
    }
    if (sevenUtil !== undefined) {
      utilization.seven_day = {
        utilization: parseFloat(sevenUtil) * 100,
        resets_at: sevenReset ? new Date(parseInt(sevenReset) * 1000).toISOString() : null,
      }
    }

    // Merge with existing utilization (preserve opus/sonnet from /api/oauth/usage poll)
    const existing = await redis.get(`claude_utilization:${accountId}`)
    if (existing) {
      try {
        const prev = JSON.parse(existing)
        // Preserve fields we don't get from headers
        if (prev.seven_day_opus) utilization.seven_day_opus = prev.seven_day_opus
        if (prev.seven_day_sonnet) utilization.seven_day_sonnet = prev.seven_day_sonnet
        if (prev.seven_day_oauth_apps) utilization.seven_day_oauth_apps = prev.seven_day_oauth_apps
      } catch {}
    }

    const pipe = redis.pipeline()
    pipe.set(`claude_utilization:${accountId}`, JSON.stringify(utilization), 'EX', 600)
    pipe.set(`claude_utilization:${accountId}:updated_at`, new Date().toISOString(), 'EX', 600)
    await pipe.exec()

    log('debug', `captureAnthropicLimits: 5h=${fiveUtil} 7d=${sevenUtil} for account ${accountId}`)
  } catch (err) {
    log('debug', `captureAnthropicLimits error: ${err}`)
  }
}


// Parse upstream Retry-After header value to seconds (RFC 7231).
// Accepts either delta-seconds or HTTP-date format.
function parseRetryAfterSec(headerValue: string | string[] | undefined): number | null {
  if (!headerValue) return null
  const v = Array.isArray(headerValue) ? headerValue[0] : headerValue
  if (!v) return null
  const asNum = parseInt(v.trim(), 10)
  if (Number.isFinite(asNum) && asNum > 0) return asNum
  // Try HTTP-date format
  const ts = Date.parse(v)
  if (!Number.isNaN(ts)) {
    const sec = Math.floor((ts - Date.now()) / 1000)
    return sec > 0 ? sec : null
  }
  return null
}

async function resolveConfigClientId(clientName: string): Promise<string | null> {
  const cached = configClientIdCache.get(clientName)
  if (cached) return cached
  try {
    const result = await query('SELECT id FROM clients WHERE name = $1 AND deployment = $2 LIMIT 1', [clientName, DEPLOYMENT])
    if (result.rows.length > 0) {
      configClientIdCache.set(clientName, result.rows[0].id)
      return result.rows[0].id
    }
  } catch {}
  return null
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length > 0) return value[0]
  return null
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
}

/**
 * Validate message content blocks before forwarding to Anthropic.
 *
 * Rejects two client-side bugs that would otherwise trigger Anthropic 400
 * errors and damage the OAuth account's reputation:
 *
 *   1. thinking block with missing / empty signature
 *      → "Invalid `signature` in `thinking` block"
 *      (Real CC always includes a valid signature; missing signature means
 *      middleware tampered with the block or client fabricated it.)
 *
 *   2. text block with empty / missing text
 *      → "text content blocks must be non-empty"
 *      (Real CC never emits empty text; NewAPI reconstructs history this way.)
 *
 * Returns an error message string, or null if valid.
 */
function validateMessageBlocks(messages: any[]): string | null {
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]
    if (!msg || !Array.isArray(msg.content)) continue
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi]
      if (!block || typeof block !== 'object') continue

      if (block.type === 'thinking') {
        const sig = block.signature
        if (typeof sig !== 'string' || sig.length === 0) {
          return `messages.${mi}.content.${bi}: thinking block missing signature — start a new conversation to recover.`
        }
      }

      if (block.type === 'text') {
        const text = block.text
        if (typeof text !== 'string' || text.length === 0) {
          return `messages.${mi}.content.${bi}: text content block must be non-empty.`
        }
      }
    }
  }
  return null
}

/** Recursively truncate string values for logging — keeps all keys intact */
function truncateDeep(val: any, maxStr = 200): any {
  if (val === null || val === undefined) return val
  if (typeof val === 'string') {
    return val.length > maxStr ? val.slice(0, maxStr) + `...(${val.length})` : val
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
  return val // number, boolean
}

function summarizeBody(buf: Buffer): string {
  try {
    const obj = JSON.parse(buf.toString('utf-8'))
    return JSON.stringify(truncateDeep(obj))
  } catch {
    return buf.toString('utf-8').slice(0, 500)
  }
}

function extractUpstreamFailureReason(status: number, responseText: string): string {
  try {
    const parsed = JSON.parse(responseText)
    const detail = parsed?.error?.message ?? parsed?.error ?? parsed?.message
    if (typeof detail === 'string' && detail.trim()) {
      return `upstream_status_${status}: ${detail.trim()}`
    }
  } catch {}
  return `upstream_status_${status}`
}

function isInvalidThinkingSignatureError(responseText: string): boolean {
  return responseText.includes('Invalid `signature` in `thinking` block')
}

function decodeResponseBody(
  headers: Record<string, string | string[] | undefined>,
  chunks: Buffer[],
): string {
  const encoding = headers['content-encoding'] || ''
  const rawBuf = Buffer.concat(chunks)
  if (!encoding || typeof encoding !== 'string') {
    return rawBuf.toString('utf-8')
  }
  try {
    if (encoding === 'br') return brotliDecompressSync(rawBuf).toString('utf-8')
    if (encoding === 'gzip') return gunzipSync(rawBuf).toString('utf-8')
    if (encoding === 'deflate') return inflateSync(rawBuf).toString('utf-8')
  } catch (err) {
    log('debug', `Failed to decode upstream body (${encoding}): ${err}`)
  }
  return rawBuf.toString('utf-8')
}

function headerValue(headers: Record<string, string | string[] | undefined>, key: string): string {
  const value = headers[key]
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value) && value.length > 0) return String(value[0]).trim()
  return ''
}

function extractPromptValue(text: string, label: string): string {
  const match = text.match(new RegExp(`(?:^|\\n)\\s*${label}:\\s*([^\\n<]+)`, 'i'))
  return match?.[1]?.trim() ?? ''
}

function extractHomePrefix(text: string): string {
  const unix = text.match(/\/(?:Users|home)\/[^/\s]+\//)
  if (unix) return unix[0]
  const win = text.match(/[A-Z]:\\Users\\[^\\\s]+\\/i)
  if (win) return win[0]
  return ''
}

function collectPromptSources(payload: any): string[] {
  const sources: string[] = []

  const pushText = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) sources.push(value)
  }

  if (Array.isArray(payload?.system)) {
    for (const item of payload.system) {
      if (typeof item === 'string') pushText(item)
      else pushText(item?.text)
    }
  } else {
    pushText(payload?.system)
  }

  if (Array.isArray(payload?.messages)) {
    for (const message of payload.messages) {
      const content = message?.content
      if (typeof content === 'string') {
        const blocks = content.match(/<system-reminder>[\s\S]*?<\/system-reminder>/g)
        if (blocks) sources.push(...blocks)
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block?.text === 'string' && block.text.includes('<system-reminder>')) {
            const matches = block.text.match(/<system-reminder>[\s\S]*?<\/system-reminder>/g)
            if (matches) sources.push(...matches)
          }
        }
      }
    }
  }

  return sources
}

function inspectFingerprint(
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
): FingerprintProbe {
  let promptText = ''
  try {
    const parsed = JSON.parse(body.toString('utf-8'))
    promptText = collectPromptSources(parsed).join('\n')
  } catch {
    promptText = ''
  }
  const fingerprint: ObservedFingerprint = {
    user_agent: headerValue(headers, 'user-agent'),
    x_app: headerValue(headers, 'x-app'),
    x_stainless_lang: headerValue(headers, 'x-stainless-lang'),
    x_stainless_runtime: headerValue(headers, 'x-stainless-runtime'),
    x_stainless_runtime_version: headerValue(headers, 'x-stainless-runtime-version'),
    x_stainless_os: headerValue(headers, 'x-stainless-os'),
    x_stainless_arch: headerValue(headers, 'x-stainless-arch'),
    x_stainless_package_version: headerValue(headers, 'x-stainless-package-version'),
    prompt_platform: extractPromptValue(promptText, 'Platform'),
    prompt_shell: extractPromptValue(promptText, 'Shell'),
    prompt_os_version: extractPromptValue(promptText, 'OS Version'),
    prompt_home_prefix: extractHomePrefix(promptText),
  }

  const missing = REQUIRED_FINGERPRINT_FIELDS.filter((key) => !fingerprint[key])

  return {
    complete: missing.length === 0,
    missing,
    fingerprint,
  }
}


function getSingleUpstreamToken(config: Config): string | null {
  if (getUpstreamAuthMode(config) === 'static_bearer') {
    return config.upstream_auth?.bearer_token?.trim() || null
  }
  return getAccessToken()
}

export function startProxy(config: Config) {
  initAuth(config)

  const upstream = new URL(config.upstream.url)
  const useTls = config.server.tls?.cert && config.server.tls?.key

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    handleRequest(req, res, config, upstream)
  }

  let server
  if (useTls) {
    const tlsOptions: ServerOptions = {
      cert: readFileSync(config.server.tls.cert),
      key: readFileSync(config.server.tls.key),
    }
    server = createHttpsServer(tlsOptions, handler)
  } else {
    server = createHttpServer(handler)
    log('warn', 'Running without TLS - only use for local development')
  }

  startEventEmitter()

  server.listen(config.server.port, () => {
    log('info', `CC Gateway listening on ${useTls ? 'https' : 'http'}://0.0.0.0:${config.server.port}`)
    log('info', `Upstream: ${config.upstream.url}`)
    const dp = getDefaultProfile()
    log('info', `Default identity profile: ${dp ? dp.name : '<not loaded>'}`)
    log('info', `Authorized clients: ${config.auth.tokens.map(t => t.name).join(', ')}`)
    // Record gateway boot time once (NX: don't overwrite on reload).
    // Used by admin /cache-hit-rate endpoint to compute since-start window.
    void (async () => {
      try {
        const { getRedis, isRedisAvailable } = await import('./redis.js')
        if (!isRedisAvailable()) return
        await getRedis().set('gateway:start_at', String(Date.now()), 'NX')
      } catch {}
    })()
  })

  return server
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  upstream: URL,
) {
  const method = req.method || 'GET'
  const path = req.url || '/'
  const clientIp = req.socket.remoteAddress || 'unknown'
  const traceId = generateTraceId()
  const debugLogging = shouldLog('debug')
  // Inbound headers are ALWAYS logged (not gated on debug) so admin log
  // detail can always show what the client actually sent. Same policy as
  // request_headers_out. Typical size is <1KB per request.
  const requestHeadersIn = normalizeHeaders(
    req.headers as Record<string, string | string[] | undefined>,
  )
  res.setHeader('x-ccg-trace-id', traceId)

  log('info', `← ${method} ${path} from ${clientIp} [${traceId}]`)
  log('debug', `Request headers: ${JSON.stringify(req.headers, null, 2)}`)

  // Health check - no auth required
  if (path === '/_health') {
    const clients = Array.from(new Set([
      ...config.auth.tokens.map(t => t.name),
      ...getAllClientNames(),
    ]))
    const poolConfigured = isPoolConfigured()
    const poolActive = isPoolEnabled()
    const singleTokenOk = !!getSingleUpstreamToken(config)
    const healthy = poolConfigured ? poolActive : singleTokenOk
    const status = healthy ? 200 : 503
    const detail = poolConfigured
      ? await describePoolUnavailability(null)
      : (singleTokenOk
          ? (getUpstreamAuthMode(config) === 'static_bearer'
              ? 'Static upstream bearer token is configured.'
              : 'Single OAuth token is valid.')
          : (getUpstreamAuthMode(config) === 'static_bearer'
              ? 'Static upstream bearer token is missing.'
              : 'Single OAuth token is expired or refreshing.'))
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: healthy ? 'ok' : 'degraded',
      oauth: poolConfigured
        ? (poolActive ? 'pool-active' : 'pool-unavailable')
        : (getUpstreamAuthMode(config) === 'static_bearer'
            ? (singleTokenOk ? 'static-bearer' : 'missing-static-bearer')
            : (singleTokenOk ? 'valid' : 'expired/refreshing')),
      pool: poolConfigured ? (poolActive ? 'active' : 'unavailable') : 'not-configured',
      detail,
      default_profile: getDefaultProfile()?.name ?? null,
      upstream: config.upstream.url,
      clients,
    }))
    return
  }

  // Models list — from model_pricing table, compatible with OpenAI format
  if (path === '/v1/models') {
    const prices = getModelPrices()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      object: 'list',
      data: prices.map(p => ({
        id: p.modelPattern,
        object: 'model',
        created: 1700000000,
        owned_by: 'anthropic',
      })),
    }))
    return
  }

  // Synchronous reload — invoked by api-server over localhost. Waits for
  // reloadAccountPool() to finish and returns a detailed diff so the admin
  // UI can show what actually changed instead of just "signal sent".
  if (path === '/_reload') {
    if (!isLoopbackAddress(req.socket.remoteAddress ?? undefined)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Forbidden: loopback only' }))
      return
    }
    const started = Date.now()
    const before = {
      pool_enabled: isPoolEnabled(),
      accounts: getAccounts().map(a => ({
        id: a.id, name: a.name, status: a.status,
        // @ts-expect-error TODO Phase 4 — admin 摘要应改为按 authKind 分支取
        expires_at: a.expiresAt,
      })),
      default_profile: getDefaultProfile()?.name ?? null,
    }

    let reloadErr: string | null = null
    try {
      await reloadAccountPool()
    } catch (err) {
      reloadErr = err instanceof Error ? err.message : String(err)
    }

    const after = {
      pool_enabled: isPoolEnabled(),
      accounts: getAccounts().map(a => ({
        id: a.id, name: a.name, status: a.status,
        // @ts-expect-error TODO Phase 4 — admin 摘要应改为按 authKind 分支取
        expires_at: a.expiresAt,
      })),
      default_profile: getDefaultProfile()?.name ?? null,
    }

    const beforeIds = new Map(before.accounts.map(a => [a.id, a]))
    const afterIds = new Map(after.accounts.map(a => [a.id, a]))
    const added = after.accounts.filter(a => !beforeIds.has(a.id)).map(a => a.name)
    const removed = before.accounts.filter(a => !afterIds.has(a.id)).map(a => a.name)
    const tokenRefreshed: string[] = []
    for (const a of after.accounts) {
      const prev = beforeIds.get(a.id)
      if (prev && prev.expires_at !== a.expires_at) tokenRefreshed.push(a.name)
    }

    const payload = {
      ok: reloadErr === null,
      error: reloadErr,
      elapsed_ms: Date.now() - started,
      pool_transition:
        before.pool_enabled === after.pool_enabled
          ? (after.pool_enabled ? 'stayed-enabled' : 'stayed-disabled')
          : (after.pool_enabled ? 'disabled→enabled' : 'enabled→disabled'),
      accounts_before: before.accounts.length,
      accounts_after: after.accounts.length,
      accounts_added: added,
      accounts_removed: removed,
      tokens_refreshed: tokenRefreshed,
      default_profile_before: before.default_profile,
      default_profile_after: after.default_profile,
      actions: [
        'loadConfiguredAccountState',
        'loadSessionTtl',
        'loadDefaultProfile',
        'syncAccounts',
        after.accounts.length > 0 ? 'hydrateVersionLocks' : null,
        after.accounts.length > 0 ? 'syncTemplatesToRedis' : null,
        after.accounts.length > 0 ? 'ensureValidToken (all)' : null,
        after.accounts.length > 0 ? 'ensurePoolTimers' : null,
      ].filter(Boolean),
    }
    res.writeHead(reloadErr ? 500 : 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
    return
  }

  // Dry-run verification - shows what would be rewritten (auth required)
  if (path === '/_verify') {
    const authResult = authenticate(req)
    if (!authResult) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    const sample = await buildVerificationPayload(config)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(sample, null, 2))
    return
  }

  // Authenticate client (proxy-level auth)
  const authResult = authenticate(req)
  if (!authResult) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized - provide client token via x-api-key header' }))
    const providedKey = req.headers['x-api-key'] as string | undefined
    const keyHint = providedKey ? `key="${providedKey.slice(0, 8)}…" (${providedKey.length} chars)` : 'no x-api-key header'
    log('warn', `Unauthorized request: ${method} ${path} [${keyHint}] from ${req.socket.remoteAddress}`)
    // Log unauthorized requests directly (logEarlyExit closure depends on
    // authResult which is null here, so inline a minimal insert).
    // Await insert before update — same serialization rule as logEarlyExit.
    try {
      await insertRequestLog({
        traceId,
        clientId: null,
        clientName: 'unknown',
        oauthAccountId: null,
        oauthAccountName: null,
        method, path, clientIp,
        requestModel: null,
        requestBody: null,
        requestHeadersIn,
        blockReason: 'auth_missing',
        blockSource: 'gw',
      })
      await updateRequestLog({
        traceId,
        responseStatus: 401,
        responseBody: { error: 'Unauthorized - provide client token via x-api-key header' },
        latencyMs: 0,
        errorMessage: 'auth_missing',
        retryCount: 0,
        blockReason: 'auth_missing',
        blockSource: 'gw',
      })
    } catch {
      // best-effort logging
    }
    return
  }

  const clientName = authResult.clientName
  let parsedRequestBody: any | null = null
  let rootShapeIn: RequestShape = classifyRequestShape({
    method,
    path,
    headers: req.headers as Record<string, string | string[] | undefined>,
    body: null,
    clientName,
  })
  let rootOperationId: string | null = null
  let rootSessionKey: string | null = null
  let operationRootTraceId: string | null = null
  let operationParentTraceId: string | null = null
  let operationIsRoot = true

  // Non-CC clients (NewAPI, wrappers) are allowed — rewriteHeaders will
  // inject a CC user-agent and all required stainless headers.
  // Only log for awareness, do not reject.

  // Streaming flag captured from request body once parsed (used for early-exit
  // inserts that happen BEFORE the main insertRequestLog below). Declared
  // ahead of the lambda because the lambda closes over it.
  let earlyExitStreaming: boolean | null = null

  // shapeAutoComplete 路径上 inbound-validate pipeline 自动补齐的字段标记。
  // 由 requestShape feature 写入 ctx.autoCompletedFields,pipeline 跑完后取出,
  // 供 logEarlyExit 闭包和主路径 insertRequestLog 都能引用进 request_logs。
  let pipelineAutoCompletedFields: string[] | null = null

  // 同样必须前置：lambda 闭包要在 TDZ 之前可读，避免早退路径 ReferenceError
  let selectedAccount: AccountSelection | null = null

  const logEarlyExit = async (
    status: number,
    errorBody: any,
    errorMsg: string,
    model?: string | null,
    requestBody?: any | null,
    blockReason?: BlockReason | null,
    blockSource?: BlockSource | null,
  ) => {
    // Await insert before update — otherwise the two fire concurrently and
    // UPDATE can land first (row not yet inserted → 0 rows affected → status/
    // block_reason silently lost).
    try {
      await insertRequestLog({
        traceId,
        clientId: authResult.clientId ?? null,
        clientName,
        // 早退也要把已选中的账号写进日志，否则形态校验 / 限流等 block 在请求日志里看不出命中谁
        oauthAccountId: selectedAccount?.account.id ?? null,
        oauthAccountName: selectedAccount?.account.name ?? null,
        method, path, clientIp,
        requestModel: model ?? null,
        requestBody: requestBody ?? null,
        requestHeadersIn,
        operationId: rootOperationId,
        rootTraceId: operationRootTraceId ?? traceId,
        parentTraceId: operationParentTraceId,
        relatedTraceIds: operationRootTraceId && operationRootTraceId !== traceId ? [operationRootTraceId, traceId] : [traceId],
        isRoot: operationIsRoot,
        sessionKey: rootSessionKey,
        requestFamilyIn: rootShapeIn.family,
        shapeProfileIn: rootShapeIn.profile,
        shapeConfidenceIn: rootShapeIn.confidence,
        shapeReason: { in: rootShapeIn.reason },
        streaming: earlyExitStreaming,
        blockReason: blockReason ?? null,
        blockSource: blockSource ?? null,
        autoCompletedFields: pipelineAutoCompletedFields,
        // 选账号之前就早退的请求(heartbeat / 鉴权失败 / quota 拦截等)还没拿到 selectedGroupId,
        // 用 client 自己绑的 group_id 做归属 —— 这条请求事实上"打算用哪个组"由客户端 binding 决定。
        selectedGroupId: selectedAccount?.selectedGroupId ?? getClientGroupId(authResult.clientId ?? null),
      })
      await updateRequestLog({
        traceId,
        responseStatus: status,
        responseBody: errorBody,
        latencyMs: 0,
        errorMessage: errorMsg,
        retryCount: 0,
        responseHeaders: null,
        blockReason: blockReason ?? null,
        blockSource: blockSource ?? null,
      })
    } catch {
      /* logger swallows errors internally — catch here keeps us robust
         against any synchronous throw prior to awaiting */
    }
  }

  // Check client/user status (PG-sourced clients only)
  if (authResult.clientStatus && authResult.clientStatus !== 'active') {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Client is not active' }))
    await logEarlyExit(403, { error: 'Client is not active' }, 'client_inactive')
    log('warn', `Blocked inactive client "${clientName}" (status=${authResult.clientStatus})`)
    return
  }
  if (authResult.userStatus && authResult.userStatus !== 'active') {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'User account is not active' }))
    await logEarlyExit(403, { error: 'User account is not active' }, 'user_inactive')
    log('warn', `Blocked inactive user for client "${clientName}" (userStatus=${authResult.userStatus})`)
    return
  }

  // Rate limiting (PG-synced config)
  if (authResult.clientId) {
    const rateLimitError = checkRateLimit(authResult.clientId, authResult.userId)
    if (rateLimitError) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ error: rateLimitError }))
      await logEarlyExit(429, { error: rateLimitError }, rateLimitError, null, null, 'rate_limited', 'gw')
      return
    }
  }

  // Plan guard — check subscription status + prebill
  let planSubscriptionId: string | undefined
  let planType: string | undefined
  let planPrebillUsd = 0
  if (path.startsWith('/v1/messages')) {
    const planResult = await checkPlanGuard(authResult.userId)
    if (!planResult.allowed) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: planResult.reason }))
      await logEarlyExit(
        403,
        { error: planResult.reason },
        planResult.reason!,
        null,
        null,
        planResult.blockReason ?? 'quota_exceeded',
        'gw',
      )
      log('warn', `Plan guard blocked: ${authResult.clientName} — ${planResult.reason}`)
      return
    }
    planSubscriptionId = planResult.subscriptionId
    planType = planResult.planType
    planPrebillUsd = planResult.prebillUsd ?? 0
  }

  // Quota check (PG-synced rules)
  if (authResult.clientId && path.startsWith('/v1/messages')) {
    const quotaResult = await checkQuota(authResult.clientId, authResult.userId)
    if (!quotaResult.allowed) {
      // 'exhausted' (client.quota_usd 累计耗尽) → 402 Payment Required
      // 'rate_limited' (时间窗规则触发)         → 429 Too Many Requests
      const status = quotaResult.reason === 'exhausted' ? 402 : 429
      const blockReason = quotaResult.reason === 'exhausted' ? 'quota_exhausted' : 'quota_exceeded'
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: quotaResult.message }))
      await logEarlyExit(status, { error: quotaResult.message }, quotaResult.message!, null, null, blockReason, 'gw')
      return
    }

    // Client-level prebill: reserve a chunk of headroom upfront so concurrent
    // requests can't all simultaneously squeak past the quota check and then
    // collectively exceed quota_usd. The real cost goes to usage_records;
    // reconcile (release the hold) fires on res 'close' regardless of which
    // branch finalizes the response (success / error / upstream timeout / client abort).
    const clientPrebill = await getPrebillUsd()
    if (clientPrebill > 0) {
      await deductClientPrebill(authResult.clientId, clientPrebill)
      const cid = authResult.clientId
      res.once('close', () => {
        reconcileClientPrebill(cid, clientPrebill).catch(() => {})
      })
    }
  }

  log('info', `Client "${clientName}" → ${method} ${path}`)

  // Collect request body
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  let body = Buffer.concat(chunks)

  // Extract model + metadata.user_id + stream from request body (for account pool selection)
  let requestModel: string | null = null
  let requestSpeed: string | null = null
  let bodyUserId: string | null = null
  let requestIsStream: boolean = true  // default true: if body has no stream field, treat as streaming
  if (body.length > 0 && path.startsWith('/v1/messages')) {
    try {
      const parsed = JSON.parse(body.toString('utf-8'))
      parsedRequestBody = parsed
      requestModel = parsed.model ?? null
      requestSpeed = parsed.speed ?? null
      requestIsStream = parsed.stream !== false
      earlyExitStreaming = requestIsStream
      const rawUid = parsed?.metadata?.user_id
      if (typeof rawUid === 'string' && rawUid.length > 0) {
        bodyUserId = rawUid
      }
    } catch { /* ignore */ }
  }

  rootShapeIn = classifyRequestShape({
    method,
    path,
    headers: req.headers as Record<string, string | string[] | undefined>,
    body: parsedRequestBody,
    clientName,
  })
  rootSessionKey = (req.headers['x-claude-code-session-id'] as string | null ?? null)
    ?? extractStickyId(bodyUserId)
    ?? (authResult.clientId ?? authResult.clientName)
  {
    const resolvedOperation = await resolveRequestOperation({
      operationId: randomUUID(),
      traceId,
      clientName,
      oauthAccountId: null,
      oauthAccountName: null,
      sessionKey: rootSessionKey,
      family: rootShapeIn.family,
      profile: rootShapeIn.profile,
      summary: {
        method,
        path,
        request_model: requestModel,
        shape_reason_in: rootShapeIn.reason,
      },
    })
    rootOperationId = resolvedOperation.operationId
    operationRootTraceId = resolvedOperation.rootTraceId
    operationParentTraceId = resolvedOperation.parentTraceId
    operationIsRoot = resolvedOperation.isRoot
  }

  log('debug', `Request body (${body.length} bytes, model=${requestModel ?? '-'}, speed=${requestSpeed ?? '-'}): ${summarizeBody(body)}`)

  // ── Heartbeat shortcut ──
  // 单 user message + 命中 hi/hello 或 "reply: X" 协议 → 不打上游、不占账号。
  // 仅 peek 号池是否还有 active+未冷却账号,然后按 Anthropic schema 模拟响应。
  // 完整识别规则见 src/heartbeat.ts。
  const heartbeat = isPoolEnabled() ? matchHeartbeat(path, parsedRequestBody) : null
  if (heartbeat) {
    const ready = await hasAnyReadyAccount()
    const heartbeatModel = (parsedRequestBody && typeof parsedRequestBody.model === 'string')
      ? parsedRequestBody.model
      : (requestModel ?? 'claude-sonnet-4-6')
    if (!ready) {
      const body503 = { type: 'error', error: { type: 'overloaded_error', message: 'Account pool empty: no ready account' } }
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body503))
      await logEarlyExit(503, body503, 'heartbeat_pool_empty', heartbeatModel, truncateBody(body), 'heartbeat_pool_empty', 'gw')
      return
    }
    // 心跳分支跟 Anthropic 对齐: stream 缺省 = false,只有显式 true 才走 SSE。
    // 全局 requestIsStream 默认 true 是 cc-gateway 历史行为,这里不依赖它。
    const heartbeatIsStream = parsedRequestBody?.stream === true
    earlyExitStreaming = heartbeatIsStream
    if (heartbeatIsStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      })
      writeHeartbeatStream(res, { model: heartbeatModel, traceId, replyText: heartbeat.replyText })
    } else {
      const payload = buildHeartbeatJsonBody({ model: heartbeatModel, traceId, replyText: heartbeat.replyText })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(payload)
    }
    await logEarlyExit(200, { type: 'message', heartbeat: true }, 'heartbeat_ok', heartbeatModel, truncateBody(body), 'heartbeat_ok', 'gw')
    log('debug', `Heartbeat OK [trace=${traceId}] stream=${heartbeatIsStream} model=${heartbeatModel} reply="${heartbeat.replyText.slice(0, 32)}"`)
    return
  }

  // NB: body and header rewrites happen INSIDE forwardToUpstream, after the
  // account is selected — so each account (including retries) gets its own
  // canonical identity applied to its own copy of the request. See applyRewrite.

  // ── Account pool or single-token selection ──
  let oauthToken: string | null = null
  const requestedForcedAccountId = firstHeaderValue(req.headers['x-ccg-force-account-id'])
  const configuredForcedAccountId = config.pool?.fixed_account_id ?? null
  const forcedAccountId = isLoopbackAddress(req.socket.remoteAddress ?? undefined)
    ? requestedForcedAccountId
    : null
  const effectiveForcedAccountId = configuredForcedAccountId || forcedAccountId

  if (isPoolEnabled()) {
    if (requestedForcedAccountId && !forcedAccountId && !configuredForcedAccountId) {
      log('warn', `Ignored forced account override from non-loopback client ${clientIp}`)
    }

    if (effectiveForcedAccountId) {
      const forcedAccount = getAccounts().find((account) => account.id === effectiveForcedAccountId)
      if (!forcedAccount) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Forced account not found in active pool' }))
        await logEarlyExit(404, { error: 'Forced account not found in active pool' }, 'forced_account_not_found')
        log('warn', `Forced account not found: ${effectiveForcedAccountId}`)
        return
      }

      const hasToken = await ensureValidToken(forcedAccount)
      const forcedCredential = forcedAccount.authKind === 'api_key'
        ? forcedAccount.apiKey
        : forcedAccount.accessToken
      if (!hasToken || !forcedCredential) {
        res.setHeader('x-ccg-selected-account-id', forcedAccount.id)
        res.setHeader('x-ccg-selected-account-name', encodeURIComponent(forcedAccount.name))
        res.setHeader('x-ccg-selection-mode', 'forced')
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Forced account token not available' }))
        await logEarlyExit(503, { error: 'Forced account token not available' }, 'forced_account_token_unavailable')
        log('error', `Forced account token unavailable for "${forcedAccount.name}"`)
        return
      }

      // Fingerprint gate removed — headers are now passed through from client,
      // no longer overridden from stored fingerprint.

      {
        const forcedClientGroupId = getClientGroupId(authResult.clientId ?? null)
        const forcedEff = resolveEffectiveGroup(forcedAccount, forcedClientGroupId)
        selectedAccount = { account: forcedAccount, isOverflow: false, selectedGroupId: forcedEff.groupId }
      }
      oauthToken = forcedCredential
      res.setHeader('x-ccg-selected-account-id', forcedAccount.id)
      res.setHeader('x-ccg-selected-account-name', encodeURIComponent(forcedAccount.name))
      res.setHeader('x-ccg-selection-mode', configuredForcedAccountId ? 'configured' : 'forced')
    } else {
      // Extract sticky key: session-id header > metadata.user_id > client_id
      const stickyKey = (req.headers['x-claude-code-session-id'] as string | null ?? null)
        ?? extractStickyId(bodyUserId)
      const poolClientId = authResult.clientId ?? authResult.clientName

      selectedAccount = await selectAccount(stickyKey, poolClientId, requestModel)
      if (selectedAccount) {
        oauthToken = selectedAccount.account.authKind === 'api_key'
          ? selectedAccount.account.apiKey
          : selectedAccount.account.accessToken
        // 调试用：暴露命中的账号信息，方便定位为何走错账号
        res.setHeader('x-ccg-selected-account-id', selectedAccount.account.id)
        res.setHeader('x-ccg-selected-account-name', encodeURIComponent(selectedAccount.account.name))
        res.setHeader('x-ccg-selected-auth-kind', selectedAccount.account.authKind)
        res.setHeader('x-ccg-selection-mode', 'pool')
      }
    }
  }

  if (isPoolConfigured() && !effectiveForcedAccountId && !selectedAccount) {
    const clientGroupIdForReason = getClientGroupId(authResult.clientId ?? null)
    const detail = await describePoolUnavailability(requestModel, clientGroupIdForReason)
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      error: 'No available OAuth accounts in pool',
      detail,
    }))
    await logEarlyExit(503, { error: detail }, detail)
    log('error', detail)
    return
  }

  // Fallback to single-token flow
  if (!oauthToken) {
    oauthToken = getSingleUpstreamToken(config)
  }

  if (!oauthToken) {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: getUpstreamAuthMode(config) === 'static_bearer' ? 'Upstream bearer token not configured' : 'OAuth token not available - gateway is refreshing' }))
    await logEarlyExit(503, { error: getUpstreamAuthMode(config) === 'static_bearer' ? 'Upstream bearer token not configured' : 'OAuth token not available' }, 'no_oauth_token')
    log('error', getUpstreamAuthMode(config) === 'static_bearer' ? 'No upstream bearer token configured' : 'No valid OAuth token available')
    return
  }

  await updateRequestOperationContext(operationRootTraceId ?? traceId, {
    oauthAccountId: selectedAccount?.account.id ?? null,
    oauthAccountName: selectedAccount?.account.name ?? null,
    sessionKey: rootSessionKey,
    summaryPatch: {
      selected_account_id: selectedAccount?.account.id ?? null,
      selected_account_name: selectedAccount?.account.name ?? null,
    },
  })

  // ── Inbound validation pipeline ──
  // 取代原 6 处 if 校验(body-integrity / request-shape / model-allowlist /
  // fast-mode-reject / require-stream),装配按 account.options 决定。OAuth 默认
  // 5 项全开;ApiKey 默认 5 项全开但 admin 可关闭任一项。outbound-* features
  // 现仍走 applyRewrite 旧路径(Phase 5 切换)。
  if (selectedAccount) {
    const validateCtx = createPipelineContext({
      req, res, method, path, clientName,
      clientId: authResult.clientId ?? null,
      clientIp,
      traceId,
      operationId: rootOperationId,
      rootTraceId: operationRootTraceId ?? traceId,
      parentTraceId: operationParentTraceId,
      requestBodyIn: body,
      parsedRequestBody,
      requestModel,
      requestSpeed,
      requestIsStream,
      bodyUserId,
      sessionKey: rootSessionKey,
      shapeIn: rootShapeIn,
      account: selectedAccount.account,
      credential: oauthToken,
    })
    const features = buildFeatures(selectedAccount.account)
      .filter(f => f.phase === 'inbound-validate')   // Phase 4 only inbound;outbound 走老路径
    const result = await runFeaturePipeline(features, validateCtx)
    // 把 inbound-validate 期间的补齐结果导出给闭包 / 主路径日志使用。
    pipelineAutoCompletedFields = validateCtx.autoCompletedFields
    // 如果 shapeAutoComplete 触发了重分类,把升级后的 profile 写回 rootShapeIn,
    // 让下游 rewriter/validateCCRequest 看到 (它们用 rootShapeIn 不读 ctx)。
    if (validateCtx.shapeInRefined) {
      rootShapeIn = validateCtx.shapeInRefined
    }
    if (!result.ok) {
      res.writeHead(result.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: result.reason },
      }))
      await logEarlyExit(
        result.status, { error: result.reason }, result.blockReason, requestModel, truncateBody(body),
        result.blockReason, result.blockSource,
      )
      log('warn', `Blocked by feature ${result.blockReason} for client="${clientName}" account="${selectedAccount.account.name}": ${result.reason}`)
      return
    }
  }

  // Track account pool request start
  const accountId = selectedAccount?.account.id ?? null
  const maxRetries = effectiveForcedAccountId ? 0 : (selectedAccount?.account.maxRetries ?? 0)
  if (accountId) {
    await onRequestStart(accountId)
  }

  const requestBodyTruncated = truncateBody(body)
  await insertRequestLog({
    traceId,
    operationId: rootOperationId,
    rootTraceId: operationRootTraceId ?? traceId,
    parentTraceId: operationParentTraceId,
    relatedTraceIds: operationRootTraceId && operationRootTraceId !== traceId ? [operationRootTraceId, traceId] : [traceId],
    isRoot: operationIsRoot,
    sessionKey: rootSessionKey,
    requestFamilyIn: rootShapeIn.family,
    shapeProfileIn: rootShapeIn.profile,
    shapeConfidenceIn: rootShapeIn.confidence,
    shapeReason: { in: rootShapeIn.reason },
    clientId: authResult.clientId ?? null,
    clientName,
    oauthAccountId: accountId,
    oauthAccountName: selectedAccount?.account.name ?? null,
    method,
    path,
    clientIp,
    requestModel,
    requestBody: requestBodyTruncated,
    requestHeadersIn,
    streaming: requestIsStream,
    autoCompletedFields: pipelineAutoCompletedFields,
    selectedGroupId: selectedAccount?.selectedGroupId ?? null,
  }).catch(() => {})

  // Forward to upstream (with retry logic for 429/503 when using account pool).
  // Body + header rewrites happen INSIDE forwardToUpstream so that each retry
  // picks up the canonical identity of the NEW account — never the previous one.
  await forwardToUpstream(
    req, res, config, upstream, method, path, body, oauthToken,
    authResult, clientName, accountId, maxRetries, selectedAccount,
    planSubscriptionId, planType, planPrebillUsd, requestModel, 0, bodyUserId, traceId,
    rootOperationId, operationRootTraceId, rootSessionKey, rootShapeIn, false,
  )
}

// Inbound CC/proxy/CDN 头不能透给直连上游：authorization/x-api-key 客户端自带、
// CC 伪装头是 CC 协议特有、cf/cdn 是反代链路注入。`x-app: cli` 也只有真 CC 会发，
// 中转网关（cchubapi 之类）会用它做反 CC 识别。
const API_KEY_FORWARD_DROP_PREFIXES = ['x-claude-code-', 'x-stainless-', 'cf-', 'x-forwarded-', 'cdn-']
const API_KEY_FORWARD_DROP_EXACT = new Set([
  'authorization',
  'x-api-key',
  'host',
  'content-length',
  'connection',
  'proxy-connection',
  'accept-encoding',
  'cdn-loop',
  'x-real-ip',
  'forwarded',
  'cookie',
  'x-app',          // CC 客户端专属(值 = "cli")
  // user-agent 不在硬清单 — 由 account.options.override.userAgent 三态决定
])

// anthropic-beta 里的 CC 协议专属 flag —— 普通 SDK 调用不会有这些。剥离后保留通用
// 模型功能 beta（interleaved-thinking、prompt-caching 等）。
const CC_ONLY_BETA_FLAG_PREFIXES = ['claude-code-']
const API_KEY_SYSTEM_BILLING_HEADER_RE = /^\s*x-anthropic-billing-header:[^\n]*(?:\n|$)/gm
const API_KEY_SYSTEM_CC_INTRO_RE = /^\s*You are Claude Code, Anthropic's official CLI for Claude\.\s*(?:\n|$)/gm

function stripCCBetaFlags(beta: string): string {
  return beta
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !CC_ONLY_BETA_FLAG_PREFIXES.some((p) => s.startsWith(p)))
    .join(',')
}

function stripApiKeySystemText(text: string): string {
  return text
    .replace(API_KEY_SYSTEM_BILLING_HEADER_RE, '')
    .replace(API_KEY_SYSTEM_CC_INTRO_RE, '')
    .trim()
}

function sanitizeApiKeyBodyValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const stripped = stripApiKeySystemText(value)
    return stripped.length > 0 ? stripped : undefined
  }
  if (Array.isArray(value)) {
    const items = value
      .map((item) => sanitizeApiKeyBodyValue(item))
      .filter((item) => item !== undefined)
    return items
  }
  if (!value || typeof value !== 'object') return value

  const src = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(src)) {
    if (key === 'metadata') continue
    const next = sanitizeApiKeyBodyValue(raw)
    if (next !== undefined) out[key] = next
  }
  return out
}

function sanitizeApiKeyRequestBody(rawBody: Buffer): Buffer {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody.toString('utf-8'))
  } catch {
    return rawBody
  }

  const sanitized = sanitizeApiKeyBodyValue(parsed)
  if (sanitized === undefined) return rawBody
  return Buffer.from(JSON.stringify(sanitized), 'utf-8')
}

function buildDirectApiKeyRewrite(
  rawBody: Buffer,
  rawHeaders: Record<string, string | string[] | undefined>,
  // 此函数整体迁移到 features/outbound-clean + apikey/forward(Phase 4),届时随之删除
  account: ApiKeyAccountVariant,
  credential: string,
  method: string,
  path: string,
  clientName?: string,
): { body: Buffer; headers: Record<string, string>; shapeOut: RequestShape; toolNameReverseMap: Map<string, string> | null } {
  const out: Record<string, string> = {}
  for (const [rawKey, rawVal] of Object.entries(rawHeaders)) {
    if (rawVal === undefined) continue
    const key = rawKey.toLowerCase()
    if (API_KEY_FORWARD_DROP_EXACT.has(key)) continue
    if (API_KEY_FORWARD_DROP_PREFIXES.some((p) => key.startsWith(p))) continue
    out[key] = Array.isArray(rawVal) ? rawVal.join(', ') : rawVal
  }

  if (account.provider === 'anthropic') {
    out['x-api-key'] = credential
    if (!out['anthropic-version']) out['anthropic-version'] = '2023-06-01'
  } else {
    // openai 兼容端点：Authorization: Bearer <key>
    out['authorization'] = `Bearer ${credential}`
  }
  if (!out['content-type']) out['content-type'] = 'application/json'
  if (!out['accept']) out['accept'] = 'application/json'

  // 剥离 anthropic-beta 里的 claude-code-* CC 专属 flag，保留模型功能 beta
  if (out['anthropic-beta']) {
    const stripped = stripCCBetaFlags(out['anthropic-beta'])
    if (stripped) out['anthropic-beta'] = stripped
    else delete out['anthropic-beta']
  }

  // 中转 API(cchubapi 之类)会按 UA 字符串挑剔;按 account.options.override.userAgent 处理
  const uaCfg = account.options.override.userAgent
  if (uaCfg.mode === 'omit') {
    delete out['user-agent']
  } else if (uaCfg.mode === 'override' && uaCfg.value) {
    out['user-agent'] = uaCfg.value
  }
  // mode='passthrough' 直接保留 inbound 透传(out 已经从 rawHeaders 拷过了)

  const sanitizedBody = sanitizeApiKeyRequestBody(rawBody)

  let parsedBody: any = null
  try { parsedBody = JSON.parse(sanitizedBody.toString('utf-8')) } catch { parsedBody = null }

  // capCacheControl 兜底:客户端发超 4 个 cache_control 块 → anthropic 400。
  // OAuth 走 disguiseBody 内部预算修剪,ApiKey 直连走这里。account.options 控制
  // 是否启用(默认 true,极少需要关)。
  let finalBody = sanitizedBody
  let bodyMutated = false
  if (parsedBody && account.options.clean.capCacheControl) {
    const stripped = capBodyCacheControl(parsedBody)
    if (stripped > 0) bodyMutated = true
  }
  // ttl 顺序修正:1h 必须在 5m 前。无视开关 — 不修就 400,语义零副作用。
  if (parsedBody) {
    const promoted = normalizeCacheControlTtlOrder(parsedBody)
    if (promoted > 0) bodyMutated = true
  }
  if (bodyMutated) {
    finalBody = Buffer.from(JSON.stringify(parsedBody), 'utf-8')
  }

  const shapeOut = classifyRequestShape({ method, path, headers: out, body: parsedBody, clientName })

  return { body: finalBody, headers: out, shapeOut, toolNameReverseMap: null }
}

/**
 * Apply canonical rewrites (body + headers) for the given account.
 * Called once per attempt — on first try AND on every retry with a new account.
 *
 * Returns a fresh {body, headers} pair; inputs are never mutated.
 */
async function applyRewrite(
  rawBody: Buffer,
  rawHeaders: Record<string, string | string[] | undefined>,
  config: Config,
  method: string,
  path: string,
  requestModel: string | null,
  requestShapeIn: RequestShape,
  account: AccountSelection | null,
  stickyKey: string,
  oauthToken: string,
  clientName?: string,
  clientIp?: string,
  externalClient: boolean = false,
): Promise<{ body: Buffer; headers: Record<string, string>; shapeOut: RequestShape; toolNameReverseMap: Map<string, string> | null }> {
  const isApiKeyAccount = account?.account.authKind === 'api_key'
  const useCanonicalApiKeyMessagesRewrite = isApiKeyAccount
    && (account!.account as ApiKeyAccountVariant).provider === 'anthropic'
    && path.startsWith('/v1/messages')
    && !path.includes('/count_tokens')

  // Disguise 是否禁用:仅当**直连真 Anthropic** (api.anthropic.com) 时禁用,
  // 第三方中转商 (api.ezfun.us 等) 即便 provider=anthropic 也要走 disguise —
  // 因为中转商内部多数转 OAuth 调真 Anthropic,body 透传过去 fingerprint 一样会
  // 被 Anthropic 风控识别为第三方("Third-party apps now draw from extra usage")。
  const isDirectAnthropicUpstream = isApiKeyAccount
    && useCanonicalApiKeyMessagesRewrite
    && /^https:\/\/api\.anthropic\.com(\/|$)/.test((account!.account as ApiKeyAccountVariant).apiBaseUrl ?? '')

  // api_key 账号默认仍走直连；只有 anthropic 的 /v1/messages 改走旧网关风格重写，恢复 CC 形态。
  if (isApiKeyAccount && !useCanonicalApiKeyMessagesRewrite) {
    return buildDirectApiKeyRewrite(
      rawBody,
      rawHeaders,
      account!.account as ApiKeyAccountVariant,
      oauthToken,
      method,
      path,
      clientName,
    )
  }

  const inboundUA = (() => {
    const raw = rawHeaders['user-agent']
    if (Array.isArray(raw)) return raw[0] ?? ''
    return typeof raw === 'string' ? raw : ''
  })()
  const signatureContextAccountId = account?.account.id ?? 'single-token'
  const shouldStripSignatures =
    path.startsWith('/v1/messages')
    && !path.includes('/count_tokens')
    && await shouldStripSignatureBlocksForContext(stickyKey, signatureContextAccountId, requestModel)
  // sink for non-cc-tool reverse map — applyRewrite 的 caller 需要它给 SSE 挂 transform
  const toolNameReverseSink: { value: Map<string, string> | null } = { value: null }

  let rewriteOpts: RewriteOptions | undefined
  if (account) {
    const profile = buildEffectiveProfile(account.account, null)
    if (profile) {
      // RewriteOptions.derivedSessionId is contractually non-empty: header
      // (x-claude-code-session-id) and body (metadata.user_id.session_id)
      // both depend on it. If getOrAssignSession ever returns falsy (slot
      // table corruption, sentinel value, etc.) fall back to a stable
      // per-account-per-hour value so the contract still holds — see
      // rapidfrost816 ban-trigger trace ccg-moie3yua-87c035f3f0ef where this
      // invariant broke and the resulting empty session-id + fallback uuid
      // mismatch leaked into the outbound to Anthropic.
      const derivedSessionId =
        getOrAssignSession(
          account.account.id, stickyKey,
          clientName ?? 'unknown',
          account.account.maxSessions,
        ) || deriveFallbackSessionId(profile.identity.account_uuid)
      rewriteOpts = {
        profile,
        derivedSessionId,
        inboundUserAgent: inboundUA,
        inboundClientIp: clientIp,
        requestShapeIn,
        disableTemplateDisguise: isDirectAnthropicUpstream,
        stripSignatureBlocks: shouldStripSignatures,
        // Tier 2 主动伪装(tools 替换 + context_management 模板化)。与 Tier 1
        // shapeAutoComplete (零副作用补齐) 边界明确分开。OAuth 账号默认 false。
        aggressiveDisguise: account.account.options?.validate?.aggressiveDisguise === true,
        // 截断 tool_use 之后的 text/thinking 块。修客户端 SDK 重组 streaming 时
        // 把 text 重复输出导致的 Anthropic 400。OAuth/APIKEY 默认 true,
        // 仅当账号显式存为 false (透传到第三方 provider) 才关闭。
        dropTrailingAfterToolUse: account.account.options?.clean?.toolUseTrailing !== false,
        // body 末尾兜底:总 cache_control 超 4 时按尾部优先 strip。OAuth 默认 true,
        // 关闭=超出后由 Anthropic 上游 400 "A maximum of 4 blocks with cache_control"。
        capCacheControl: account.account.options?.clean?.capCacheControl !== false,
        // 非 CC 工具集规整:把 read/exec/sessions_* 改写为 CC 风格,过 validateCCRequest
        // baseline。reverseMap 通过 sink 透到 SSE transform 反向还原。默认关。
        canonicalizeNonCCTools: account.account.options?.clean?.canonicalizeNonCCTools === true,
        toolNameReverseSink,
        externalClient,
      }
    }
  } else {
    // Legacy single-token mode — fall back to the DB default identity profile.
    const defaultIp = getDefaultProfile()
    if (defaultIp) {
      // synthetic account for single-token legacy mode — Phase 4 改为直接构造 PipelineContext,无需 fake account
      const syntheticAccount = {
        id: 'single-token',
        name: 'single-token',
        refreshToken: '',
        accessToken: oauthToken,
        expiresAt: 0,
        status: 'active',
        accountType: 'pro',
        maxRpm: 0,
        maxTpm: 0,
        maxConcurrent: 0,
        maxSessions: 0,
        maxDailyReq: 0,
        maxDailyTok: 0,
        maxDailyCost: 0,
        weight: 0,
        models: null,
        cooldownSeconds: 0,
        maxRetries: 0,
        sessionTtlSeconds: 0,
        outboundProxyId: null,
        canonicalIdentity: null,
        identityProfile: defaultIp,
        groupId: null,
        groupIds: [],
        authKind: 'oauth' as const,
        simulateFingerprint: true,
        organizationUuid: null,
        accountUuidCol: null,
        ccTemplateId: null,
        options: OAUTH_DEFAULT_OPTIONS,
      } as unknown as OAuthAccount
      const profile = buildEffectiveProfile(syntheticAccount, null)
      if (profile) {
        rewriteOpts = {
          profile,
          derivedSessionId: getOrAssignSession('single-token', stickyKey, 'single-token', 0),
          inboundUserAgent: inboundUA,
          inboundClientIp: clientIp,
          requestShapeIn,
          stripSignatureBlocks: shouldStripSignatures,
          dropTrailingAfterToolUse: true,
          capCacheControl: true,
          externalClient,
        }
      }
    }
  }

  let body = rawBody
  if (rawBody.length > 0) {
    try {
      body = await rewriteBody(rawBody, path, config, rewriteOpts)
    } catch (err) {
      if (err instanceof NonCCRequestError) throw err
      if (err instanceof NoTemplateBoundError) throw err
      log('error', `Body rewrite failed for ${path}: ${err}`)
    }
  }

  const headers = await rewriteHeaders(rawHeaders, config, rewriteOpts, path, body)
  if (isApiKeyAccount) {
    const apiAcct = account!.account as ApiKeyAccountVariant
    if (apiAcct.provider === 'anthropic') {
      headers['x-api-key'] = oauthToken
      delete headers['authorization']
    } else {
      headers['authorization'] = `Bearer ${oauthToken}`
    }
  } else {
    headers['authorization'] = `Bearer ${oauthToken}`
  }

  if (isApiKeyAccount) {
    const uaCfg = account!.account.options.override.userAgent
    if (uaCfg.mode === 'omit') {
      delete headers['user-agent']
    } else if (uaCfg.mode === 'override' && uaCfg.value) {
      headers['user-agent'] = uaCfg.value
    }
    // mode='passthrough' 保留 inbound(headers 已含 inbound UA)
  }

  let parsedBody: any = null
  try {
    parsedBody = JSON.parse(body.toString('utf-8'))
  } catch {
    parsedBody = null
  }
  const shapeOut = classifyRequestShape({
    method,
    path,
    headers,
    body: parsedBody,
    clientName,
  })

  return { body, headers, shapeOut, toolNameReverseMap: toolNameReverseSink.value }
}

async function forwardToUpstream(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  upstream: URL,
  method: string,
  path: string,
  rawBody: Buffer,
  oauthToken: string,
  authResult: AuthResult,
  clientName: string,
  accountId: string | null,
  maxRetries: number,
  selectedAccount: AccountSelection | null,
  planSubscriptionId: string | undefined,
  planType: string | undefined,
  planPrebillUsd: number,
  requestModel: string | null,
  retryCount: number,
  bodyUserId: string | null,
  traceId: string,
  operationId: string | null,
  operationRootTraceId: string | null,
  sessionKey: string | null,
  rootShapeIn: RequestShape,
  signatureRetryAttempted = false,
  tokenRefreshAttempted = false,
): Promise<void> {
  // api_key 账号走自己的 apiBaseUrl,不走全局 OAuth upstream
  const effectiveUpstream =
    selectedAccount?.account.authKind === 'api_key' && selectedAccount.account.apiBaseUrl
      ? new URL(selectedAccount.account.apiBaseUrl)
      : upstream
  // 真 CC anthropic SDK `beta.messages.create` 永远加 ?beta=true(HAR 验证 122/122)。
  // 不依赖 inbound URL — 任意 client 进入后,出站强制对齐真 CC path。仅 OAuth 路径
  // (api_key 透传到中转网关时不加,中转可能对未知 query 报错)。
  let outboundPath = path
  if (
    selectedAccount?.account.authKind !== 'api_key'
    && outboundPath.startsWith('/v1/messages')
    && !outboundPath.includes('/count_tokens')
    && !outboundPath.includes('beta=')
  ) {
    outboundPath += outboundPath.includes('?') ? '&beta=true' : '?beta=true'
  }
  const upstreamUrl = new URL(outboundPath, effectiveUpstream)
  const requestStart = Date.now()
  const debugLogging = shouldLog('debug')

  const selection = selectedAccount
    ? getProxyAgentForProxyId(selectedAccount.account.outboundProxyId)
    : getDirectAgent()
  if (selection.required && !selection.agent) {
    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: selection.error ?? 'Bound outbound proxy is unavailable' }))
    }
    if (accountId) {
      onRequestEnd(accountId, 0, 0, false, selection.error ?? 'bound_outbound_proxy_unavailable').catch(() => {})
    }
    return
  }
  const shouldMeter = path.startsWith('/v1/messages')

  // Re-compute the sticky key and rewrite body + headers for THIS account.
  // Must run every attempt (including retries) so the canonical identity
  // matches whichever account we're actually hitting upstream.
  const stickyKey = sessionKey
    ?? (req.headers['x-claude-code-session-id'] as string | undefined)
    ?? extractStickyId(bodyUserId)
    ?? (authResult.clientId ?? authResult.clientName)
  const clientIp = req.socket.remoteAddress || 'unknown'
  let body: Buffer
  let headers: Record<string, string>
  let toolNameReverseMap: Map<string, string> | null = null
  try {
    const externalClient = authResult.clientId
      ? (getClientById(authResult.clientId)?.externalClient === true)
      : false
    const rewritten = await applyRewrite(
      rawBody,
      req.headers as Record<string, string | string[] | undefined>,
      config,
      method,
      path,
      requestModel,
      rootShapeIn,
      selectedAccount,
      stickyKey,
      oauthToken,
      clientName,
      clientIp,
      externalClient,
    )
    body = rewritten.body
    headers = rewritten.headers
    toolNameReverseMap = rewritten.toolNameReverseMap
    const shapeOut = rewritten.shapeOut
    updateOutboundLog({
      traceId,
      retryCount,
      oauthAccountId: accountId,
      oauthAccountName: selectedAccount?.account.name ?? null,
      requestFamilyOut: shapeOut.family,
      shapeProfileOut: shapeOut.profile,
      shapeConfidenceOut: shapeOut.confidence,
      shapeReasonPatch: { out: shapeOut.reason },
      requestHeadersOut: normalizeHeaders(headers),
      requestBodyOut: truncateBody(body, 3000),
      selectedGroupId: selectedAccount?.selectedGroupId ?? null,
    }).catch(() => {})
    ;(req as any).__rootShapeOut = shapeOut
  } catch (err) {
    if (err instanceof NonCCRequestError) {
      const latencyMs = Date.now() - requestStart
      const ua = err.userAgent || 'unknown'
      const errorMessage = `non-cc request from ip=${err.clientIp ?? clientIp} ua=${ua}: tools missing baseline [${err.missingBaseline.join(',')}], got [${err.gotTools.slice(0, 10).join(',')}${err.gotTools.length > 10 ? ',...' : ''}]`
      const errorBody = {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'This gateway only serves Claude Code clients. Your request was identified as non-Claude-Code traffic and rejected.',
        },
      }
      log('warn', `Rejected non-CC request [${traceId}]: ${errorMessage}`)
      updateRequestLog({
        traceId,
        responseStatus: 400,
        responseBody: errorBody,
        latencyMs,
        errorMessage,
        retryCount,
        blockReason: 'non_cc_request',
        blockSource: 'gw',
      }).catch(() => {})
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(errorBody))
      }
      if (accountId) {
        onRequestEnd(accountId, 0, 0, false, 'non_cc_request').catch(() => {})
      }
      return
    }
    if (err instanceof NoTemplateBoundError) {
      const latencyMs = Date.now() - requestStart
      const errorMessage = `account ${err.accountId} has no cc_template_id bound — request refused (would leak version-stale fingerprint)`
      const errorBody = {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Selected account has no CC disguise template bound. Admin must import a template via /api/admin/cc-disguise-templates and bind it before this account can serve traffic.',
        },
      }
      log('warn', `Rejected request [${traceId}]: ${errorMessage}`)
      updateRequestLog({
        traceId,
        responseStatus: 503,
        responseBody: errorBody,
        latencyMs,
        errorMessage,
        retryCount,
        blockReason: 'no_template_bound',
        blockSource: 'gw',
      }).catch(() => {})
      if (!res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(errorBody))
      }
      if (accountId) {
        onRequestEnd(accountId, 0, 0, false, 'no_template_bound').catch(() => {})
      }
      return
    }
    if (err instanceof MissingTemplateRedisError) {
      const latencyMs = Date.now() - requestStart
      const errorMessage = `account ${err.accountId} bound template ${err.templateId} missing from redis — request refused`
      const errorBody = {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Selected account is bound to a CC disguise template that is missing from Redis. Sync templates before serving traffic.',
        },
      }
      log('warn', `Rejected request [${traceId}]: ${errorMessage}`)
      updateRequestLog({
        traceId,
        responseStatus: 503,
        responseBody: errorBody,
        latencyMs,
        errorMessage,
        retryCount,
        blockReason: 'no_template_bound',
        blockSource: 'gw',
      }).catch(() => {})
      if (!res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(errorBody))
      }
      if (accountId) {
        onRequestEnd(accountId, 0, 0, false, 'no_template_bound').catch(() => {})
      }
      return
    }
    throw err
  }

  log('debug', `Outbound request headers [retry=${retryCount}] [account=${selectedAccount?.account.name ?? '-'} (${selectedAccount?.account.accountType ?? '-'})]: ${JSON.stringify(headers, null, 2)}`)
  log('debug', `Outbound request body [retry=${retryCount}] (${body.length} bytes): ${summarizeBody(body)}`)

  // ── Synthetic event emission (pre-request) ──
  const requestStartMs = Date.now()
  if (shouldMeter && selectedAccount?.account && oauthToken) {
    try {
      // api_key 账号没有 OAuth Bearer,无法签 event_logging 批次;OAuth 账号则按
      // options.events.emitTengu 开关决定。两条件 AND 防止误开 ApiKey emit。
      const shouldEmitTelemetry = selectedAccount.account.authKind === 'oauth'
        && selectedAccount.account.options.events.emitTengu
      const parsedBody = JSON.parse(body.toString('utf-8'))

      // Skip event emission for quota probe requests (max_tokens=1, no system, no stream)
      // Real CC doesn't emit api_query/api_success for these.
      const isProbeRequest = parsedBody.max_tokens === 1 && !parsedBody.system && !parsedBody.stream

      // Use locked version from first connected client (auto-learned, expires 24h)
      // Extract version from already-rewritten headers (applyRewrite ran above,
      // which called rewriteHeaders → lockVersionFromFirstClient)
      const rewrittenUA = headers['user-agent'] || ''
      const vMatchRewritten = rewrittenUA.match(/claude-(?:cli|code)\/([^\s(]+)/)
      const canonicalVersion = vMatchRewritten?.[1]
        || selectedAccount?.account?.identityProfile?.env?.version
        || '2.1.112'
      const canonicalNodeVersion = headers['x-stainless-runtime-version'] || 'v22.1.0'
      // Same invariant as applyRewrite: never let derivedSessId be empty —
      // event_data.session_id and emitSessionInit's dedup key both rely on it.
      // Falls back to the canonical account UUID-derived per-hour session id
      // when no stickyKey can be extracted (rare but observed in ban traces).
      const derivedSessId = stickyKey
        ? (getOrAssignSession(
            selectedAccount.account.id, stickyKey,
            clientName,
            selectedAccount.account.maxSessions,
          ) || deriveFallbackSessionId(selectedAccount.account.canonicalIdentity?.account_uuid ?? ''))
        : deriveFallbackSessionId(selectedAccount.account.canonicalIdentity?.account_uuid ?? '')

      const emitCtx = {
        account: selectedAccount.account,
        oauthToken,
        derivedSessionId: derivedSessId,
        requestLink: {
          operationId,
          rootTraceId: operationRootTraceId ?? traceId,
          parentTraceId: traceId,
          sessionKey,
        },
        model: parsedBody.model || '',
        clientEnv: parsedBody.system?.[0]?.text?.includes?.('event_data') ? {} : {
          platform: (req.headers['x-stainless-os'] as string || 'MacOS') === 'MacOS' ? 'darwin'
            : (req.headers['x-stainless-os'] as string || '').toLowerCase(),
          node_version: canonicalNodeVersion,
          terminal: 'iTerm.app',
          // M4: env 4 字段补齐(HAR 验证 21 字段集)
          package_managers: 'npm,yarn,pnpm',
          runtimes: 'node',
          arch: req.headers['x-stainless-arch'] as string || 'arm64',
          is_claude_ai_auth: true,
          version: canonicalVersion,
          version_base: canonicalVersion,
          is_running_with_bun: false,
          is_ci: false, is_claubbit: false, is_github_action: false,
          is_claude_code_action: false, is_claude_code_remote: false,
          is_conductor: false, is_local_agent_mode: false,
          deployment_environment: `unknown-${(req.headers['x-stainless-os'] as string || 'MacOS') === 'MacOS' ? 'darwin' : 'linux'}`,
          // build_time: 真 CC 是 build 时间戳。锁版本 2.1.112 用模板抓 HAR 当时的值;
          // 实际不严格(anthropic 大概率不验证),给一个合理的固定值。
          build_time: '2026-04-16T18:33:19Z',
          vcs: 'git',
          platform_raw: (req.headers['x-stainless-os'] as string || 'MacOS') === 'MacOS' ? 'darwin' : 'linux',
        },
        clientProcess: '',
        clientBetas: headers['anthropic-beta'] || '',
        clientVersion: canonicalVersion,
        orgUuid: '',
        // M3: tengu_api_query.additional_metadata 5 字段
        rh: createHash('sha1').update(`${selectedAccount.account.id}|${derivedSessId}`).digest('hex').slice(0, 16),
        buildAgeMins: getProcessAgeMins(),
        queryChainId: derivedSessId,    // 简化:用 session id 作 chain root id
        queryDepth: 0,                   // 主线;task agent 嵌套 cc-gateway 不追踪
        effortValue: /opus/i.test(parsedBody.model || '') ? 'xhigh'
          : /sonnet/i.test(parsedBody.model || '') ? 'high'
          : 'medium',
        permissionMode: 'default',       // TODO: 加 account.options.permissionMode 让 admin 选
      }

      if (!isProbeRequest && shouldEmitTelemetry) {
        // Fire session init requests on first real message per session
        const acct = selectedAccount.account
        const stainlessOs = req.headers['x-stainless-os'] as string || 'MacOS'
        emitSessionInit(
          acct.id, derivedSessId, oauthToken, acct.outboundProxyId,
          acct.canonicalIdentity?.device_id || '',
          acct.canonicalIdentity?.account_uuid || '',
          acct.canonicalIdentity?.email || '',
          acct.organizationUuid ?? '',
          canonicalVersion, stainlessOs,
          {
            operationId,
            rootTraceId: operationRootTraceId ?? traceId,
            parentTraceId: traceId,
            sessionKey,
          },
        ).catch(() => {})

        // Extract first system-prompt block text (post-rewrite) for
        // tengu_sysprompt_block.{snippet,length,hash}.
        const firstSys = Array.isArray(parsedBody.system) ? parsedBody.system[0] : parsedBody.system
        const firstSystemBlockText =
          typeof firstSys === 'string' ? firstSys
          : typeof firstSys?.text === 'string' ? firstSys.text
          : ''

        // Heuristics so emitApiSuccess can mirror the same beta choices
        // emitApiQuery used — pre-compute here instead of re-parsing body.
        const hasStructuredOutput = parsedBody.output_config?.format?.type === 'json_schema'
        const hasToolSearch = Array.isArray(parsedBody.tools) && parsedBody.tools.some((t: any) =>
          t && (t.type === 'tool_search_20251015' || t.name === 'tool_search' || t.type?.startsWith?.('tool_search_'))
        )
        // Shared with rewriter.parseBodyHints via cc-betas.inferIsAgenticQuery
        // so the outbound HTTP `anthropic-beta` header and the synthetic
        // event_data.betas stay byte-aligned (matters for Haiku-as-main-thread
        // requests where the default `!isHaiku ⇒ side` rule misclassifies).
        const isAgenticQuery = inferIsAgenticQuery(parsedBody)
        const hasCacheControlFlag = bodyHasCacheControl(parsedBody)

        emitApiQuery(emitCtx, {
          messagesLength: parsedBody.messages?.length ?? 0,
          temperature: parsedBody.temperature,
          thinkingType: parsedBody.thinking?.type ?? 'disabled',
          firstSystemBlockText,
          body: parsedBody,
          hasStructuredOutput,
          hasToolSearch,
          isAgenticQuery,
        })

        // Stash context for post-response emitApiSuccess
        ;(req as any).__emitCtx = emitCtx
        ;(req as any).__emitHints = { hasStructuredOutput, hasToolSearch, isAgenticQuery, hasCacheControl: hasCacheControlFlag }
      }
    } catch (e) {
      log('debug', `Event emitter pre-request failed: ${e}`)
    }
  }

  // 当本次请求触发了 non-cc-tool canonicalize,响应阶段必须挂 SSE transform
  // 来反向还原 tool_use.name / input keys。transform 工作在解码后的明文流上,
  // 所以强制 outbound 用 identity 编码,避免 gzip/br 压缩。
  // 这只影响极少数小众客户端账号 — 主流量不受影响。
  const outboundHeaders: Record<string, string> = {
    ...headers,
    host: effectiveUpstream.host,
    'content-length': String(body.length),
  }
  if (toolNameReverseMap && toolNameReverseMap.size > 0) {
    outboundHeaders['accept-encoding'] = 'identity'
  }

  return new Promise<void>((resolveRequest) => {
    const proxyReq = httpsRequest(
      upstreamUrl,
      {
        method,
        headers: outboundHeaders,
        ...(selection.agent && { agent: selection.agent as any }),
      },
      (proxyRes) => {
        const status = proxyRes.statusCode || 502
        if (status === 407) {
          markProxyFailure(selection, 'proxy_auth_failed: HTTP 407').catch(() => {})
        } else {
          markProxySuccess(selection).catch(() => {})
        }

        if (status >= 200 && status < 300 && path.startsWith('/v1/messages') && !path.includes('/count_tokens')) {
          const ttlSeconds =
            selectedAccount?.account.sessionTtlSeconds && selectedAccount.account.sessionTtlSeconds > 0
              ? selectedAccount.account.sessionTtlSeconds
              : getSessionTtl()
          noteSuccessfulSignatureContext(
            stickyKey,
            accountId ?? 'single-token',
            requestModel,
            ttlSeconds,
          ).catch(() => {})
        }

        // Capture Anthropic rate limit headers and org UUID
        if (accountId) {
          captureAnthropicLimits(accountId, proxyRes.headers).catch(() => {})
          const orgId = proxyRes.headers['anthropic-organization-id']
          if (typeof orgId === 'string') cacheOrgUuid(accountId, orgId)
        }

        // Log rate-limit hint headers when upstream rejects with 429/529 so we
        // can tell concurrent/RPM/TPM/5h/7d apart instead of guessing.
        let upstream429Reason: string | null = null
        if (status === 429 || status === 529) {
          const rh = proxyRes.headers as Record<string, string | string[] | undefined>
          const pick = (k: string) => {
            const v = rh[k]
            return Array.isArray(v) ? v.join(',') : v
          }
          const hint: Record<string, string | undefined> = {
            'retry-after': pick('retry-after'),
            'anthropic-ratelimit-unified-5h-util': pick('anthropic-ratelimit-unified-5h-utilization'),
            'anthropic-ratelimit-unified-5h-status': pick('anthropic-ratelimit-unified-5h-status'),
            'anthropic-ratelimit-unified-7d-util': pick('anthropic-ratelimit-unified-7d-utilization'),
            'anthropic-ratelimit-unified-7d-status': pick('anthropic-ratelimit-unified-7d-status'),
            'anthropic-ratelimit-requests-limit': pick('anthropic-ratelimit-requests-limit'),
            'anthropic-ratelimit-requests-remaining': pick('anthropic-ratelimit-requests-remaining'),
            'anthropic-ratelimit-requests-reset': pick('anthropic-ratelimit-requests-reset'),
            'anthropic-ratelimit-tokens-limit': pick('anthropic-ratelimit-tokens-limit'),
            'anthropic-ratelimit-tokens-remaining': pick('anthropic-ratelimit-tokens-remaining'),
            'anthropic-ratelimit-tokens-reset': pick('anthropic-ratelimit-tokens-reset'),
            'anthropic-ratelimit-input-tokens-limit': pick('anthropic-ratelimit-input-tokens-limit'),
            'anthropic-ratelimit-input-tokens-remaining': pick('anthropic-ratelimit-input-tokens-remaining'),
            'anthropic-ratelimit-output-tokens-limit': pick('anthropic-ratelimit-output-tokens-limit'),
            'anthropic-ratelimit-output-tokens-remaining': pick('anthropic-ratelimit-output-tokens-remaining'),
            'request-id': pick('request-id'),
          }
          const compact = Object.fromEntries(Object.entries(hint).filter(([, v]) => v !== undefined))
          log('warn', `Upstream ${status} for account=${accountId ?? '-'}: ${JSON.stringify(compact)}`)

          // Derive a human-readable reason we can store on the account
          if (pick('anthropic-ratelimit-unified-5h-status') === 'exceeded') {
            upstream429Reason = `Anthropic 5h subscription limit exceeded (util=${pick('anthropic-ratelimit-unified-5h-utilization') ?? '?'})`
          } else if (pick('anthropic-ratelimit-unified-7d-status') === 'exceeded') {
            upstream429Reason = `Anthropic 7d subscription limit exceeded (util=${pick('anthropic-ratelimit-unified-7d-utilization') ?? '?'})`
          } else if (pick('anthropic-ratelimit-requests-remaining') === '0') {
            upstream429Reason = `Anthropic RPM exceeded (resets ${pick('anthropic-ratelimit-requests-reset') ?? '?'})`
          } else if (pick('anthropic-ratelimit-tokens-remaining') === '0' || pick('anthropic-ratelimit-input-tokens-remaining') === '0' || pick('anthropic-ratelimit-output-tokens-remaining') === '0') {
            upstream429Reason = `Anthropic TPM exceeded (resets ${pick('anthropic-ratelimit-tokens-reset') ?? pick('anthropic-ratelimit-input-tokens-reset') ?? '?'})`
          } else if (Object.keys(compact).length === 0) {
            // No rate-limit headers at all → Anthropic's anti-abuse / missing-system-prompt masquerade
            upstream429Reason = `Anthropic returned ${status} with no rate-limit headers (possible anti-abuse or invalid request — check system prompt)`
          } else {
            upstream429Reason = `Anthropic returned ${status}: ${JSON.stringify(compact).slice(0, 300)}`
          }
        }

        // ── Circuit breaker: 401/403 OAuth ban ──
        if ((status === 401 || status === 403) && accountId && selectedAccount) {
          const banCheckChunks: Buffer[] = []
          proxyRes.on('data', (chunk: Buffer) => banCheckChunks.push(chunk))
          proxyRes.on('end', async () => {
            const banBody = decodeResponseBody(
              proxyRes.headers as Record<string, string | string[] | undefined>,
              banCheckChunks,
            )
            const isBan = banBody.includes('OAuth authentication is currently not supported')
              || banBody.includes('not allowed for this organization')

            if (isBan) {
              log('error', `Circuit breaker: account "${selectedAccount!.account.name}" (${accountId}) banned by Anthropic: ${banBody.slice(0, 200)}`)
              await disableAccount(accountId, `Anthropic ${status}: ${banBody.slice(0, 200)}`)
              if (accountId) {
                await onRequestEnd(accountId, 0, 0, false, `ban_${status}`)
              }
            }
            // 401 with unambiguous "invalid authentication credentials" / "authentication_error"
            // body — Anthropic's /token endpoint may still accept refresh while /messages rejects
            // (known revocation pattern). Refresh+retry would loop forever; mark error directly.
            // invalid-auth direct mark (added 2026-05-23)
            else if (
              status === 401
              && selectedAccount.account.authKind === 'oauth'
              && !res.headersSent
              && (
                banBody.toLowerCase().includes('invalid authentication credentials')
                || banBody.toLowerCase().includes('authentication_error')
              )
            ) {
              log('error', `Anthropic 401 invalid-auth on "${selectedAccount.account.name}" (${accountId}) — marking error directly [trace=${traceId}]`)
              await markAccountUnavailable(
                selectedAccount.account,
                'error',
                `Anthropic 401 invalid-auth: ${banBody.slice(0, 150)}`,
              )
              if (accountId) {
                await onRequestEnd(accountId, 0, 0, false, `invalid_auth_${status}`)
              }
              // fall through to forward 401 to client
            }

            // 401 (non-ban, non-invalid-auth) -> force refresh + retry once.
            // Typical: token rotation race (account holder logged in elsewhere).
            //   refresh ok + retry ok  -> transparent recovery, client never sees 401
            //   refresh ok + retry 401 -> token revoked server-side, disable
            //   refresh returns false  -> invalid_grant, refresh_token also dead, disable
            else if (
              status === 401
              && !tokenRefreshAttempted
              && selectedAccount.account.authKind === 'oauth'
              && !res.headersSent
            ) {
              log('warn', `Upstream 401 on "${selectedAccount.account.name}" (${accountId}) -- attempting force refresh + retry once [trace=${traceId}]`)
              let refreshOk = false
              try {
                refreshOk = await refreshAccountToken(selectedAccount.account, true)
              } catch (err: any) {
                log('error', `Force refresh threw on "${selectedAccount.account.name}": ${err?.message ?? String(err)}`)
                refreshOk = false
              }

              const refreshedToken = selectedAccount.account.accessToken
              if (refreshOk && typeof refreshedToken === 'string' && refreshedToken.length > 0) {
                log('info', `Refresh OK for "${selectedAccount.account.name}" -- retrying request with fresh token [trace=${traceId}]`)
                if (accountId) {
                  await onRequestEnd(accountId, 0, 0, false, 'upstream_401_pre_refresh')
                }
                // refreshAccountToken mutated selectedAccount.account.accessToken in place.
                await forwardToUpstream(
                  req, res, config, upstream, method, path, rawBody,
                  refreshedToken,
                  authResult, clientName, accountId, maxRetries, selectedAccount,
                  planSubscriptionId, planType, planPrebillUsd, requestModel, retryCount, bodyUserId, traceId,
                  operationId, operationRootTraceId, sessionKey, rootShapeIn,
                  signatureRetryAttempted, true,
                )
                resolveRequest()
                return
              } else {
                // refresh failed -> token died (usually invalid_grant).
                // Use markAccountUnavailable(account, 'error') to align with the
                // existing invalid_grant convention: status='error', banned_at NULL.
                // This keeps 'banned_at' reserved exclusively for true Anthropic bans (upstream 403).
                log('error', `Refresh failed for "${selectedAccount.account.name}" -- marking error [trace=${traceId}]`)
                await markAccountUnavailable(
                  selectedAccount.account,
                  'error',
                  `Upstream 401 + refresh failed: ${banBody.slice(0, 150)}`,
                )
                if (accountId) {
                  await onRequestEnd(accountId, 0, 0, false, `token_dead_${status}`)
                }
                // fall through to forward original 401 to client
              }
            }

            // Forward the error to client
            if (!res.headersSent) {
              res.writeHead(status, { ...proxyRes.headers })
              res.end(Buffer.concat(banCheckChunks))
            }

            // Log for request tracking
            const latencyMs = Date.now() - requestStart
            updateRequestLog({
              traceId,
              responseStatus: status,
              responseBody: truncateBody(Buffer.from(banBody, 'utf-8')),
              latencyMs,
              errorMessage: isBan ? `ban_${status}: ${banBody.slice(0, 200)}` : `upstream_status_${status}: ${banBody.slice(0, 200)}`,
              retryCount,
              responseHeaders: normalizeHeaders(proxyRes.headers as Record<string, string | string[] | undefined>),
            }).catch(() => {})

            resolveRequest()
          })
          return  // Important: return early so we don't fall through to 429/503 handler
        }

        // ── Invalid thinking-signature retry ──
        if (
          status === 400
          && shouldMeter
          && !signatureRetryAttempted
          && !res.headersSent
        ) {
          const retryResponseChunks: Buffer[] = []
          proxyRes.on('data', (chunk: Buffer) => {
            retryResponseChunks.push(chunk)
          })
          proxyRes.on('end', async () => {
            const retryResponseText = decodeResponseBody(
              proxyRes.headers as Record<string, string | string[] | undefined>,
              retryResponseChunks,
            )
            const invalidSignature = isInvalidThinkingSignatureError(retryResponseText)

            if (invalidSignature) {
              const ttlSeconds =
                selectedAccount?.account.sessionTtlSeconds && selectedAccount.account.sessionTtlSeconds > 0
                  ? selectedAccount.account.sessionTtlSeconds
                  : getSessionTtl()
              await noteInvalidSignatureContext(
                stickyKey,
                accountId ?? 'single-token',
                requestModel,
                ttlSeconds,
              )
              log('warn', `Retrying request after stripping thinking signatures [trace=${traceId}] [account=${accountId ?? 'single-token'}] [session=${stickyKey}]`)

              await forwardToUpstream(
                req, res, config, upstream, method, path, rawBody, oauthToken,
                authResult, clientName, accountId, maxRetries, selectedAccount,
                planSubscriptionId, planType, planPrebillUsd, requestModel, retryCount, bodyUserId, traceId,
                operationId, operationRootTraceId, sessionKey, rootShapeIn, true,
                tokenRefreshAttempted,
              )
              resolveRequest()
              return
            }

            if (accountId) {
              await onRequestEnd(
                accountId,
                0,
                0,
                false,
                extractUpstreamFailureReason(status, retryResponseText),
              )
            }
            if (!res.headersSent) {
              res.writeHead(status, { ...proxyRes.headers })
              res.end(Buffer.concat(retryResponseChunks))
            }
            updateRequestLog({
              traceId,
              responseStatus: status,
              responseBody: truncateBody(Buffer.from(retryResponseText, 'utf-8')),
              latencyMs: Date.now() - requestStart,
              errorMessage: extractUpstreamFailureReason(status, retryResponseText),
              retryCount,
              oauthAccountId: accountId,
              oauthAccountName: selectedAccount?.account.name ?? null,
              responseHeaders: normalizeHeaders(
                proxyRes.headers as Record<string, string | string[] | undefined>,
              ),
            }).catch(() => {})
            resolveRequest()
          })
          return
        }

        // ── Auto-retry on 429/503 with account pool ──
        // api_key 直连账号不参与上游 5xx 重试：每个 api_key 账号有自己的 apiBaseUrl，
        // 换账号也是换上游业务方，对客户端是不透明的换路；直接把上游响应原样回给客户端，
        // 由客户端决定是否重试。
        const isApiKeyAccount = selectedAccount?.account.authKind === 'api_key'
        if ((status === 429 || status === 503) && isPoolEnabled() && retryCount < maxRetries && !res.headersSent && !isApiKeyAccount) {
          const retryResponseChunks: Buffer[] = []
          proxyRes.on('data', (chunk: Buffer) => {
            retryResponseChunks.push(chunk)
          })
          proxyRes.on('end', async () => {
            const retryResponseText = decodeResponseBody(
              proxyRes.headers as Record<string, string | string[] | undefined>,
              retryResponseChunks,
            )
            log('warn', `Retryable upstream response body [status=${status}] [account=${accountId ?? '-'}]: ${retryResponseText}`)

            // End current account request tracking
            if (accountId) {
              const retryAfterSec = parseRetryAfterSec(proxyRes.headers['retry-after'])
              await onRequestEnd(
                accountId,
                0,
                0,
                false,
                upstream429Reason ?? extractUpstreamFailureReason(status, retryResponseText),
                retryAfterSec,
              )
            }

            // Try a different account
            const retryStickyKey = (req.headers['x-claude-code-session-id'] as string | undefined)
              ?? extractStickyId(bodyUserId)
              ?? (authResult.clientId ?? authResult.clientName)
            const poolClientId = authResult.clientId ?? authResult.clientName
            const newSelection = await selectAccount(retryStickyKey, poolClientId, requestModel)
            const newCredential = newSelection
              ? (newSelection.account.authKind === 'api_key'
                  ? newSelection.account.apiKey
                  : newSelection.account.accessToken)
              : null
            if (newSelection && newCredential && newSelection.account.id !== accountId) {
              log('info', `Retry ${retryCount + 1}/${maxRetries}: switching to account "${newSelection.account.name}" (${newSelection.account.id}) after ${status}`)
              const newAccountId = newSelection.account.id
              await onRequestStart(newAccountId)

              await forwardToUpstream(
                req, res, config, upstream, method, path, rawBody, newCredential,
                authResult, clientName, newAccountId, maxRetries, newSelection,
                planSubscriptionId, planType, planPrebillUsd, requestModel, retryCount + 1, bodyUserId, traceId,
                operationId, operationRootTraceId, sessionKey, rootShapeIn, signatureRetryAttempted,
              )
              resolveRequest()
            } else {
              // 同账号 / 无可用账号 → 短路 retry。
              // 池里只剩这一个匹配 group 的 active 账号时,重打同账号反而把它的 errors
              // 累计到 ≥3 触发 60s cooldown(把池子打空)。Anthropic 已 429,重打更
              // 加重 rate limit。直接把上游响应透传给客户端,让它自己决定。
              if (newSelection && newSelection.account.id === accountId) {
                log('warn', `Retry ${retryCount + 1}/${maxRetries} short-circuited: only same account "${newSelection.account.name}" available after ${status} — passing through upstream response`)
              }
              res.writeHead(status, { ...proxyRes.headers })
              res.end(Buffer.concat(retryResponseChunks))
              resolveRequest()
            }
          })
          return
        }

        const responseHeaders = { ...proxyRes.headers }
        delete responseHeaders['transfer-encoding']

        res.writeHead(status, responseHeaders)

        // Stream-error handler shared by metering / non-metering paths.
        // 没这个 handler 时,上游 socket RST / Anthropic server abort 会让 'end' 永不触发,
        // updateRequestLog 永不写 → db row 卡 NULL → admin UI "日志丢失"。
        const streamErrorHandler = (err: Error) => {
          log('error', `Upstream stream error [trace=${traceId}]: ${err.message}`)
          if (!res.writableEnded) {
            try { res.end() } catch { /* swallow */ }
          }
          if (accountId) {
            onRequestEnd(accountId, 0, 0, false, `upstream_stream_error:${err.message}`).catch(() => {})
          }
          updateRequestLog({
            traceId,
            responseStatus: status,
            responseBody: null,
            latencyMs: Date.now() - requestStart,
            errorMessage: `upstream_stream_error: ${err.message}`,
            retryCount,
            oauthAccountId: accountId,
            oauthAccountName: selectedAccount?.account.name ?? null,
            responseHeaders: normalizeHeaders(proxyRes.headers as Record<string, string | string[] | undefined>),
            blockReason: 'upstream_5xx',
            blockSource: 'up',
          }).catch(() => {})
          resolveRequest()
        }
        proxyRes.on('error', streamErrorHandler)

        // 非 CC 工具集反向 transform — 仅在本次请求触发了 canonicalize 时挂上。
        // transform 写入 res,客户端拿到的是 tool_use.name / input 都已反向的形态。
        // metering 继续从原 chunk 累积(transform 工作在 stream 末端,不影响计费解析)。
        const toolReverseTransform = (toolNameReverseMap && toolNameReverseMap.size > 0)
          ? createToolNameReverseTransform(toolNameReverseMap)
          : null
        if (toolReverseTransform) {
          toolReverseTransform.on('data', (out: Buffer) => res.write(out))
          toolReverseTransform.on('end', () => { /* res.end() 由原 proxyRes.on('end') 处理 */ })
        }

        if (shouldMeter) {
          // Accumulate response for metering while streaming through
          const responseChunks: Buffer[] = []
          let firstTokenMs: number | null = null
          proxyRes.on('data', (chunk: Buffer) => {
            responseChunks.push(chunk)
            if (firstTokenMs === null) {
              // SSE first-token detection: the first visible token/event marks
              // time-to-first-token. content_block_delta is the first chunk a
              // user actually sees; message_start arrives slightly earlier and
              // is a useful fallback for clients that care about initial-ACK.
              const text = chunk.toString('utf-8')
              if (text.includes('event: content_block_delta')
                || text.includes('event: message_start')) {
                firstTokenMs = Date.now() - requestStart
              }
            }
            if (toolReverseTransform) {
              toolReverseTransform.write(chunk)
            } else {
              res.write(chunk)
            }
          })
          proxyRes.on('end', () => {
            // 若挂了 transform — 先 end transform 触发 flush,再 res.end()
            if (toolReverseTransform) {
              toolReverseTransform.end(() => { res.end() })
            } else {
              res.end()
            }
            const latencyMs = Date.now() - requestStart
            const encoding = proxyRes.headers['content-encoding'] || ''
            const responseText = decodeResponseBody(
              proxyRes.headers as Record<string, string | string[] | undefined>,
              responseChunks,
            )
            const contentType = proxyRes.headers['content-type'] || ''
            const isSSE = contentType.includes('text/event-stream')
            log('debug', `Metering: content-type=${contentType}, encoding=${encoding}, isSSE=${isSSE}, bodyLen=${responseText.length}, first100=${responseText.slice(0, 100)}`)
            const usage = isSSE
              ? parseUsageFromSSE(responseText)
              : parseUsageFromJSON(responseText)
            log('debug', `Metering: parsed usage=${JSON.stringify(usage)}`)
            if (usage) {
              // Resolve the cost multiplier from the group the request was
              // actually served on (auto-group selected at pickBestAccount time;
              // static group when the client has group_id set; 1.0 for shared
              // pool or the legacy single-token fallback).
              const billingMultiplier = getGroupMultiplier(selectedAccount?.selectedGroupId ?? null)
              const cost = calculateCost(usage, billingMultiplier)

              // Sequence: deduct from subscription FIRST so we can capture the
              // post-debit balance, then INSERT usage_records with that snapshot.
              // Fire-and-forget: both run async, but chained so balance_after is
              // accurate even if the user recharges later.
              const cid = authResult.clientId
              ;(async () => {
                const balanceAfter = (planSubscriptionId && planType)
                  ? await recordPlanUsage(planSubscriptionId, planType, cost, planPrebillUsd, new Date(requestStart))
                  : null
                const effectiveCid = cid || (await resolveConfigClientId(authResult.clientName).catch(() => null))
                if (effectiveCid) {
                  await recordUsage(
                    effectiveCid, usage, path, status, latencyMs,
                    accountId ?? undefined, planSubscriptionId, traceId,
                    billingMultiplier, balanceAfter,
                  )
                }
              })().catch(() => {})

              // Emit synthetic tengu_api_success event
              const emitCtx = (req as any).__emitCtx
              const emitHints = (req as any).__emitHints ?? {}
              if (emitCtx) {
                const reqId = proxyRes.headers['request-id']
                emitApiSuccess(emitCtx, {
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  cachedInputTokens: usage.cacheRead,
                  durationMs: latencyMs,
                  requestId: typeof reqId === 'string' ? reqId : undefined,
                  stopReason: 'end_turn',
                  costUSD: cost,
                  hasStructuredOutput: emitHints.hasStructuredOutput,
                  hasToolSearch: emitHints.hasToolSearch,
                  hasCacheControl: emitHints.hasCacheControl,
                  isAgenticQuery: emitHints.isAgenticQuery,
                })
              }

              // Track account pool metrics
              if (accountId) {
                const totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheRead + usage.cacheWrite
                const retryAfterSec = status >= 400 ? parseRetryAfterSec(proxyRes.headers['retry-after']) : null
                onRequestEnd(
                  accountId,
                  totalTokens,
                  cost,
                  status < 400,
                  status < 400 ? null : (upstream429Reason ?? extractUpstreamFailureReason(status, responseText)),
                  retryAfterSec,
                ).catch(() => {})
              }

              // (recordPlanUsage was moved above into the sequenced
              //  recordUsage block so balance_after can be snapshotted.)
            } else {
              // No usage parsed but still need to end account tracking
              if (accountId) {
                const retryAfterSec = status >= 400 ? parseRetryAfterSec(proxyRes.headers['retry-after']) : null
                onRequestEnd(
                  accountId,
                  0,
                  0,
                  status < 400,
                  status < 400 ? null : (upstream429Reason ?? extractUpstreamFailureReason(status, responseText)),
                  retryAfterSec,
                ).catch(() => {})
              }
              // Refund the prebill for requests that produced no usage —
              // balance only, don't touch windows (realCost was 0, nothing
              // was actually consumed).
              if (planSubscriptionId && planPrebillUsd > 0) {
                query(
                  'UPDATE subscriptions SET balance = balance + $1, updated_at = now() WHERE id = $2',
                  [planPrebillUsd, planSubscriptionId],
                ).catch(() => {})
              }
            }
            const responseBodyTruncated = truncateBody(Buffer.from(responseText))
            const upstreamBlockReason: BlockReason | null =
              status === 429 ? 'upstream_429'
              : status >= 500 && status < 600 ? 'upstream_5xx'
              : null
            updateRequestLog({
              traceId,
              responseStatus: status,
              responseBody: responseBodyTruncated,
              latencyMs,
              errorMessage: status >= 400 ? (upstream429Reason ?? extractUpstreamFailureReason(status, responseText)) : null,
              retryCount,
              oauthAccountId: accountId,
              oauthAccountName: selectedAccount?.account.name ?? null,
              // Always log response headers — rate-limit hints, request-id,
              // retry-after etc. live here and we need them for 429/529
              // diagnosis even when debug logging is off.
              responseHeaders: normalizeHeaders(
                proxyRes.headers as Record<string, string | string[] | undefined>,
              ),
              firstTokenMs,
              blockReason: upstreamBlockReason,
              blockSource: upstreamBlockReason ? 'up' : null,
            }).catch(() => {})
            resolveRequest()
          })
        } else {
          // Stream response directly (non-messages endpoints)
          // toolReverseTransform 不会命中(非 messages 路径没 tool_use),直接 pipe
          proxyRes.pipe(res)
          proxyRes.on('end', () => {
            // End account tracking for non-metered requests
            if (accountId) {
              onRequestEnd(
                accountId,
                0,
                0,
                status < 400,
                status < 400 ? null : (upstream429Reason ?? `upstream_status_${status}`),
              ).catch(() => {})
            }
            const nonMeteredBlock: BlockReason | null =
              status === 429 ? 'upstream_429'
              : status >= 500 && status < 600 ? 'upstream_5xx'
              : null
            updateRequestLog({
              traceId,
              responseStatus: status,
              responseBody: null,
              latencyMs: Date.now() - requestStart,
              errorMessage: status >= 400 ? `upstream_status_${status}` : null,
              retryCount,
              oauthAccountId: accountId,
              oauthAccountName: selectedAccount?.account.name ?? null,
              responseHeaders: normalizeHeaders(
                proxyRes.headers as Record<string, string | string[] | undefined>,
              ),
              blockReason: nonMeteredBlock,
              blockSource: nonMeteredBlock ? 'up' : null,
            }).catch(() => {})
            resolveRequest()
          })
        }

        if (config.logging.audit) {
          audit(clientName, method, path, status)
        }
      },
    )

    proxyReq.on('error', (err) => {
      markProxyFailure(selection, `upstream_proxy: ${err.message}`).catch(() => {})
      log('error', `Upstream error: ${err.message}`)
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Bad gateway', detail: err.message }))
      }
      if (accountId) {
        onRequestEnd(accountId, 0, 0, false, `upstream_error:${err.message}`).catch(() => {})
      }
      updateRequestLog({
        traceId,
        responseStatus: 502,
        responseBody: null,
        latencyMs: Date.now() - requestStart,
        errorMessage: `upstream_error:${err.message}`,
        retryCount,
        oauthAccountId: accountId,
        oauthAccountName: selectedAccount?.account.name ?? null,
        responseHeaders: null,
        blockReason: 'upstream_5xx',
        blockSource: 'up',
      }).catch(() => {})
      if (config.logging.audit) {
        audit(clientName, method, path, 502)
      }
      resolveRequest()
    })

    proxyReq.write(body)
    proxyReq.end()
  })
}

/**
 * Build a sample payload showing what the rewriter produces.
 * Used by /_verify endpoint for admin validation.
 */
async function buildVerificationPayload(config: Config) {
  // Simulate a /v1/messages request body
  const sampleInput = {
    metadata: {
      user_id: JSON.stringify({
        device_id: 'REAL_DEVICE_ID_FROM_CLIENT_abc123',
        account_uuid: 'shared-account-uuid',
        session_id: 'session-xxx',
      }),
    },
    system: [
      {
        type: 'text',
        text: `x-anthropic-billing-header: cc_version=2.1.81.a1b; cc_entrypoint=cli;`,
      },
      {
        type: 'text',
        text: `Here is useful information about the environment:\n<env>\nWorking directory: /home/bob/myproject\nPlatform: linux\nShell: bash\nOS Version: Linux 6.5.0-generic\n</env>`,
      },
    ],
    messages: [{ role: 'user', content: 'hello' }],
  }

  const rewrittenBuf = await rewriteBody(Buffer.from(JSON.stringify(sampleInput)), '/v1/messages', config)
  const rewritten = JSON.parse(rewrittenBuf.toString('utf-8'))

  return {
    _info: 'This shows how the gateway rewrites a sample request',
    before: {
      'metadata.user_id': JSON.parse(sampleInput.metadata.user_id),
      billing_header: sampleInput.system[0].text,
      system_prompt_env: sampleInput.system[1].text,
      system_block_count: sampleInput.system.length,
    },
    after: {
      'metadata.user_id': JSON.parse(rewritten.metadata.user_id),
      billing_header: '(stripped)',
      system_prompt_env: rewritten.system[0]?.text ?? '(empty)',
      system_block_count: rewritten.system.length,
    },
  }
}
