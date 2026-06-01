/**
 * Synthetic event emitter — generates event_logging batches that mirror
 * what a real Claude Code client would send alongside /v1/messages requests.
 *
 * Real CC sends event_logging directly to api.anthropic.com (hardcoded,
 * bypasses ANTHROPIC_BASE_URL). When using the gateway, the shared OAuth
 * account has messages traffic but NO event_logging → detectable anomaly.
 *
 * This module fills that gap by emitting tengu_api_query (before) and
 * tengu_api_success (after) events for each proxied messages request,
 * sent directly to api.anthropic.com using the shared OAuth token.
 */

import { request as httpsRequest } from 'https'
import { createHash, randomUUID } from 'crypto'
import { getEventBetas, getHeaderBetas, bodyHasCacheControl, type BetaHints } from './cc-betas.js'
import { log } from './logger.js'
import { getProxyAgentForProxyId } from './proxy-agent.js'
import { generateTraceId, insertRequestLog, updateRequestLog, truncateBody } from './request-logger.js'
import { getAccounts, resolveEffectiveGroup, type OAuthAccount } from './account-pool.js'

/**
 * Gateway 自己发出的 outbound 流量 (event_batch / session_init) 在 request_logs
 * 里也要带组归属,否则后台日志看着像"共享池",运营无法按组定位伪装链路。
 * 规则与主路径 auto 模式一致:取账号 groupIds 里最便宜的;共享池账号返回 null。
 */
function resolveOutboundLogTarget(accountId: string): {
  oauthAccountId: string | null
  oauthAccountName: string | null
  selectedGroupId: string | null
} {
  const account = getAccounts().find((a) => a.id === accountId)
  if (!account) {
    return { oauthAccountId: accountId, oauthAccountName: null, selectedGroupId: null }
  }
  const eff = resolveEffectiveGroup(account, null)
  return {
    oauthAccountId: account.id,
    oauthAccountName: account.name,
    selectedGroupId: eff.groupId,
  }
}

const EVENT_LOGGING_URL = 'https://api.anthropic.com/api/event_logging/v2/batch'
const BATCH_INTERVAL_MS = 10_000  // 10s, matches real CC GrowthBook config
const MAX_BATCH_SIZE = 400

type RequestLink = {
  operationId: string | null
  rootTraceId: string | null
  parentTraceId: string | null
  sessionKey: string | null
}

// Accumulator — events are queued per (account + session), so each flushed
// batch contains events from a single session_id, matching real CC behavior.
// Key: `${accountId}:${derivedSessionId}`
const eventQueues = new Map<string, {
  events: any[]
  token: string
  proxyId: string | null
  version: string
  sessionKey: string | null
  traceIds: Set<string>
  operationIds: Set<string>
  // 入队时就锁定账号 / 分组归属:flushQueue 异步触发,期间账号可能被禁用,
  // 不能等 flush 时再去 account-pool 查(那时账号已被 syncAccounts 过滤掉)。
  accountName: string | null
  selectedGroupId: string | null
}>()
let flushTimer: ReturnType<typeof setInterval> | null = null

export function startEventEmitter(): void {
  if (flushTimer) return
  flushTimer = setInterval(flushAllQueues, BATCH_INTERVAL_MS)
  log('info', 'Event emitter started (interval=' + BATCH_INTERVAL_MS + 'ms)')
}

export function stopEventEmitter(): void {
  if (flushTimer) {
    clearInterval(flushTimer)
    flushTimer = null
  }
  // Final flush
  flushAllQueues()
}

/** Enqueue a synthetic event for the given account + session. */
function enqueue(
  accountId: string,
  sessionId: string,
  token: string,
  proxyId: string | null,
  version: string,
  event: any,
  link?: RequestLink,
): void {
  const key = `${accountId}:${sessionId}`
  let q = eventQueues.get(key)
  if (!q) {
    const target = resolveOutboundLogTarget(accountId)
    q = {
      events: [],
      token,
      proxyId,
      version,
      sessionKey: link?.sessionKey ?? null,
      traceIds: new Set(),
      operationIds: new Set(),
      accountName: target.oauthAccountName,
      selectedGroupId: target.selectedGroupId,
    }
    eventQueues.set(key, q)
  }
  q.token = token  // always use latest token
  q.version = version
  q.sessionKey = link?.sessionKey ?? q.sessionKey
  if (link?.rootTraceId) q.traceIds.add(link.rootTraceId)
  if (link?.operationId) q.operationIds.add(link.operationId)
  q.events.push(event)

  if (q.events.length >= MAX_BATCH_SIZE) {
    flushQueue(key)
  }
}

function flushAllQueues(): void {
  for (const accountId of eventQueues.keys()) {
    flushQueue(accountId)
  }
}

