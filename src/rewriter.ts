import { createHash, randomBytes, randomUUID } from 'crypto'
import type { Config } from './config.js'
import { getConfig } from './config.js'
import { log } from './logger.js'
import type { EffectiveProfile } from './identity-rewrite.js'
import { buildCanonicalUserId, deriveFallbackIdentity, deriveSessionId } from './identity-rewrite.js'
import { normalizeMessagesForAPI } from './api-message-normalizer.js'
import xxhash from 'xxhash-wasm'
import { capBodyCacheControl, disguiseBody, getTemplateSourceUA, normalizeCacheControlTtlOrder, sourceVersionFromTemplateUA, validateCCRequest } from './cc-disguise.js'
import { canonicalizeRequestTools } from './non-cc-tool-canon.js'
import * as ccBetasModule from './cc-betas.js'
import type { RequestShape } from './request-shapes.js'

// ── CCH attestation (xxhash64, reverse-engineered from Bun's Attestation.zig) ──
// eslint-disable-next-line @typescript-eslint/no-loss-of-precision
const CCH_ATTESTATION_SEED = BigInt('0x6E52736AC806831E')
const CCH_PLACEHOLDER = 'cch=00000'
const CCH_MASK = BigInt('0xFFFFF')
let xxh64Fn: ((input: Uint8Array, seed: bigint) => bigint) | null = null

// Eagerly initialize xxhash wasm module
xxhash().then(h => {
  xxh64Fn = h.h64Raw
  log('info', 'xxhash-wasm initialized for CCH attestation')
}).catch(err => {
  log('error', `Failed to initialize xxhash-wasm: ${err}`)
})

// ── CCH hash algorithm (reverse-engineered from cli.js) ──
const CCH_SALT = '59cf53e54c78'
const CCH_POSITIONS = [4, 7, 20]

// Fallback for non-message requests where no user message exists
const FALLBACK_HASH = randomBytes(2).toString('hex').slice(0, 3)

/**
 * 真 CC 在 2.1.130 之前发 `accept-language: *` + `sec-fetch-mode: cors`,且
 * `cch=` 字段总是占位符 `00000`(不计算 attestation)。2.1.130+ 由 Stainless
 * SDK / fetch 实现升级删除上面两个 header,且启用 xxhash64 attestation。
 *
 * HAR 决定性证据:
 *   - claude-cli/2.1.112: 85/85 发 accept-language;cch 全 `00000`
 *   - claude-cli/2.1.132:  0/37 发 accept-language;cch 真值(20-bit hash)
 *
 * 临界点未知夹在两版本间,保守用 2.1.130。
 */
// 真 CC HTTP header wire-level 顺序(HAR 验证)。Node http.request 按
// Object.keys 顺序写 wire,所以构造对象时按这顺序加 key 即可。
// host/connection/accept-encoding/content-length 由 http 模块自动追加在末尾,
// 跟 HAR 集合 1 末段一致(set 阶段不必显式加)。
const HEADER_ORDER_NEW = [   // 2.1.130+ (HAR 2.1.132)
  'accept',
  'authorization',
  'content-type',
  'user-agent',
  'x-claude-code-session-id',
  'x-stainless-arch',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-retry-count',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-timeout',
  'anthropic-beta',
  'anthropic-dangerous-direct-browser-access',
  'anthropic-version',
  'x-app',
  'x-client-request-id',
]

const HEADER_ORDER_OLD = [   // < 2.1.130 (HAR 2.1.112)
  'accept',
  'x-stainless-retry-count',
  'x-stainless-timeout',
  'x-stainless-lang',
  'x-stainless-package-version',
  'x-stainless-os',
  'x-stainless-arch',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'anthropic-dangerous-direct-browser-access',
  'anthropic-version',
  'authorization',
  'x-app',
  'user-agent',
  'x-claude-code-session-id',
  'content-type',
  'anthropic-beta',
  'x-client-request-id',
  'accept-language',
  'sec-fetch-mode',
]

/** 按真 CC SDK 顺序重排 headers,wire-level fingerprint 对齐。 */
function orderedHeaders(
  headers: Record<string, string>,
  version: string,
): Record<string, string> {
  const order = isPre2130(version) ? HEADER_ORDER_OLD : HEADER_ORDER_NEW
  const result: Record<string, string> = {}
  for (const k of order) {
    if (headers[k] !== undefined) result[k] = headers[k]
  }
  // 兜底:不在 order 列表的 key(如 client 自带 / 后续 patch 加的)按字典序追加,
  // 防止漏 header(只是无法对齐位置,但内容不丢)。
  for (const [k, v] of Object.entries(headers)) {
    if (!(k in result)) result[k] = v
  }
  return result
}

function isPre2130(version: string): boolean {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return false
  const [maj, min, patch] = [+m[1]!, +m[2]!, +m[3]!]
  if (maj !== 2) return maj < 2
  if (min !== 1) return min < 1
  return patch < 130
}

function computeCCH(firstUserMessageText: string, version: string): string {
  const chars = CCH_POSITIONS.map(i => firstUserMessageText[i] || '0').join('')
  return createHash('sha256')
    .update(`${CCH_SALT}${chars}${version}`)
    .digest('hex')
    .slice(0, 3)
}

/**
 * Resolved identity used for rewriting.
 * Only identity fields matter now — env/platform/paths are passed through
 * from the client to maintain internal session consistency.
 */
type ResolvedIdentity = {
  // PG UUID of the bound oauth_accounts row. Used exclusively as the template
  // cache key so per-row bindings are independent (multiple rows may share the
  // same canonical account_uuid but carry different cc_template_id).
  oauth_account_id: string
  cc_template_id: string | null
  device_id: string
  email: string
  account_uuid: string
  env: {
    version: string          // canonical CC version (used in user-agent, billing header)
    node_version: string     // canonical Node version (x-stainless-runtime-version)
    entrypoint?: string
    platform?: string        // darwin/win32/linux — used to synthesize `# Environment`
    arch?: string
    terminal?: string
  }
  // Per-account persona fields used to synthesize `# Environment` system block.
  // Sourced from identity_profiles.prompt_env.
  promptEnv: {
    platform: string
    shell: string
    os_version: string
    home_prefix: string
  } | null
  // Fingerprint fields for normalizing version-tied headers across clients.
  // Platform/OS/arch are NOT overridden (passthrough for path consistency),
  // but version-tied fields MUST be uniform per device_id — a single machine
  // can't run three different CC versions simultaneously.
  fingerprint: {
    user_agent: string
    package_version: string   // x-stainless-package-version
  } | null
}

export type RewriteOptions = {
  profile: EffectiveProfile
  derivedSessionId: string   // stable session id written into metadata.user_id
  extraBetas?: string[]      // body-derived beta flags (e.g. context-management-2025-06-27); written by rewriteBody, read by rewriteHeaders
  inboundUserAgent?: string  // original client UA — used to validate real CC traffic when learning templates
  inboundClientIp?: string   // original client IP — captured into non-CC rejection error messages for audit
  requestShapeIn?: RequestShape | null
  disableTemplateDisguise?: boolean
  stripSignatureBlocks?: boolean
  // 由 account.options.validate.aggressiveDisguise 透传:Tier 2 主动伪装。
  // 开启后:(1) 客户端非 CC tools → template.tools 替换;
  //        (2) context_management 字段 → 用 CC 真实形态覆盖 (clear_thinking_20251015 + keep:'all')
  // 代价:客户端发的 tool_use 调用、自定义 compact 配置全部失效。
  aggressiveDisguise?: boolean
  // 由 account.options.clean.toolUseTrailing 透传:截断 assistant 中
  // 最后一个 tool_use 之后的 text/thinking/redacted_thinking 块。
  // 修复客户端 SDK 重组 streaming 产生的 [text, tool_use, text 重复] 畸形,
  // 该结构会被 Anthropic 上游误判为 tool_use 没匹配 tool_result。
  dropTrailingAfterToolUse?: boolean
  // 由 account.options.clean.capCacheControl 透传:body 末尾兜底,
  // 总 cache_control 块超 4 时按 messages → tools → system 倒序 strip。
  // 是 disguiseBody 之后 / ApiKey 直连路径的最终保险。
  capCacheControl?: boolean
  // 由 account.options.clean.canonicalizeNonCCTools 透传:把 snake_case 工具集
  // (opencode/crush 等) 改写为 CC 风格,过 validateCCRequest baseline。改写后
  // 把 upstream→client 的反向 map 通过这个 sink 写出去 — proxy 层用它给
  // 响应 SSE 上 transform,把 tool_use.name + input keys 还原为客户端约定的格式。
  canonicalizeNonCCTools?: boolean
  /**
   * 出参:reverseMap upstream_name → client_name。
   *  - undefined 表示 canonicalizeNonCCTools=false 或本次没改 (tools 本来就是 CC 风格)
   *  - 非空 Map 表示响应必须挂 SSE transform
   */
  toolNameReverseSink?: { value: Map<string, string> | null }
  /**
   * 外部第三方 client (clients.external_client=true)。gateway 自动:
   * (1) 重写 inbound UA 为 claude-cli/2.1.132 (external, cli)
   * (2) prepend "You are Claude Code..." system 块
   * (3) 跳过 validateCCRequest 严格校验
   * 其他流程不变(disguiseBody / cc-disguise 模板照常应用)。
   */
  externalClient?: boolean
}

/**
 * Per-account version lock — first client to connect defines the version
 * for all subsequent clients on the same account.
 *
 * Uses in-memory cache backed by Redis so locks survive pm2 restarts.
 * Redis keys expire after 24h so CC updates eventually propagate.
 */
const versionCache = new Map<string, string>()
let redisModule: any = null

async function getRedisForLock() {
  if (!redisModule) {
    try { redisModule = await import('./redis.js') } catch { return null }
  }
  return redisModule.isRedisAvailable() ? redisModule.getRedis() : null
}