function flushQueue(queueKey: string): void {
  const q = eventQueues.get(queueKey)
  if (!q || q.events.length === 0) return

  // queueKey 实际是 `${accountId}:${sessionId}` (见 enqueue 处构造),
  // 旧代码这里参数名错叫 accountId,把整个 key 当 account 用了。
  // 我们要的真账号 id 就是首段。
  const accountId = queueKey.split(':')[0] ?? queueKey

  const events = q.events.splice(0)
  const token = q.token
  const proxyId = q.proxyId
  const version = q.version
  const sessionKey = q.sessionKey
  const relatedTraceIds = Array.from(q.traceIds)
  const relatedOperationIds = Array.from(q.operationIds)
  const accountName = q.accountName
  const selectedGroupId = q.selectedGroupId
  q.traceIds.clear()
  q.operationIds.clear()

  sendBatch(accountId, accountName, selectedGroupId, events, token, proxyId, version, sessionKey, relatedTraceIds, relatedOperationIds).catch(err => {
    log('warn', `Event emitter flush failed for account=${accountId}: ${err}`)
  })
}

async function sendBatch(
  accountId: string,
  accountName: string | null,
  selectedGroupId: string | null,
  events: any[],
  token: string,
  proxyId: string | null,
  version: string,
  sessionKey: string | null,
  relatedTraceIds: string[],
  relatedOperationIds: string[],
): Promise<void> {
  const body = JSON.stringify({ events })
  const url = new URL(EVENT_LOGGING_URL)
  const traceId = generateTraceId()
  const startMs = Date.now()
  const outboundTarget = {
    oauthAccountId: accountId,
    oauthAccountName: accountName,
    selectedGroupId,
  }
  const outHeaders: Record<string, string> = {
    'accept': 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'user-agent': `claude-code/${version}`,
    'x-service-name': 'claude-code',
    'authorization': `Bearer ${token.substring(0, 20)}...`,
    'anthropic-beta': 'oauth-2025-04-20',
    // axios on real CC adds this automatically; without it our synthetic
    // event_logging POSTs differ from HAR-confirmed CC traffic.
    'accept-encoding': 'gzip, compress, deflate, br',
    'connection': 'close',
  }

  const bodyForLog = {
    event_count: events.length,
    events: events.slice(0, 3).map((e: any) => ({
      event_type: e.event_type,
      event_name: e.event_data?.event_name,
      session_id: e.event_data?.session_id,
      device_id: e.event_data?.device_id?.substring(0, 16) + '...',
    })),
  }

  const selection = getProxyAgentForProxyId(proxyId)
  const agent = selection.agent ?? undefined

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        agent,
        headers: {
          ...outHeaders,
          'authorization': `Bearer ${token}`,
          'content-length': Buffer.byteLength(body).toString(),
        },
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          try {
            const latency = Date.now() - startMs
            // Anthropic /api/event_logging/v2/batch returns gzip-compressed
            // bytes (we send `accept-encoding: gzip,...` to match real CC).
            // Use truncateBody so null bytes are stripped before going into
            // JSONB; otherwise PostgreSQL rejects `\u0000` with
            // "unsupported Unicode escape sequence" and the whole UPDATE is
            // rolled back, leaving response_status/latency_ms permanently
            // NULL ("[outbound] event_batch 全部日志丢失").
            const raw = Buffer.concat(chunks)
            const parsedBody = truncateBody(raw, 500)
            const errText = parsedBody && typeof parsedBody === 'object' && '_raw_text' in parsedBody
              ? String((parsedBody as { _raw_text: string })._raw_text)
              : parsedBody ? JSON.stringify(parsedBody).slice(0, 500) : null
            if (res.statusCode && res.statusCode >= 400) {
              log('warn', `Event emitter: ${res.statusCode} ${errText ? errText.substring(0, 200) : ''}`)
            }
            insertRequestLog({
              traceId,
              operationId: relatedOperationIds.length === 1 ? relatedOperationIds[0] : null,
              rootTraceId: relatedTraceIds.length === 1 ? relatedTraceIds[0] : null,
              parentTraceId: relatedTraceIds.length === 1 ? relatedTraceIds[0] : null,
              relatedTraceIds: relatedTraceIds.length > 0 ? relatedTraceIds : null,
              isRoot: false,
              sessionKey,
              requestFamilyIn: 'telemetry',
              requestFamilyOut: 'telemetry',
              shapeProfileIn: 'event_logging_batch',
              shapeProfileOut: 'event_logging_batch',
              shapeConfidenceIn: 100,
              shapeConfidenceOut: 100,
              shapeReason: { in: { path: url.pathname }, out: { event_count: events.length } },
              clientId: null,
              clientName: '[outbound] event_batch',
              oauthAccountId: outboundTarget.oauthAccountId,
              oauthAccountName: outboundTarget.oauthAccountName,
              selectedGroupId: outboundTarget.selectedGroupId,
              method: 'POST',
              path: url.pathname,
              clientIp: 'gateway',
              requestModel: null,
              requestBody: null,
              requestHeadersOut: outHeaders,
              requestBodyOut: bodyForLog,
            }).then(() => {
              updateRequestLog({
                traceId,
                responseStatus: res.statusCode ?? 0,
                responseBody: parsedBody,
                latencyMs: latency,
                errorMessage: res.statusCode && res.statusCode >= 400 ? errText : null,
                retryCount: 0,
                responseHeaders: res.headers as Record<string, string | string[]>,
              }).catch(() => {})
            }).catch(() => {})
          } catch (logErr) {
            log('warn', `Event emitter log failed: ${logErr}`)
          }
          resolve()
        })
      },
    )
    req.on('error', err => {
      try {
        insertRequestLog({
          traceId,
          operationId: relatedOperationIds.length === 1 ? relatedOperationIds[0] : null,
          rootTraceId: relatedTraceIds.length === 1 ? relatedTraceIds[0] : null,
          parentTraceId: relatedTraceIds.length === 1 ? relatedTraceIds[0] : null,
          relatedTraceIds: relatedTraceIds.length > 0 ? relatedTraceIds : null,
          isRoot: false,
          sessionKey,
          requestFamilyIn: 'telemetry',
          requestFamilyOut: 'telemetry',
          shapeProfileIn: 'event_logging_batch',
          shapeProfileOut: 'event_logging_batch',
          shapeConfidenceIn: 100,
          shapeConfidenceOut: 100,
          shapeReason: { in: { path: url.pathname }, out: { event_count: events.length } },
          clientId: null, clientName: '[outbound] event_batch',
          oauthAccountId: outboundTarget.oauthAccountId,
          oauthAccountName: outboundTarget.oauthAccountName,
          selectedGroupId: outboundTarget.selectedGroupId,
          method: 'POST', path: url.pathname, clientIp: 'gateway',
          requestModel: null, requestBody: null, requestBodyOut: bodyForLog,
          requestHeadersOut: outHeaders,
        }).then(() => {
          updateRequestLog({
            traceId, responseStatus: 0, responseBody: null,
            latencyMs: Date.now() - startMs, errorMessage: String(err), retryCount: 0,
          }).catch(() => {})
        }).catch(() => {})
      } catch {}
      reject(err)
    })
    req.write(body)
    req.end()
  })
}