function lockVersionFromFirstClient(accountId: string, field: string, incomingValue: string): string {
  const key = `vlock:${accountId}:${field}`
  const cached = versionCache.get(key)
  if (cached) return cached

  // First client in this process — lock it
  versionCache.set(key, incomingValue)
  // Persist to Redis async (fire-and-forget)
  getRedisForLock().then(redis => {
    if (redis) redis.set(key, incomingValue, 'EX', 86400).catch(() => {})
  }).catch(() => {})
  return incomingValue
}

// On startup, try to hydrate cache from Redis for known keys
export async function hydrateVersionLocks(accountUuids: string[]): Promise<void> {
  const redis = await getRedisForLock()
  if (!redis) return
  for (const uuid of accountUuids) {
    for (const field of ['ua', 'node', 'pkg', 'os', 'arch']) {
      const key = `vlock:${uuid}:${field}`
      const val = await redis.get(key)
      if (val) versionCache.set(key, val)
    }
  }
}

/** Get the locked CC version for an account (for billing header and event emitter). */
export function getLockedVersion(accountId: string, fallback: string): string {
  const key = `vlock:${accountId}:ua`
  const cached = versionCache.get(key)
  if (cached) {
    const match = cached.match(/claude-(?:cli|code)\/([^\s(]+)/)
    return match?.[1] ?? fallback
  }
  return fallback
}

/**
 * Stable session-id fallback for the (rare) cases where applyRewrite couldn't
 * derive a per-stickyKey session — e.g. transient null on the slot table or
 * an upstream invariant break. Used by both `rewriteMessagesBody` (metadata
 * .user_id.session_id) and `buildCCHeaders` (x-claude-code-session-id) so the
 * outbound body and outbound header always carry the SAME id.
 *
 * Bucket-by-hour: keeps the value stable within a request (header/body match)
 * AND across short retries on the same account, while still rotating slowly
 * enough to avoid a "single forever-static session" fingerprint.
 *
 * Real CC NEVER sends a request without x-claude-code-session-id (verified
 * across 9 HAR captures, 224/224 OAuth /v1/messages requests carry it),
 * so omitting the header is itself a fingerprint anomaly that triggers
 * Anthropic risk scoring — see the rapidfrost816 ban analysis.
 */
export function deriveFallbackSessionId(accountUuid: string): string {
  const bucket = Math.floor(Date.now() / 3_600_000)
  return deriveSessionId(accountUuid || '_default', `gw-fallback:${bucket}`)
}

// Minimal placeholder used when the caller has no profile at all.
// In practice the proxy always supplies one (pool account or DB default profile);
// this only kicks in for startup-time rewrite calls before the DB is ready.
const PLACEHOLDER_VIEW: ResolvedIdentity = {
  oauth_account_id: '',
  cc_template_id: null,
  device_id: '0'.repeat(64),
  email: '',
  account_uuid: '',
  env: { version: '2.1.90', node_version: 'v22.1.0' },
  promptEnv: null,
  fingerprint: null,
}

function resolveFromProfile(profile: EffectiveProfile): ResolvedIdentity {
  return {
    oauth_account_id: profile.oauth_account_id,
    cc_template_id: profile.cc_template_id,
    device_id: profile.identity.device_id,
    email: profile.identity.email,
    account_uuid: profile.identity.account_uuid,
    env: {
      version: profile.env.version,
      node_version: profile.env.node_version,
      entrypoint: (profile.env as any).entrypoint,
      platform: profile.env.platform,
      arch: profile.env.arch,
      terminal: profile.env.terminal,
    },
    promptEnv: profile.promptEnv,
    fingerprint: profile.fingerprint ? {
      user_agent: profile.fingerprint.user_agent,
      package_version: profile.fingerprint.x_stainless_package_version,
    } : null,
  }
}

function resolve(opts?: RewriteOptions): ResolvedIdentity {
  if (opts?.profile) return resolveFromProfile(opts.profile)
  return PLACEHOLDER_VIEW
}

/**
 * Extract first user message text from API request messages array.
 * API format uses role: "user", content can be string or array of blocks.
 */
function extractFirstUserMessage(messages: any[]): string {
  if (!Array.isArray(messages)) return ''
  const firstUser = messages.find((m: any) => m.role === 'user')
  if (!firstUser) return ''
  if (typeof firstUser.content === 'string') return firstUser.content
  if (Array.isArray(firstUser.content)) {
    const textBlock = firstUser.content.find((b: any) => b.type === 'text')
    if (textBlock?.text) return textBlock.text
  }
  return ''
}

/**
 * Rewrite identity fields in the API request body.
 *
 * Handles two request types:
 * 1. /v1/messages - rewrite metadata.user_id JSON blob
 * 2. /api/event_logging/batch - rewrite event_data identity/env/process fields
 */
export async function rewriteBody(
  body: Buffer,
  path: string,
  config: Config,
  opts?: RewriteOptions,
): Promise<Buffer> {
  const text = body.toString('utf-8')

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Not JSON - pass through unchanged
    return body
  }

  const view = resolve(opts)

  if (path.startsWith('/v1/messages') && !path.includes('/count_tokens')) {
    await rewriteMessagesBody(
      parsed,
      config,
      view,
      opts?.derivedSessionId,
      opts?.stripSignatureBlocks,
      opts?.inboundUserAgent,
      opts?.inboundClientIp,
      opts?.requestShapeIn,
      opts?.disableTemplateDisguise,
      opts?.aggressiveDisguise ?? false,
      opts?.dropTrailingAfterToolUse ?? false,
      opts?.capCacheControl ?? false,
      opts?.canonicalizeNonCCTools ?? false,
      opts?.toolNameReverseSink,
      opts?.externalClient ?? false,
    )
  } else if (path.includes('/event_logging/') && path.includes('/batch')) {
    rewriteEventBatch(parsed, config, view, opts?.derivedSessionId)
  } else if (path.includes('/policy_limits') || path.includes('/settings')) {
    rewriteGenericIdentity(parsed, view)
  }

  let buf = Buffer.from(JSON.stringify(parsed), 'utf-8')

  // Post-serialization: compute xxhash64 attestation and replace cch=00000.
  // 真 CC 2.1.130 之前不计算 cch(总是占位符 00000),之后才启用 attestation。
  // 锁版本 < 2.1.130 时跳过,保留占位符匹配 baseline。
  const lockedVersion = getLockedVersion(view.account_uuid || '_default', String(view.env.version))
  if (
    path.startsWith('/v1/messages')
    && !path.includes('/count_tokens')
    && !isPre2130(lockedVersion)
  ) {
    buf = injectCCHAttestation(buf)
  }

  return buf
}

/**
 * Compute xxhash64 attestation over the serialized request body and replace
 * the `cch=00000` placeholder with the computed 5-char hex hash.
 *
 * Algorithm (reverse-engineered from Bun's Attestation.zig):
 *   1. body contains "cch=00000" placeholder
 *   2. hash = xxhash64(body, seed=0x6E52736AC806831E)
 *   3. cch = (hash & 0xFFFFF) formatted as 05x
 *   4. replace "00000" in-place
 */
function injectCCHAttestation(body: Buffer<ArrayBuffer>): Buffer<ArrayBuffer> {
  if (!xxh64Fn) {
    log('warn', 'xxhash-wasm not ready, skipping CCH attestation')
    return body
  }

  const placeholderIdx = body.indexOf(CCH_PLACEHOLDER)
  if (placeholderIdx === -1) {
    return body
  }

  const hash = xxh64Fn(new Uint8Array(body.buffer, body.byteOffset, body.byteLength), CCH_ATTESTATION_SEED)
  const cch = (hash & CCH_MASK).toString(16).padStart(5, '0')

  // Replace "00000" portion (5 bytes starting after "cch=")
  const zeroStart = placeholderIdx + 4  // skip "cch="
  body.write(cch, zeroStart, 5, 'ascii')

  log('debug', `CCH attestation: ${cch}`)
  return body
}

/**
 * Rewrite /v1/messages request body.
 *
 * Order matters:
 * 1. Rewrite user message content (paths, etc.) FIRST
 * 2. Extract first user message from REWRITTEN content
 * 3. Compute hash from rewritten message (so it matches what server sees)
 * 4. Rewrite system prompt billing header using computed hash
 */