// ── Session init requests ──
// Real CC sends these on startup. Gateway fires them once per derived session.

// Persist init state in Redis so pm2 restarts don't re-trigger.
// Fallback to in-memory if Redis unavailable.
const initializedSessionsLocal = new Set<string>()

async function isSessionInitialized(key: string): Promise<boolean> {
  if (initializedSessionsLocal.has(key)) return true
  try {
    const { getRedis, isRedisAvailable } = await import('./redis.js')
    if (isRedisAvailable()) {
      const val = await getRedis().get(`session_init:${key}`)
      if (val) { initializedSessionsLocal.add(key); return true }
    }
  } catch {}
  return false
}

async function markSessionInitialized(key: string): Promise<void> {
  initializedSessionsLocal.add(key)
  try {
    const { getRedis, isRedisAvailable } = await import('./redis.js')
    if (isRedisAvailable()) {
      await getRedis().set(`session_init:${key}`, '1', 'EX', 86400) // 24h TTL
    }
  } catch {}
}

export async function emitSessionInit(
  accountId: string,
  derivedSessionId: string,
  oauthToken: string,
  proxyId: string | null,
  deviceId: string,
  accountUuid: string,
  email: string,
  orgUuid: string,
  clientVersion: string,
  platform: string,
  link?: RequestLink,
): Promise<void> {
  const key = `${accountId}:${derivedSessionId}`
  if (await isSessionInitialized(key)) return
  await markSessionInitialized(key)

  const selection = getProxyAgentForProxyId(proxyId)
  const agent = selection.agent ?? undefined
  const authHeaders = {
    'authorization': `Bearer ${oauthToken}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'accept-encoding': 'gzip, compress, deflate, br',
    'host': 'api.anthropic.com',
    'connection': 'close',
  }
  const outboundTarget = resolveOutboundLogTarget(accountId)

  // Fire-and-forget — don't block the messages request.
  // omitAuth=true 用于 anthropic 公开 endpoint(/mcp-registry/v0/servers 等),
  // 真 CC 走 axios 不带 OAuth Bearer。
  const fire = (method: string, path: string, extraHeaders: Record<string, string>, body?: string, omitAuth = false) => {
    const url = new URL(`https://api.anthropic.com${path}`)
    const tid = generateTraceId()
    const startMs = Date.now()

    // Hold the INSERT promise so UPDATE can await it before running —
    // otherwise fast responses (<50ms) race past the INSERT and the UPDATE's
    // WHERE-clause matches zero rows silently, leaving the row stuck at NULL
    // response_status/latency_ms (shown as "日志丢失" in the admin UI).
    const insertPromise = insertRequestLog({
      traceId: tid,
      operationId: link?.operationId ?? null,
      rootTraceId: link?.rootTraceId ?? null,
      parentTraceId: link?.parentTraceId ?? null,
      relatedTraceIds: link?.rootTraceId ? [link.rootTraceId] : null,
      isRoot: false,
      sessionKey: link?.sessionKey ?? null,
      requestFamilyIn: 'telemetry',
      requestFamilyOut: 'telemetry',
      shapeProfileIn: `session_init:${url.pathname}`,
      shapeProfileOut: `session_init:${url.pathname}`,
      shapeConfidenceIn: 100,
      shapeConfidenceOut: 100,
      shapeReason: { in: { path: url.pathname }, out: { path: url.pathname } },
      clientId: null,
      clientName: '[outbound] session_init',
      oauthAccountId: outboundTarget.oauthAccountId,
      oauthAccountName: outboundTarget.oauthAccountName,
      selectedGroupId: outboundTarget.selectedGroupId,
      method,
      path: url.pathname + url.search,
      clientIp: 'gateway',
      requestModel: null,
      requestBody: null,
      requestBodyOut: body ? { _truncated: body.substring(0, 2000) } : null,
      requestHeadersOut: { ...extraHeaders, 'user-agent': extraHeaders['user-agent'] || 'unknown' },
    }).catch(() => {})

    const req = httpsRequest({
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,
      agent,
      headers: {
        ...(omitAuth
          ? { 'host': 'api.anthropic.com', 'accept-encoding': 'gzip, compress, deflate, br', 'connection': 'close' }
          : authHeaders),
        ...extraHeaders,
        ...(body ? { 'content-length': Buffer.byteLength(body).toString() } : {}),
      },
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', async () => {
        try {
          const raw = Buffer.concat(chunks)
          const parsedBody = truncateBody(raw, 500)
          // parsedBody may be { _raw_text: "..." } for non-JSON; serialize for error column
          const errText = parsedBody && typeof parsedBody === 'object' && '_raw_text' in parsedBody
            ? String(parsedBody._raw_text)
            : parsedBody ? JSON.stringify(parsedBody).slice(0, 500) : null
          log('debug', `Session init ${method} ${path}: ${res.statusCode}`)
          await insertPromise
          await updateRequestLog({
            traceId: tid,
            responseStatus: res.statusCode ?? 0,
            responseBody: parsedBody,
            latencyMs: Date.now() - startMs,
            errorMessage: res.statusCode && res.statusCode >= 400 ? errText : null,
            retryCount: 0,
            responseHeaders: res.headers as Record<string, string | string[]>,
          }).catch(() => {})
        } catch {}
      })
    })
    req.on('error', async err => {
      try {
        log('debug', `Session init ${method} ${path} failed: ${err}`)
        await insertPromise
        await updateRequestLog({
          traceId: tid, responseStatus: 0, responseBody: null,
          latencyMs: Date.now() - startMs, errorMessage: String(err), retryCount: 0,
        }).catch(() => {})
      } catch {}
    })
    if (body) req.write(body)
    req.end()
  }

  // GrowthBook SDK eval
  const gbBody = JSON.stringify({
    attributes: {
      id: deviceId,
      sessionId: derivedSessionId,
      deviceID: deviceId,
      platform: platform === 'MacOS' ? 'darwin' : platform.toLowerCase(),
      organizationUUID: orgUuid,
      accountUUID: accountUuid,
      userType: 'external',
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
      email,
      appVersion: clientVersion,
    },
    forcedVariations: {},
    forcedFeatures: [],
    url: '',
  })
  fire('POST', '/api/eval/sdk-zAZezfDKGoZuXXKe', {
    'content-type': 'application/json',
    'accept': '*/*',
    'user-agent': 'node',
    'accept-language': '*',
    'sec-fetch-mode': 'cors',
  }, gbBody)

  // Account settings
  fire('GET', '/api/oauth/account/settings', {
    'accept': 'application/json, text/plain, */*',
    'user-agent': `claude-code/${clientVersion}`,
  })

  // Grove
  fire('GET', '/api/claude_code_grove', {
    'accept': 'application/json, text/plain, */*',
    'user-agent': `claude-cli/${clientVersion} (external, cli)`,
  })

  // Bootstrap
  fire('GET', '/api/claude_cli/bootstrap', {
    'accept': 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'user-agent': `claude-code/${clientVersion}`,
  })

  // Penguin mode
  fire('GET', '/api/claude_code_penguin_mode', {
    'accept': 'application/json, text/plain, */*',
    'user-agent': 'axios/1.13.6',
  })

  // MCP servers
  fire('GET', '/v1/mcp_servers?limit=1000', {
    'accept': 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'anthropic-beta': 'mcp-servers-2025-12-04',
    'anthropic-version': '2023-06-01',
    'user-agent': 'axios/1.13.6',
  })

  // MCP registry browse — 公开 endpoint,无 OAuth Bearer(HAR 验证)。CC 启动会
  // 拉一次社区 server 列表;cursor 分页省略(真 CC 翻页按需,首页足以匹配 baseline)。
  fire('GET', '/mcp-registry/v0/servers?version=latest&limit=100&visibility=commercial%2Cgsuite%2Centerprise%2Chealth', {
    'accept': 'application/json, text/plain, */*',
    'user-agent': 'axios/1.13.6',
  }, undefined, true)

  // M5: 每 session 启动的 3 个固定 tengu_* event(HAR 验证 per-session 各发 1 次)。
  // 入 batch 队列,跟 messages event 一起 flush。rh = per-session stable hash。
  const sessionRh = createHash('sha1').update(`${accountId}|${derivedSessionId}`).digest('hex').slice(0, 16)
  const enqueueStartupEvent = (eventName: string, am: Record<string, any>) => {
    const fullAm = { rh: sessionRh, ...am }
    enqueue(accountId, derivedSessionId, oauthToken, proxyId, clientVersion, {
      event_type: 'ClaudeCodeInternalEvent',
      event_data: {
        event_name: eventName,
        client_timestamp: new Date().toISOString(),
        model: '',
        session_id: derivedSessionId,
        user_type: 'external',
        betas: '',
        env: {
          platform: platform === 'MacOS' ? 'darwin' : platform.toLowerCase(),
          node_version: 'v22.12.0',
          terminal: 'iTerm.app',
          package_managers: 'npm,yarn,pnpm',
          runtimes: 'node',
          arch: 'arm64',
          is_claude_ai_auth: true,
          version: clientVersion,
          version_base: clientVersion,
          is_running_with_bun: false,
          is_ci: false, is_claubbit: false, is_github_action: false,
          is_claude_code_action: false, is_claude_code_remote: false,
          is_conductor: false, is_local_agent_mode: false,
          deployment_environment: `unknown-${platform === 'MacOS' ? 'darwin' : 'linux'}`,
          build_time: '2026-04-16T18:33:19Z',
          vcs: 'git',
          platform_raw: platform === 'MacOS' ? 'darwin' : 'linux',
        },
        entrypoint: 'cli',
        is_interactive: true,
        client_type: 'cli',
        process: '',
        additional_metadata: Buffer.from(JSON.stringify(fullAm)).toString('base64'),
        auth: { organization_uuid: orgUuid, account_uuid: accountUuid },
        event_id: randomUUID(),
        device_id: deviceId,
        email,
      },
    }, link)
  }

  enqueueStartupEvent('tengu_started', {})
  enqueueStartupEvent('tengu_startup_telemetry', {
    is_git: true,
    worktree_count: 1,
    gh_auth_status: 'authenticated',
    sandbox_enabled: false,
    are_unsandboxed_commands_allowed: true,
    is_auto_bash_allowed_if_sandbox_enabled: true,
    auto_updater_disabled: true,
    prefers_reduced_motion: false,
    has_node_extra_ca_certs: true,
  })
  enqueueStartupEvent('tengu_startup_manual_model_config', {
    settings_file: 'opus[1m]',
    subscriptionType: 'max',
  })

  log('info', `Session init requests fired for ${key}`)
}

// ── Event builders ──

type EmitContext = {
  account: OAuthAccount
  oauthToken: string
  derivedSessionId: string
  requestLink?: RequestLink
  model: string
  clientEnv: Record<string, any>    // passthrough from client's inbound headers/body
  clientProcess: string             // base64 process metrics from client
  clientBetas: string
  clientVersion: string
  orgUuid: string
  // M3: tengu_api_query.additional_metadata 5 字段(HAR 验证)
  rh: string                        // repository hash,per-account stable
  buildAgeMins: number              // gateway process uptime in minutes
  queryChainId: string              // per-session sticky UUID(根 chain)
  queryDepth: number                // task agent 嵌套深度,默认 0(主线)
  effortValue: string               // 'xhigh'(opus) | 'high'(sonnet) | 'medium'(haiku)
  permissionMode: string            // 'default' | 'bypassPermissions' | 'plan' | 'acceptEdits'
}

// M3: gateway 进程启动时间(用于 buildAgeMins)
const PROCESS_STARTED_AT_MS = Date.now()
export function getProcessAgeMins(): number {
  return Math.floor((Date.now() - PROCESS_STARTED_AT_MS) / 60_000)
}

// Cache org UUID per account (captured from response headers)
const orgUuidCache = new Map<string, string>()

export function cacheOrgUuid(accountId: string, orgUuid: string): void {
  if (orgUuid) orgUuidCache.set(accountId, orgUuid)
}