async function rewriteMessagesBody(
  body: any,
  config: Config,
  view: ResolvedIdentity,
  derivedSessionId: string | undefined,
  stripSignatureBlocks: boolean | undefined,
  inboundUserAgent: string | undefined,
  inboundClientIp: string | undefined,
  requestShapeIn: RequestShape | null | undefined,
  disableTemplateDisguise: boolean | undefined,
  aggressiveDisguise: boolean = false,
  dropTrailingAfterToolUse: boolean = false,
  capCacheControl: boolean = false,
  canonicalizeNonCCTools: boolean = false,
  toolNameReverseSink: { value: Map<string, string> | null } | undefined = undefined,
  externalClient: boolean = false,
): Promise<void> {
  const inboundUserId = body?.metadata?.user_id

  // Fully rebuild metadata.user_id as a canonical JSON blob.
  // This replaces whatever the inbound client (Claude Code, NewAPI, wrapper, etc.)
  // sent — so every request on this account shows the same device_id/account_uuid
  // to Anthropic, with only session_id rotating per end-user session.
  if (view.account_uuid) {
    const identity = {
      device_id: view.device_id,
      email: view.email,
      account_uuid: view.account_uuid,
    }
    // If derivedSessionId is missing, use a per-account-per-hour stable fallback
    // (NOT the bare `deriveFallbackIdentity('unknown').account_uuid` that this
    // file used to emit — that produced a single hard-coded UUID across all
    // accounts, which is a fingerprint giveaway). The same fallback is used by
    // buildCCHeaders so the outbound header and metadata always agree.
    const effectiveSessionId = derivedSessionId || deriveFallbackSessionId(view.account_uuid)
    body.metadata = {
      user_id: buildCanonicalUserId(identity, effectiveSessionId),
    }
  } else if (typeof inboundUserId === 'string' && inboundUserId.startsWith('{')) {
    // Legacy single-token path: only the device_id field gets patched.
    try {
      const userId = JSON.parse(inboundUserId)
      userId.device_id = view.device_id
      body.metadata = { user_id: JSON.stringify(userId) }
    } catch {
      body.metadata = { user_id: inboundUserId }
    }
  } else if (typeof inboundUserId === 'string') {
    body.metadata = { user_id: inboundUserId }
  } else {
    delete body.metadata
  }

  if (Array.isArray(body.messages)) {
    body.messages = normalizeMessagesForAPI(
      body.messages,
      Array.isArray(body.tools) ? body.tools : [],
      {
        stripSignatures: stripSignatureBlocks === true,
        dropTrailingAfterToolUse,
      },
    )
  }

  // Step 2: Extract first user message text for CCH fingerprint computation
  const firstUserText = extractFirstUserMessage(body.messages)

  // Step 3: Compute hash from locked version + message content.
  // All sessions on the same device_id must use the same version —
  // locked from the first client that connected to this account.
  // vlock is keyed by canonical account_uuid (shared across oauth_accounts rows
  // that point to the same upstream account); template cache is keyed by
  // gateway-side oauth_accounts.id (per-row binding).
  const vlockKey = view.account_uuid || '_default'
  const templateKey = view.oauth_account_id
  const sourceUA = templateKey && view.cc_template_id
    ? await getTemplateSourceUA(templateKey, view.cc_template_id)
    : ''
  const version = sourceVersionFromTemplateUA(sourceUA) || getLockedVersion(vlockKey, String(view.env.version))
  const hash = firstUserText ? computeCCH(firstUserText, version) : FALLBACK_HASH
  log('debug', `Computed CCH: ${hash} (version=${version}, msg=${firstUserText.length} chars)`)

  // Step 4: Rewrite billing header block with client version + cch placeholder.
  const entrypoint = view.env.entrypoint ?? 'cli'
  const billingHeader = `x-anthropic-billing-header: cc_version=${version}.${hash}; cc_entrypoint=${entrypoint}; cch=00000;`

  if (Array.isArray(body.system)) {
    let replaced = false
    for (let i = 0; i < body.system.length; i++) {
      const item = body.system[i]
      const text = typeof item === 'string' ? item : item?.text
      if (typeof text === 'string' && /^\s*x-anthropic-billing-header:/.test(text)) {
        // Replace existing billing block with canonical version
        if (typeof item === 'string') {
          body.system[i] = billingHeader
        } else {
          item.text = billingHeader
        }
        replaced = true
        log('debug', `Rewrote billing header block: ${billingHeader}`)
      }
      // Other system blocks are NOT rewritten — env/paths stay as client sent them.
    }
    // If no billing block existed (client set ATTRIBUTION_HEADER=false), prepend one
    if (!replaced) {
      body.system.unshift({ type: 'text', text: billingHeader })
      log('debug', `Injected billing header block: ${billingHeader}`)
    }
  } else if (typeof body.system === 'string') {
    // Strip any existing billing header, prepend the new one
    body.system = body.system.replace(/x-anthropic-billing-header:[^\n]+\n?/g, '')
    body.system = billingHeader + '\n' + body.system
  } else {
    body.system = [{ type: 'text', text: billingHeader }]
  }

  // 非 CC 工具集规整 — 必须在 validateCCRequest 之前。把客户端的 snake_case
  // tools (`read`/`exec`/`sessions_*`) 改写成 CC 风格,模型按 PascalCase schema
  // 生成 tool_use;reverseMap 通过 sink 透回 proxy,响应阶段 SSE transform 还原。
  // tools 本就是 CC 风格 (Read/Edit/...) 时 canonicalize 是 no-op (changed=false)。
  if (canonicalizeNonCCTools && Array.isArray(body.tools)) {
    const { tools: canonTools, reverseMap, changed } = canonicalizeRequestTools(body.tools)
    if (changed) {
      body.tools = canonTools
      if (toolNameReverseSink) toolNameReverseSink.value = reverseMap
      log('debug', `canonicalize-non-cc-tools: rewrote ${reverseMap.size} tool name(s) [${[...reverseMap.entries()].map(([u, c]) => `${c}→${u}`).slice(0, 8).join(', ')}${reverseMap.size > 8 ? ', ...' : ''}]`)
    }
  }

  // 外部客户端伪装(client.external_client=true 时):
  //   - 重写 inboundUserAgent 给后续 validateCCRequest 看到 CC 风格 UA
  //   - 在 system 块最前 prepend "You are Claude Code..."(若客户端没带)
  // 不动 tools(mcp__server__tool 是 CC 标准 MCP 格式,Anthropic 自己也用)。
  if (externalClient) {
    inboundUserAgent = 'claude-cli/2.1.132 (external, cli)'
    const ccSystemBlock = {
      type: 'text',
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    }
    if (body && typeof body === 'object') {
      const existing = body.system
      if (existing === undefined || existing === null) {
        body.system = [ccSystemBlock]
      } else if (typeof existing === 'string') {
        body.system = [ccSystemBlock, { type: 'text', text: existing }]
      } else if (Array.isArray(existing)) {
        // Only prepend if not already present (avoid duplicating on retry)
        const hasCcTag = existing.some((b: any) =>
          b && typeof b === 'object' && typeof b.text === 'string'
            && b.text.startsWith("You are Claude Code"))
        if (!hasCcTag) body.system = [ccSystemBlock, ...existing]
      }
    }
  }

  if (templateKey && !disableTemplateDisguise) {
    // permissive 跟 aggressiveDisguise 同步:账号开 aggressiveDisguise 表明运营接受
    // 非 CC 客户端流量过 gateway(后续 disguiseBody 会替换 tools/system),所以这里
    // 第二道 gate 也对齐放宽,接受 PENDING profile (toolless_thinking_disabled_like 等)。
    // externalClient 视同 aggressiveDisguise(permissive),跳过 NonCCRequest 严格校验。
    const permissive = aggressiveDisguise || externalClient
    validateCCRequest(body.tools, templateKey, inboundUserAgent ?? '', inboundClientIp ?? null, requestShapeIn ?? null, permissive)
  }

  if (templateKey && !disableTemplateDisguise) {
    await disguiseBody(body, templateKey, view.cc_template_id, {
      env: {
        platform: view.env.platform ?? 'darwin',
        arch: view.env.arch ?? 'arm64',
        node_version: view.env.node_version,
        terminal: view.env.terminal ?? 'iTerm.app',
        version: view.env.version,
      },
      promptEnv: view.promptEnv,
    }, aggressiveDisguise)
  }

  // 最终兜底:body 总 cache_control 超 4 时按尾部优先 strip。
  // OAuth 路径 disguiseBody 内已有 template-budget 修剪,这里是二次保险;
  // ApiKey 直连路径(disableTemplateDisguise=true)依赖这里挡 400。
  if (capCacheControl) {
    capBodyCacheControl(body)
  }

  // ttl 顺序兜底:Anthropic 要求 1h cache_control 必须排在 5m 之前(按 tools→system→messages
  // 顺序)。template systemBlocks 自带 [1h, 5m] + 客户端 messages 末尾再带 1h 时违规
  // → 把 5m 升级为 1h。无视开关:不修就是 400,且零副作用(cache 多活 55 分钟)。
  normalizeCacheControlTtlOrder(body)
}
// rewritePromptText and rewriteSystemReminders have been removed.
// Platform/Shell/OS/paths are no longer rewritten — each session keeps
// the client's real env for consistency with file paths in messages.
// Billing header is rebuilt entirely in rewriteMessagesBody Step 4.