function buildBaseEventData(ctx: EmitContext): Record<string, any> {
  // Priority: DB column (persisted from /oauth/profile) > per-request ctx
  // override > in-memory cache (captured from response header earlier). The
  // cache is still useful as a last-resort fallback for legacy accounts whose
  // profile pull never ran.
  const orgUuid =
    ctx.account.organizationUuid ||
    ctx.orgUuid ||
    orgUuidCache.get(ctx.account.id) ||
    ''
  const accountUuid =
    ctx.account.canonicalIdentity?.account_uuid ||
    ctx.account.accountUuidCol ||
    ''
  return {
    event_name: '',
    client_timestamp: new Date().toISOString(),
    model: ctx.model,
    session_id: ctx.derivedSessionId,
    user_type: 'external',
    betas: ctx.clientBetas,
    env: ctx.clientEnv,
    entrypoint: 'cli',
    is_interactive: true,
    client_type: 'cli',
    process: ctx.clientProcess || Buffer.from(JSON.stringify({
      uptime: Math.random() * 3600,
      rss: 200_000_000 + Math.floor(Math.random() * 100_000_000),
      heapTotal: 100_000_000 + Math.floor(Math.random() * 50_000_000),
      heapUsed: 80_000_000 + Math.floor(Math.random() * 50_000_000),
      external: 3_000_000 + Math.floor(Math.random() * 2_000_000),
      arrayBuffers: 200_000 + Math.floor(Math.random() * 500_000),
      constrainedMemory: 0,
      cpuUsage: { user: Math.floor(Math.random() * 2_000_000), system: Math.floor(Math.random() * 200_000) },
    })).toString('base64'),
    additional_metadata: '',
    auth: {
      organization_uuid: orgUuid,
      account_uuid: accountUuid,
    },
    event_id: randomUUID(),
    device_id: ctx.account.canonicalIdentity?.device_id || '',
    email: ctx.account.canonicalIdentity?.email || '',
  }
}