/**
 * Rewrite /api/event_logging/batch payload.
 * Each event has event_data with identity, env, and process fields.
 */
function rewriteEventBatch(body: any, _config: Config, view: ResolvedIdentity, derivedSessionId?: string) {
  if (!Array.isArray(body?.events)) return

  for (const event of body.events) {
    if (!event?.event_data) continue
    const data = event.event_data

    // Identity fields — must match what /v1/messages sends
    if (data.device_id) data.device_id = view.device_id
    if (data.email) data.email = view.email

    // Session id — must match the derived session_id used in metadata.user_id
    if (data.session_id && derivedSessionId) {
      data.session_id = derivedSessionId
    }

    // Auth block — account_uuid and organization_uuid must match the OAuth account
    if (data.auth) {
      if (view.account_uuid) {
        data.auth.account_uuid = view.account_uuid
      }
      // organization_uuid is tied to the OAuth account, not the client
      // Keep it if present; the account's org is correct for the token being used
    }

    // Environment and process metrics are NOT rewritten — they must match
    // the client's real platform/env that appears in system prompt and headers.
    // Replacing env with canonical values would create darwin+/home/ mismatches.

    // Strip fields that leak gateway URL, proxy usage, or bare mode
    delete data.baseUrl
    delete data.base_url
    delete data.gateway
    delete data.is_simple

    // Additional metadata - rewrite base64-encoded blob if present
    if (data.additional_metadata) {
      data.additional_metadata = rewriteAdditionalMetadata(data.additional_metadata)
    }

    log('debug', `Rewrote event: ${data.event_name || 'unknown'}`)
  }
}

function rewriteGenericIdentity(body: any, view: ResolvedIdentity) {
  if (typeof body !== 'object' || body === null) return
  if (body.device_id) body.device_id = view.device_id
  if (body.email) body.email = view.email
}