/** Emit the set of events that accompany every /v1/messages request. */
export function emitApiQuery(ctx: EmitContext, extra: {
  messagesLength: number
  temperature?: number
  thinkingType?: string
  querySource?: string
  /** First system-prompt block AFTER rewrite (normally the billing header
   * block). Used to compute tengu_sysprompt_block.hash deterministically. */
  firstSystemBlockText?: string
  /** Post-rewrite body — used to compute cache_breakpoints.cachingEnabled
   * and the [1m]/context-1m opus-4-7 signal. */
  body?: any
  hasStructuredOutput?: boolean
  hasToolSearch?: boolean
  isAgenticQuery?: boolean
}): void {
  const hints: BetaHints = {
    model: ctx.model,
    hasStructuredOutput: extra.hasStructuredOutput,
    hasToolSearch: extra.hasToolSearch,
    hasCacheControl: extra.body ? bodyHasCacheControl(extra.body) : false,
    isAgenticQuery: extra.isAgenticQuery,
  }
  const eventBetas = getEventBetas(hints).join(',')
  const headerBetas = getHeaderBetas(hints).join(',')

  // event_data.model — stamp [1m] when opus is using 1M context so the
  // telemetry matches real CC, which carries the marker in the logged model
  // string even though the API body strips it.
  const isOpus = /opus/i.test(ctx.model)
  const wantsOneMMarker = isOpus && !/\[1m\]/i.test(ctx.model) && (hints.hasCacheControl || /opus-4-[0-6]\b/i.test(ctx.model))
  const loggedModel = wantsOneMMarker ? `${ctx.model}[1m]` : ctx.model

  const emit = (name: string, am: Record<string, any>, betasOverride?: string) => {
    const base = buildBaseEventData(ctx)
    base.event_name = name
    base.model = loggedModel
    base.betas = betasOverride ?? eventBetas
    base.additional_metadata = Buffer.from(JSON.stringify(am)).toString('base64')
    enqueue(ctx.account.id, ctx.derivedSessionId, ctx.oauthToken, ctx.account.outboundProxyId, ctx.clientVersion, {
      event_type: 'ClaudeCodeInternalEvent',
      event_data: base,
    }, ctx.requestLink)
  }

  // Companion telemetry — top-level betas is the EVENT set (base only), per
  // HAR 2026-04-19 cross-validation.
  emit('tengu_api_before_normalize', {
    preNormalizedMessageCount: extra.messagesLength,
  })

  emit('tengu_api_after_normalize', {
    postNormalizedMessageCount: extra.messagesLength,
  })

  emit('tengu_tool_search_mode_decision', {
    enabled: false,
    mode: 'standard',
    reason: 'model_unsupported',
    checkedModel: loggedModel,
    mcpToolCount: 0,
    userType: 'external',
  })

  // M6: tengu_sysprompt_boundary_found / _missing_boundary_marker(HAR 验证 per
  // messages 必发其一)。真 CC 客户端按内部 SYSTEM_PROMPT_DYNAMIC_BOUNDARY marker
  // 决定;cc-gateway 看 system 块数推断:>=3 块视为 boundary_found(billing +
  // intro + ≥1 用户块),否则 missing。
  const sysBlocks = (extra.body && Array.isArray(extra.body.system)) ? extra.body.system : []
  if (sysBlocks.length >= 3) {
    const blockLen = (idx: number) => {
      const b = sysBlocks[idx]
      return typeof b?.text === 'string' ? b.text.length : 0
    }
    // billing(0) + cc intro(1) → static;后面用户块(2..) → dynamic
    const staticLen = blockLen(0) + blockLen(1)
    const dynamicLen = sysBlocks.slice(2).reduce((sum: number, b: any) =>
      sum + (typeof b?.text === 'string' ? b.text.length : 0), 0)
    emit('tengu_sysprompt_boundary_found', {
      blockCount: sysBlocks.length,
      staticBlockLength: staticLen,
      dynamicBlockLength: dynamicLen,
    })
  } else {
    emit('tengu_sysprompt_missing_boundary_marker', {
      promptBlockCount: sysBlocks.length,
    })
  }

  // sysprompt_block — snippet/length/hash are deterministic over the first
  // system block text (the billing header block). Real CC uses
  // createHash('sha256').update(firstSystemPrompt).digest('hex').
  const firstText = extra.firstSystemBlockText ?? ''
  emit('tengu_sysprompt_block', {
    snippet: firstText.slice(0, 20),
    length: firstText.length,
    hash: firstText
      ? createHash('sha256').update(firstText).digest('hex')
      : '',
  })

  // tengu_api_cache_breakpoints — HAR shows exactly 2 emissions per
  // api_query (pre-log paramsFromContext + actual attempt paramsFromContext),
  // payload identical, second shifted by ~3ms. Top-level betas is the EVENT
  // set per HAR.
  const cacheBp = {
    totalMessageCount: extra.messagesLength,
    cachingEnabled: hints.hasCacheControl ?? false,
    skipCacheWrite: false,
  }
  emit('tengu_api_cache_breakpoints', cacheBp)
  setTimeout(() => {
    try { emit('tengu_api_cache_breakpoints', cacheBp) } catch { /* best-effort */ }
  }, 3)

  // The actual api_query event — top-level betas + additional_metadata.betas
  // both carry the HEADER set (base + runtime), per HAR.
  // M3: 完整 additional_metadata 字段集(rh / buildAgeMins / queryChainId /
  // queryDepth / effortValue / permissionMode),HAR 验证。
  const am: Record<string, any> = {
    rh: ctx.rh,
    model: loggedModel,
    messagesLength: extra.messagesLength,
    provider: 'firstParty',
    buildAgeMins: ctx.buildAgeMins,
    betas: headerBetas,
    permissionMode: ctx.permissionMode,
    queryChainId: ctx.queryChainId,
    queryDepth: ctx.queryDepth,
    fastMode: false,
  }
  if (extra.temperature !== undefined) am.temperature = extra.temperature
  if (extra.thinkingType) {
    am.thinkingType = extra.thinkingType
    am.effortValue = ctx.effortValue
  }
  if (extra.querySource) am.querySource = extra.querySource

  emit('tengu_api_query', am, headerBetas)
}