function rewriteAdditionalMetadata(original: string): string {
  try {
    const decoded = JSON.parse(Buffer.from(original, 'base64').toString('utf-8'))
    // Strip gateway/proxy indicators
    delete decoded.baseUrl
    delete decoded.base_url
    delete decoded.gateway
    // Strip fields that leak client identity or mismatch with the OAuth account
    delete decoded.last_session_id     // previous session from a different client
    delete decoded.apiKeySource        // reveals proxy usage (value "none" when no direct login)
    delete decoded.storageBackend      // client credential storage method
    return Buffer.from(JSON.stringify(decoded)).toString('base64')
  } catch {
    return original
  }
}

/**
 * Rewrite HTTP headers to canonical identity.
 * When `opts.profile` is provided, stainless host-fingerprint headers and the
 * x-claude-code-session-id header are overridden per-account.
 *
 * Path-aware: event_logging uses a minimal header set (axios-style),
 * while /v1/messages uses full stainless SDK headers.
 */
export async function rewriteHeaders(
  headers: Record<string, string | string[] | undefined>,
  config: Config,
  opts?: RewriteOptions,
  path?: string,
  outBody?: Buffer,
): Promise<Record<string, string>> {
  // Event logging uses a completely different header profile (axios, not SDK)
  if (path && path.includes('/event_logging/') && path.includes('/batch')) {
    return rewriteEventLoggingHeaders(headers, config, opts)
  }

  const view = resolve(opts)

  // Step 1: scan inbound headers for lock updates (side effect only).
  // Only real CC-shaped UA/stainless headers update the version lock.
  extractLocksFromInbound(headers, view)

  // Step 2: parse body hints for beta flag generation.
  const hints = outBody ? parseBodyHints(outBody) : {}

  // Step 3: construct outbound headers from lock cache + static CC template.
  // Inbound header VALUES are never read here — eliminates cf-*/cdn-loop/x-forwarded-*
  // and any other proxy/CDN pollution leaking to Anthropic.
  return buildCCHeaders(view, opts, hints)
}

/**
 * Side effect only: if inbound has CC-shaped headers, update the version lock.
 * Non-CC clients (axios, Go-http-client, NewAPI) don't trigger lock updates.
 */
function extractLocksFromInbound(
  headers: Record<string, string | string[] | undefined>,
  view: ResolvedIdentity,
): void {
  const vlockKey = view.account_uuid || '_default'

  const ua = pickHeader(headers, 'user-agent')
  if (ua && /^claude-(?:cli|code)\//.test(ua)) {
    lockVersionFromFirstClient(vlockKey, 'ua', ua)
  }

  const os = pickHeader(headers, 'x-stainless-os')
  if (os) lockVersionFromFirstClient(vlockKey, 'os', os)

  const arch = pickHeader(headers, 'x-stainless-arch')
  if (arch) lockVersionFromFirstClient(vlockKey, 'arch', arch)

  const node = pickHeader(headers, 'x-stainless-runtime-version')
  if (node) lockVersionFromFirstClient(vlockKey, 'node', node)

  const pkg = pickHeader(headers, 'x-stainless-package-version')
  if (pkg) lockVersionFromFirstClient(vlockKey, 'pkg', pkg)
}

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== name) continue
    if (!v) return null
    return Array.isArray(v) ? v.join(', ') : v
  }
  return null
}

type BodyHints = {
  model?: string
  hasStructuredOutput?: boolean
  hasCacheControl?: boolean
  hasToolSearch?: boolean
  isAgenticQuery?: boolean
}

function parseBodyHints(body: Buffer): BodyHints {
  try {
    const parsed = JSON.parse(body.toString('utf-8'))
    const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0
    const hasToolSearch = hasTools && parsed.tools.some((t: any) =>
      t && (t.type === 'tool_search_20251015' || t.name === 'tool_search' || (typeof t.type === 'string' && t.type.startsWith('tool_search_')))
    )
    // Walk messages/system/tools for cache_control markers.
    const scan = (blocks: any): boolean => {
      if (!Array.isArray(blocks)) return false
      for (const b of blocks) {
        if (b && typeof b === 'object' && (b as any).cache_control) return true
      }
      return false
    }
    let hasCacheControl = false
    if (Array.isArray(parsed.messages)) {
      for (const m of parsed.messages) {
        if (!m || typeof m !== 'object') continue
        if ((m as any).cache_control) { hasCacheControl = true; break }
        if (scan((m as any).content)) { hasCacheControl = true; break }
      }
    }
    if (!hasCacheControl) hasCacheControl = scan(parsed.system) || scan(parsed.tools)

    return {
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      hasStructuredOutput: parsed.output_config?.format?.type === 'json_schema',
      hasCacheControl,
      hasToolSearch,
      // Shared with event-emitter via cc-betas.inferIsAgenticQuery so the
      // outbound HTTP `anthropic-beta` header and the synthetic event_data
      // .betas stay byte-aligned for Haiku-as-main-thread requests.
      isAgenticQuery: ccBetasModule.inferIsAgenticQuery(parsed),
    }
  } catch {
    return {}
  }
}