/** Emit tengu_api_success after receiving Anthropic response. */
export function emitApiSuccess(ctx: EmitContext, extra: {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  durationMs: number
  ttftMs?: number
  requestId?: string
  stopReason?: string
  costUSD?: number
  querySource?: string
  /** Forwarded from the paired emitApiQuery call so success betas match. */
  hasStructuredOutput?: boolean
  hasToolSearch?: boolean
  hasCacheControl?: boolean
  isAgenticQuery?: boolean
}): void {
  const hints: BetaHints = {
    model: ctx.model,
    hasStructuredOutput: extra.hasStructuredOutput,
    hasToolSearch: extra.hasToolSearch,
    hasCacheControl: extra.hasCacheControl,
    isAgenticQuery: extra.isAgenticQuery,
  }
  const headerBetas = getHeaderBetas(hints).join(',')

  const isOpus = /opus/i.test(ctx.model)
  const wantsOneMMarker = isOpus && !/\[1m\]/i.test(ctx.model) && (hints.hasCacheControl || /opus-4-[0-6]\b/i.test(ctx.model))
  const loggedModel = wantsOneMMarker ? `${ctx.model}[1m]` : ctx.model

  const base = buildBaseEventData(ctx)
  base.event_name = 'tengu_api_success'
  base.model = loggedModel
  base.betas = headerBetas

  const am: Record<string, any> = {
    model: loggedModel,
    betas: headerBetas,
    messageCount: 1,
    messageTokens: 0,
    inputTokens: extra.inputTokens,
    outputTokens: extra.outputTokens,
    cachedInputTokens: extra.cachedInputTokens,
    uncachedInputTokens: extra.inputTokens - extra.cachedInputTokens,
    durationMs: extra.durationMs,
    durationMsIncludingRetries: extra.durationMs,
    attempt: 1,
    ttftMs: extra.ttftMs ?? extra.durationMs,
    provider: 'firstParty',
    requestId: extra.requestId ?? '',
    stop_reason: extra.stopReason ?? 'end_turn',
    costUSD: extra.costUSD ?? 0,
    didFallBackToNonStreaming: false,
    isNonInteractiveSession: false,
    print: false,
    isTTY: true,
    permissionMode: ctx.permissionMode,
    globalCacheStrategy: 'system_prompt',
    textContentLength: 0,
    fastMode: false,
    rh: ctx.rh,
    queryChainId: ctx.queryChainId,
    queryDepth: ctx.queryDepth,
  }
  if (extra.querySource) am.querySource = extra.querySource

  base.additional_metadata = Buffer.from(JSON.stringify(am)).toString('base64')

  enqueue(ctx.account.id, ctx.derivedSessionId, ctx.oauthToken, ctx.account.outboundProxyId, ctx.clientVersion, {
    event_type: 'ClaudeCodeInternalEvent',
    event_data: base,
  }, ctx.requestLink)
}

/**
 * Emit the 5 tengu_* events a real Claude Code CLI sends during OAuth login.
 * Unlike emitApiQuery which is per-request, this fires once when a new OAuth
 * account is added via the admin UI.
 *
 * Events (in order):
 *   1. tengu_startup_v2        — process boot
 *   2. tengu_oauth_start        — user clicked "Login"
 *   3. tengu_oauth_auth_code_received (automatic:false)  — user pasted code
 *   4. tengu_oauth_success      — token exchange OK
 *   5. tengu_identity_fetched   — /oauth/profile OK
 *
 * All 5 share a single freshly-generated session_id so the batch looks
 * like one CLI process emitting its ceremony.
 */
export async function emitLoginCeremony(args: {
  accountId: string
  oauthToken: string
  proxyId: string | null
  deviceId: string
  accountUuid: string
  email: string
  orgUuid: string
  clientVersion: string
  platform: string        // 'darwin' | 'linux' | 'win32'
  arch: string            // 'arm64' | 'x64'
  nodeVersion: string     // 'v22.1.0'
  terminal: string        // 'iTerm.app'
}): Promise<void> {
  const sessionId = randomUUID()
  const nowIso = new Date().toISOString()

  const baseEnv = {
    platform: args.platform,
    platform_raw: args.platform,
    arch: args.arch,
    node_version: args.nodeVersion,
    terminal: args.terminal,
    version: args.clientVersion,
    version_base: args.clientVersion,
    is_claude_ai_auth: true,
    is_running_with_bun: false,
    deployment_environment: `unknown-${args.platform}`,
  }

  const base = (eventName: string, am: Record<string, any>) => ({
    event_type: 'ClaudeCodeInternalEvent',
    event_data: {
      event_name: eventName,
      client_timestamp: nowIso,
      model: '',
      session_id: sessionId,
      user_type: 'external',
      betas: '',
      env: baseEnv,
      entrypoint: 'cli',
      is_interactive: true,
      client_type: 'cli',
      process: Buffer.from(JSON.stringify({
        uptime: Math.random() * 30,
        rss: 180_000_000 + Math.floor(Math.random() * 60_000_000),
        heapTotal: 90_000_000 + Math.floor(Math.random() * 30_000_000),
        heapUsed: 70_000_000 + Math.floor(Math.random() * 30_000_000),
        external: 3_000_000 + Math.floor(Math.random() * 2_000_000),
        arrayBuffers: 200_000 + Math.floor(Math.random() * 500_000),
        constrainedMemory: 0,
        cpuUsage: { user: Math.floor(Math.random() * 2_000_000), system: Math.floor(Math.random() * 200_000) },
      })).toString('base64'),
      additional_metadata: Buffer.from(JSON.stringify(am)).toString('base64'),
      auth: {
        organization_uuid: args.orgUuid,
        account_uuid: args.accountUuid,
      },
      event_id: randomUUID(),
      device_id: args.deviceId,
      email: args.email,
    },
  })

  const events = [
    base('tengu_startup_v2', {
      trigger: 'boot',
      is_first_session: false,
      authType: 'oauth',
      autoUpdateEnabled: true,
    }),
    base('tengu_oauth_start', {
      useAuth: true,
      isClaudeAi: true,
      flow: 'manual',
    }),
    base('tengu_oauth_auth_code_received', {
      automatic: false,    // user pasted code manually
      flow: 'manual',
    }),
    base('tengu_oauth_success', {
      authType: 'oauth',
      isClaudeAi: true,
      flow: 'manual',
      subscription: 'max',
    }),
    base('tengu_identity_fetched', {
      hasAccountUuid: true,
      hasEmail: true,
      hasOrgUuid: !!args.orgUuid,
    }),
  ]

  // Queue via the existing per-(account, session) path, same as emitApiQuery.
  for (const ev of events) {
    enqueue(args.accountId, sessionId, args.oauthToken, args.proxyId, args.clientVersion, ev)
  }
  // Force an immediate flush — login ceremony must not wait for 10s batch window.
  const key = `${args.accountId}:${sessionId}`
  flushQueue(key)

  log('info', `Login ceremony emitted for account=${args.accountId} session=${sessionId}`)
}