/**
 * Build the outbound CC-standard anthropic-beta header value.
 *
 * Delegates to cc-betas.getHeaderBetas. The event_data.betas counterpart is
 * computed separately in event-emitter and must NOT match this value for
 * events whose top-level envelope carries only the base set (see
 * cc-betas.ts module header for the per-event rule).
 */
function buildAnthropicBeta(hints: BodyHints): string {
  const { getHeaderBetas } = ccBetasModule
  return getHeaderBetas({
    model: hints.model ?? '',
    hasStructuredOutput: hints.hasStructuredOutput,
    hasCacheControl: hints.hasCacheControl,
    hasToolSearch: hints.hasToolSearch,
    isAgenticQuery: hints.isAgenticQuery,
  }).join(',')
}

/**
 * Construct the outbound CC-standard header set from scratch.
 *
 * Never reads inbound header values. Values come from:
 *   - Version lock cache (UA/OS/arch/node/pkg) — updated elsewhere from real CC clients
 *   - Static CC template (CC always sends the same HTTP-standard headers)
 *   - RewriteOptions (derivedSessionId)
 *   - Body hints (model → beta flags)
 *   - Random UUID per request (x-client-request-id)
 */
async function buildCCHeaders(
  view: ResolvedIdentity,
  opts: RewriteOptions | undefined,
  hints: BodyHints,
): Promise<Record<string, string>> {
  const vlockKey = view.account_uuid || '_default'
  const templateUA = view.oauth_account_id && view.cc_template_id
    ? await getTemplateSourceUA(view.oauth_account_id, view.cc_template_id)
    : ''
  const version = sourceVersionFromTemplateUA(templateUA) || getLockedVersion(view.account_uuid || '_default', String(view.env.version))
  const ua = templateUA || `claude-cli/${version} (external, cli)`
  const os = versionCache.get(`vlock:${vlockKey}:os`) ?? 'MacOS'
  const arch = versionCache.get(`vlock:${vlockKey}:arch`) ?? 'arm64'
  const node = versionCache.get(`vlock:${vlockKey}:node`) ?? 'v22.1.0'
  const pkg = versionCache.get(`vlock:${vlockKey}:pkg`) ?? version

  const out: Record<string, string> = {
    accept: 'application/json',
    'accept-encoding': 'br, gzip, deflate',
    'anthropic-beta': buildAnthropicBeta(hints),
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    'user-agent': ua,
    'x-app': 'cli',
    'x-client-request-id': randomUUID(),
    'x-stainless-arch': arch,
    'x-stainless-lang': 'js',
    'x-stainless-os': os,
    'x-stainless-package-version': pkg,
    'x-stainless-retry-count': '0',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': node,
    'x-stainless-timeout': '600',
  }

  // Real CC ALWAYS sends x-claude-code-session-id on every /v1/messages,
  // including Haiku side-queries (HAR-verified 224/224 across 9 captures).
  // Omitting it is itself a fingerprint anomaly that triggers Anthropic risk
  // scoring — see rapidfrost816 ban-trigger trace ccg-moie3yua-87c035f3f0ef.
  // Use the same per-account-per-hour fallback as rewriteMessagesBody so the
  // header and metadata.user_id.session_id always agree.
  out['x-claude-code-session-id'] = opts?.derivedSessionId
    || deriveFallbackSessionId(view.account_uuid)

  // accept-language + sec-fetch-mode 仅在 2.1.130 前的 CC 客户端发(HAR 验证)。
  // 锁版本 ≥ 2.1.130 时不发,匹配新 Stainless SDK / fetch 实现 baseline。
  if (isPre2130(version)) {
    out['accept-language'] = '*'
    out['sec-fetch-mode'] = 'cors'
  }

  // wire-level header 顺序按 CC 锁版本对齐(M2:HAR 验证 2.1.112 vs 2.1.132 顺序
  // 完全不同,Node http 按 Object.keys 顺序写 wire)。
  return orderedHeaders(out, version)
}

/**
 * Build headers for /api/event_logging/v2/batch requests.
 * Real Claude Code uses axios (not the Anthropic SDK) for event logging,
 * so the header profile is completely different: no stainless headers,
 * no session-id, no anthropic-version, different user-agent and accept.
 */
async function rewriteEventLoggingHeaders(
  headers: Record<string, string | string[] | undefined>,
  config: Config,
  opts?: RewriteOptions,
): Promise<Record<string, string>> {
  const view = resolve(opts)
  const sourceUA = view.oauth_account_id && view.cc_template_id
    ? await getTemplateSourceUA(view.oauth_account_id, view.cc_template_id)
    : ''
  const version = sourceVersionFromTemplateUA(sourceUA) || getLockedVersion(view.account_uuid || '_default', view.env.version)
  return {
    'accept': 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'user-agent': `claude-code/${version}`,
    'x-service-name': 'claude-code',
    'anthropic-beta': 'oauth-2025-04-20',
    'accept-encoding': 'gzip, compress, deflate, br',
    'connection': 'close',
  }
}
