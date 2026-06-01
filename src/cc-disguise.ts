import { createHash } from 'crypto'
import { log } from './logger.js'
import { query, DEPLOYMENT } from './db.js'
import { getRedis, isRedisAvailable } from './redis.js'
import type { IdentityProfileEnv, IdentityProfilePromptEnv } from './account-pool.js'
import { allowsEmptyTools, type RequestShape } from './request-shapes.js'

// ── Types ──

export type CCTemplateCache = {
  templateId: string     // template is mandatory — no in-memory-only state
  tools: any[]
  systemBlocks: any[]
  sourceUA: string
  loadedAt: number
}

// ── State ──

const testTemplateByAccount = new Map<string, CCTemplateCache>()
const testTemplateById = new Map<string, CCTemplateCache>()

// ── CC core tool classifier (used by validateCCRequest) ──

// Stable CC core tool names across versions. Real CC traffic always carries
// at least this many. Used to reject non-CC clients (e.g. OpenClaw with
// lowercase `read`/`edit` or wiki_*/fw_* tools).
const CC_CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Task', 'Agent', 'Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep',
])
const CC_CORE_MATCH_THRESHOLD = 3

// Anthropic-provided server-side tools — invoked by name on Anthropic's side,
// not CC client-side tools. Replacing them in the body would cause
// "Tool '<name>' not found in provided tools" 400 when the model invokes them.
// Source: https://docs.anthropic.com/en/docs/build-with-claude/tool-use
const ANTHROPIC_SERVER_TOOL_NAMES: ReadonlySet<string> = new Set([
  'web_search', 'web_search_20250305',
  'computer_20241022', 'computer_20250124', 'computer_20250313',
  'bash_20250124',
  'text_editor_20250124', 'str_replace_based_edit_tool',
  'code_execution_20250522',
])

function pickAnthropicServerTools(tools: any): any[] {
  if (!Array.isArray(tools)) return []
  return tools.filter((t: any) =>
    t && typeof t.name === 'string' && ANTHROPIC_SERVER_TOOL_NAMES.has(t.name),
  )
}

/**
 * 判断一组 tools 看起来是否像真 CC 的工具集 (大写命中阈值即可)。
 * - tools 为空 → false (单独由 disguiseBody 的 empty 分支处理)
 * - 命中 CC_CORE_TOOL_NAMES 数 ≥ CC_CORE_MATCH_THRESHOLD → true
 * 用于 aggressiveCleanTools:不像 CC 的 tools (如 OpenClaw 的小写 read/edit)
 * 即使被 UA fallback 放过 gateway 第二道 gate,也仍会被 Anthropic 上游通过
 * tools.name 内容指纹识别为第三方,触发 'Third-party apps now draw from
 * extra usage' 限流。aggressive 路径下 gateway 用 template.tools 替换它们。
 */
export function looksLikeCCTools(tools: any): boolean {
  if (!Array.isArray(tools) || tools.length === 0) return false
  let matches = 0
  for (const t of tools) {
    if (t && typeof t.name === 'string' && CC_CORE_TOOL_NAMES.has(t.name)) matches++
  }
  return matches >= CC_CORE_MATCH_THRESHOLD
}

// ── Errors ──

export class NonCCRequestError extends Error {
  readonly missingBaseline: string[]
  readonly gotTools: string[]
  readonly accountId: string
  readonly userAgent: string
  readonly clientIp: string | null

  constructor(
    missingBaseline: string[],
    gotTools: string[],
    accountId: string,
    userAgent: string,
    clientIp: string | null = null,
  ) {
    const gotPreview = gotTools.slice(0, 10).join(',') + (gotTools.length > 10 ? ',...' : '')
    super(`non-cc request: tools missing baseline [${missingBaseline.join(',')}], got [${gotPreview}]`)
    this.name = 'NonCCRequestError'
    this.missingBaseline = missingBaseline
    this.gotTools = gotTools
    this.accountId = accountId
    this.userAgent = userAgent
    this.clientIp = clientIp
  }
}

/**
 * Thrown by disguiseBody when an OAuth account has no cc_template_id bound.
 * Proxy layer catches and returns a 503 — we refuse to forward the request
 * rather than leak a version-stale fingerprint by omitting the disguise.
 */
export class NoTemplateBoundError extends Error {
  readonly accountId: string
  constructor(accountId: string) {
    super(`account ${accountId} has no cc_template_id bound — refusing to forward`)
    this.name = 'NoTemplateBoundError'
    this.accountId = accountId
  }
}

export class MissingTemplateRedisError extends Error {
  readonly accountId: string
  readonly templateId: string
  constructor(accountId: string, templateId: string) {
    super(`account ${accountId} bound template ${templateId} is missing from redis`)
    this.name = 'MissingTemplateRedisError'
    this.accountId = accountId
    this.templateId = templateId
  }
}

// Anthropic API hard limit:每个 /v1/messages 请求的 cache_control 块总数 ≤4
// (system + tools + messages 累计)。超出 → 上游 400 "A maximum of 4 blocks
// with cache_control may be provided. Found N"。
const CACHE_CONTROL_LIMIT = 4

function countCacheControlBlocks(arr: any[] | undefined): number {
  if (!Array.isArray(arr)) return 0
  let n = 0
  for (const item of arr) {
    if (item && typeof item === 'object' && (item as any).cache_control) n++
  }
  return n
}

/** 计算 body 已用的 cache_control 数(system + tools + messages.content)。 */
export function countBodyCacheControl(body: any): number {
  if (!body || typeof body !== 'object') return 0
  let n = countCacheControlBlocks(body.system) + countCacheControlBlocks(body.tools)
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (m && Array.isArray(m.content)) n += countCacheControlBlocks(m.content)
    }
  }
  return n
}

/**
 * OAuth 路径专用:template.systemBlocks 注入前,按"客户端剩余预算"修剪
 * resolvedBlocks 上的 cache_control。aggressiveDisguise=true 时 client.system
 * 整体被替换,只算 client tools + messages 配额。
 */
export function applyTemplateCacheControlBudget(
  body: any,
  resolvedBlocks: any[],
  aggressiveDisguise: boolean,
): number {
  let clientUsed = countCacheControlBlocks(body.tools)
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (m && Array.isArray(m.content)) clientUsed += countCacheControlBlocks(m.content)
    }
  }
  if (!aggressiveDisguise) {
    clientUsed += countCacheControlBlocks(body.system)
  }
  let budget = Math.max(0, CACHE_CONTROL_LIMIT - clientUsed)
  let stripped = 0
  for (const block of resolvedBlocks) {
    if (block && typeof block === 'object' && (block as any).cache_control) {
      if (budget > 0) budget--
      else {
        delete (block as any).cache_control
        stripped++
      }
    }
  }
  if (stripped > 0) {
    log('debug', `cc-disguise: client uses ${clientUsed}/${CACHE_CONTROL_LIMIT} cache_control, stripped ${stripped} from template`)
  }
  return stripped
}

/**
 * 通用兜底:body 总 cache_control 已超 4 时,按尾部优先 strip 多余的。
 * 用于 ApiKey 直连路径(无 template 注入,客户端自己加超 4 时兜底);也可作 OAuth
 * 路径在 disguiseBody 之外的二次保险。
 *
 * 修剪策略 = 从 messages 末尾开始 strip(messages 末尾的 cache_control 通常是
 * "新增内容"标记,丢失影响小;比 strip system 段缓存友好)。
 */
export function capBodyCacheControl(body: any, limit: number = CACHE_CONTROL_LIMIT): number {
  if (!body || typeof body !== 'object') return 0
  const total = countBodyCacheControl(body)
  if (total <= limit) return 0
  let need = total - limit
  let stripped = 0
  // 尾部优先:messages 倒序 → tools → system
  if (Array.isArray(body.messages)) {
    for (let i = body.messages.length - 1; i >= 0 && need > 0; i--) {
      const m = body.messages[i]
      if (!m || !Array.isArray(m.content)) continue
      for (let j = m.content.length - 1; j >= 0 && need > 0; j--) {
        const c = m.content[j]
        if (c && typeof c === 'object' && c.cache_control) {
          delete c.cache_control
          stripped++; need--
        }
      }
    }
  }
  if (need > 0 && Array.isArray(body.tools)) {
    for (let i = body.tools.length - 1; i >= 0 && need > 0; i--) {
      const t = body.tools[i]
      if (t && typeof t === 'object' && t.cache_control) {
        delete t.cache_control
        stripped++; need--
      }
    }
  }
  if (need > 0 && Array.isArray(body.system)) {
    for (let i = body.system.length - 1; i >= 0 && need > 0; i--) {
      const s = body.system[i]
      if (s && typeof s === 'object' && s.cache_control) {
        delete s.cache_control
        stripped++; need--
      }
    }
  }
  if (stripped > 0) {
    log('debug', `cap-cache-control: stripped ${stripped} cache_control to enforce limit ${limit} (was ${total})`)
  }
  return stripped
}

/**
 * 判断一个 cache_control 块的有效 ttl(返回 '1h' 或 '5m')。
 *
 * Anthropic 规则:
 *   - 显式 ttl: '1h'  → 1h
 *   - 否则(显式 ttl: '5m' / 无 ttl / 仅有 scope:'global') → 5m
 *
 * NB: scope:'global' 是 cache 共享维度(跨 device/account 共享缓存),与 ttl 正交。
 * 实测 gwbk trace ccg-mp4we9vn:Anthropic 把 {scope:'global'} 当 5m 处理 —
 * 后面跟 {ttl:'1h'} 仍报 ordering 违规。所以 ttl 推断只看 ttl 字段。
 */
function cacheControlTtl(cc: any): '1h' | '5m' {
  if (!cc || typeof cc !== 'object') return '5m'
  if (cc.ttl === '1h') return '1h'
  return '5m'
}

/**
 * Anthropic API 顺序约束:cache_control 按 `tools → system → messages` 处理顺序看,
 * 所有 ttl='1h' 的块必须排在所有 ttl='5m' 的块之前。混排 → 上游 400:
 *   "a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block"
 *
 * 触发场景:cc-disguise 注入的 template systemBlocks 自带 [1h, 5m] 时(scope='global'
 * 后跟 default ephemeral),客户端 messages 末尾再带 1h → 5m 后又出 1h,违规。
 *
 * 修复策略:扫一遍按处理顺序的所有 cache_control 块,一旦发现 5m 之后还有 1h,
 * 把那个 5m 升级为 1h(显式 ttl='1h')。代价 = 上调一个槽位的 cache TTL,语义无害
 * (cache 多活 55 分钟没坏处,只是 token 计费稍微变化)。
 *
 * 不降级 1h 为 5m — 1h 通常是模板 / 客户端故意标的"长保留"段,降级会浪费 cache_creation
 * tokens 让缓存提前失效。
 */
export function normalizeCacheControlTtlOrder(body: any): number {
  if (!body || typeof body !== 'object') return 0

  // 按 Anthropic 处理顺序收集所有 cache_control 引用
  const refs: { obj: any; src: string }[] = []
  if (Array.isArray(body.tools)) {
    for (let i = 0; i < body.tools.length; i++) {
      const t = body.tools[i]
      if (t && typeof t === 'object' && t.cache_control) refs.push({ obj: t, src: `tools[${i}]` })
    }
  }
  if (Array.isArray(body.system)) {
    for (let i = 0; i < body.system.length; i++) {
      const s = body.system[i]
      if (s && typeof s === 'object' && s.cache_control) refs.push({ obj: s, src: `system[${i}]` })
    }
  }
  if (Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i++) {
      const m = body.messages[i]
      if (!m || !Array.isArray(m.content)) continue
      for (let j = 0; j < m.content.length; j++) {
        const c = m.content[j]
        if (c && typeof c === 'object' && c.cache_control) refs.push({ obj: c, src: `messages[${i}].content[${j}]` })
      }
    }
  }

  // 找最后一个 1h 的位置;它前面所有 5m 都要升级
  let lastOneHourIdx = -1
  for (let i = refs.length - 1; i >= 0; i--) {
    if (cacheControlTtl(refs[i].obj.cache_control) === '1h') { lastOneHourIdx = i; break }
  }
  if (lastOneHourIdx <= 0) return 0  // 0 个 / 1 个 1h 块在最前 → 不可能违规

  let promoted = 0
  const promotedSrcs: string[] = []
  for (let i = 0; i < lastOneHourIdx; i++) {
    if (cacheControlTtl(refs[i].obj.cache_control) === '5m') {
      // 显式 ttl='1h';保留其他字段(scope 等)
      refs[i].obj.cache_control = { ...refs[i].obj.cache_control, ttl: '1h' }
      promoted++
      if (promotedSrcs.length < 4) promotedSrcs.push(refs[i].src)
    }
  }
  if (promoted > 0) {
    log('debug', `normalize-cc-ttl: promoted ${promoted} cache_control 5m→1h to satisfy ordering [${promotedSrcs.join(', ')}${promoted > 4 ? ', ...' : ''}]`)
  }
  return promoted
}

function templateRedisKey(templateId: string): string {
  return `cc_disguise_template:${DEPLOYMENT}:${templateId}`
}

function templateIndexRedisKey(): string {
  return `cc_disguise_templates:${DEPLOYMENT}`
}

function parseTemplateSourceVersion(sourceUA: string): string {
  const match = sourceUA.match(/claude-(?:cli|code)\/([^\s(]+)/i)
  return match?.[1] ?? ''
}

async function readTemplateFromRedis(accountId: string, templateId: string): Promise<CCTemplateCache> {
  const testTemplate = testTemplateById.get(templateId) ?? testTemplateByAccount.get(accountId)
  if (testTemplate) return testTemplate

  if (!isRedisAvailable()) {
    throw new MissingTemplateRedisError(accountId, templateId)
  }

  const raw = await getRedis().get(templateRedisKey(templateId))
  if (!raw) {
    throw new MissingTemplateRedisError(accountId, templateId)
  }

  const parsed = JSON.parse(raw)
  return {
    templateId: parsed.templateId,
    tools: Array.isArray(parsed.tools) ? parsed.tools : [],
    systemBlocks: Array.isArray(parsed.systemBlocks) ? parsed.systemBlocks : [],
    sourceUA: typeof parsed.sourceUA === 'string' ? parsed.sourceUA : '',
    loadedAt: typeof parsed.loadedAt === 'number' ? parsed.loadedAt : Date.now(),
  }
}

export async function getTemplateSourceUA(accountId: string, templateId: string | null): Promise<string> {
  if (!templateId) throw new NoTemplateBoundError(accountId)
  const template = await readTemplateFromRedis(accountId, templateId)
  return template.sourceUA
}

export async function hasTemplateInRedis(templateId: string): Promise<boolean> {
  if (testTemplateById.has(templateId)) return true
  if (!isRedisAvailable()) return false
  return (await getRedis().exists(templateRedisKey(templateId))) === 1
}

export async function syncTemplatesToRedis(): Promise<void> {
  if (!isRedisAvailable()) {
    throw new Error('Redis must be ready before syncing cc disguise templates')
  }

  const result = await query<{
    id: string
    tools: any
    system_blocks: any
    source_ua: string | null
    updated_at: Date
  }>(
    `SELECT id, tools, system_blocks, source_ua, updated_at
       FROM cc_disguise_templates
      WHERE deployment = $1`,
    [DEPLOYMENT],
  )

  const redis = getRedis()
  const indexKey = templateIndexRedisKey()
  const existingKeys = await redis.smembers(indexKey)
  const nextKeys = new Set<string>()
  const pipe = redis.pipeline()

  for (const row of result.rows) {
    const key = templateRedisKey(row.id)
    nextKeys.add(key)
    pipe.set(
      key,
      JSON.stringify({
        templateId: row.id,
        tools: Array.isArray(row.tools) ? row.tools : [],
        systemBlocks: Array.isArray(row.system_blocks) ? row.system_blocks : [],
        sourceUA: row.source_ua ?? '',
        loadedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
      }),
    )
    pipe.sadd(indexKey, key)
  }

  for (const key of existingKeys) {
    if (!nextKeys.has(key)) {
      pipe.del(key)
      pipe.srem(indexKey, key)
    }
  }

  await pipe.exec()
  log('info', `cc-disguise: synced ${result.rows.length} templates to redis`)
}

export async function assertAccountTemplatesPresent(
  accounts: Array<{ id: string; ccTemplateId: string | null; authKind: 'oauth' | 'api_key' }>,
): Promise<void> {
  for (const account of accounts) {
    if (account.authKind !== 'oauth') continue
    if (!account.ccTemplateId) throw new NoTemplateBoundError(account.id)
    if (!(await hasTemplateInRedis(account.ccTemplateId))) {
      throw new MissingTemplateRedisError(account.id, account.ccTemplateId)
    }
  }
}

// ── Model classification ──

function supportsAdaptiveThinking(model: string): boolean {
  return /opus-4-[6-9]|opus-4-\d{2}|sonnet-4-[6-9]|sonnet-4-\d{2}/i.test(model)
}

function supportsThinking(model: string): boolean {
  return supportsAdaptiveThinking(model)
    || /haiku-4-[5-9]|haiku-4-\d{2}|opus-4-[5-9]|sonnet-4-[5-9]/i.test(model)
}

/**
 * Returns an error message if the request body contains parameters that
 * Anthropic has deprecated, or null if the body is valid.
 *
 *   • top_p — deprecated for all current Claude models unconditionally.
 *             Real CC never sends it; non-CC clients occasionally do.
 *
 * Note: temperature is NOT validated here. It is normalized in
 * `normalizeTemperatureForCC` (body-integrity feature) when the account
 * options enable it — see options.ts:validate.normalizeTemperature.
 */
export function validateThinkingParams(body: any): string | null {
  if (!body || typeof body !== 'object') return null
  if ('top_p' in body) {
    return '`top_p` is deprecated and not supported by this model. Remove `top_p` from your request.'
  }
  return null
}

/**
 * Rewrites `body.temperature` to match the CC real distribution.
 * CC source: claude.ts `temperature = !hasThinking ? (override ?? 1) : undefined`.
 *
 *   - thinking type is enabled/adaptive  → delete temperature
 *   - otherwise                          → temperature = 1
 *
 * Returns the normalize tag for ctx.autoCompletedFields, or null if no change.
 *
 * Note: `thinking={type:'disabled'}` counts as "no active thinking" — CC source
 * treats hasThinking only as enabled/adaptive (disabled is the yoloClassifier /
 * hooks / API-key-verify path, which still sends temperature=1).
 */
export function normalizeTemperatureForCC(body: any): string | null {
  if (!body || typeof body !== 'object') return null
  const t = body.thinking?.type
  const thinkingActive = t === 'enabled' || t === 'adaptive'
  if (thinkingActive) {
    if ('temperature' in body) {
      delete body.temperature
      return 'temperature:omit'
    }
    return null
  }
  if (body.temperature !== 1) {
    body.temperature = 1
    return 'temperature:1'
  }
  return null
}

function getDefaultMaxTokens(model: string): number {
  if (/opus/i.test(model)) return 64000
  if (/sonnet/i.test(model)) return 32000
  if (/haiku/i.test(model)) return 32000
  return 32000
}

// ── Placeholder substitution ──
//
// Templates imported from HAR retain their captured CC wording verbatim
// (e.g. "Claude 4.X", "Fast mode for Claude Code uses..."). The only
// exceptions are PII fields — cwd, platform, shell, os_version, model line,
// cutoff — which the importer rewrites to `{{PLACEHOLDER}}` tokens that this
// function substitutes at request time. This keeps `cc-disguise.ts` free of
// CC-version-specific strings; CC 2.2 wording changes land via re-import,
// not code edits.
//
// Placeholder contract:
//   {{CWD}}              — derivedCwd(home_prefix, account_id)
//   {{PLATFORM}}         — identity_profile.prompt_env.platform
//   {{SHELL}}            — identity_profile.prompt_env.shell
//   {{OS_VERSION}}       — identity_profile.prompt_env.os_version
//   {{MODEL_MARKETING}}  — Anthropic marketing name for body.model
//   {{MODEL_ID}}         — body.model verbatim
//   {{CUTOFF}}           — knowledge-cutoff date for body.model
//
// MODEL_MARKETING/CUTOFF map Anthropic model metadata to display strings.
// This is NOT a CC-version fingerprint — Anthropic controls these labels
// server-side too — so it's fine to keep in code.

// Derive marketing name from Anthropic model id by pattern, not by table —
// so future models (claude-opus-4-8, claude-sonnet-5-0, …) work without
// code changes. Pattern covers the canonical CC 2.1.112 form:
//   claude-<family>-<major>-<minor>[-<date>][<feature>]
//   e.g. claude-opus-4-7              → "Opus 4.7"
//        claude-opus-4-7[1m]          → "Opus 4.7 (1M context)"
//        claude-haiku-4-5-20251001    → "Haiku 4.5"
//        claude-sonnet-4-6            → "Sonnet 4.6"
// If pattern fails, returns '' — the placeholder then falls through to the
// HAR-captured default (runtime-consistent, since MODEL_ID still carries the
// client's body.model verbatim).
function deriveMarketingName(modelId: string): string {
  const m = modelId.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-\d+)?(\[1m\])?$/i)
  if (!m) return ''
  const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()
  const ctx = m[4] ? ' (1M context)' : ''
  return `${family} ${m[2]}.${m[3]}${ctx}`
}

// Knowledge cutoff is not derivable from a model id alone — it depends on the
// model's training snapshot, which is metadata only Anthropic knows. Best we
// can do: recognise 4.X-series with known cutoff dates, fall through to '' so
// the placeholder's HAR default wins. When Anthropic ships 4.8+, we either
// (a) re-import a HAR with the new cutoff (preferred — zero code changes), or
// (b) append a row below. Either way: never hardcode a cutoff the HAR didn't
// already carry as the default.
const MODEL_CUTOFF_MAP: Array<[RegExp, string]> = [
  [/^claude-opus-4-7/i, 'January 2026'],
  [/^claude-sonnet-4-6/i, 'August 2025'],
  [/^claude-opus-4-[56]/i, 'May 2025'],
  [/^claude-haiku-4/i, 'February 2025'],
  [/^claude-(opus|sonnet)-4/i, 'January 2025'],
]

function pickCutoff(modelId: string): string {
  for (const [re, val] of MODEL_CUTOFF_MAP) if (re.test(modelId)) return val
  return ''
}

function derivedCwd(homePrefix: string, accountId: string): string {
  const prefix = homePrefix.endsWith('/') ? homePrefix : homePrefix + '/'
  const slug = createHash('sha256').update(`cwd:${accountId}`).digest('hex').slice(0, 8)
  return `${prefix}workspace-${slug}`
}

export function buildPlaceholderSubstitutions(
  env: IdentityProfileEnv | null,
  promptEnv: IdentityProfilePromptEnv | null,
  accountId: string,
  modelId: string,
): Record<string, string> {
  const platform = promptEnv?.platform || env?.platform || 'darwin'
  const shell = promptEnv?.shell || 'zsh'
  const osVersion = promptEnv?.os_version || 'Darwin 24.3.0'
  const homePrefix = promptEnv?.home_prefix || '/Users/dev/'
  return {
    CWD: derivedCwd(homePrefix, accountId),
    PLATFORM: platform,
    SHELL: shell,
    OS_VERSION: osVersion,
    MODEL_MARKETING: deriveMarketingName(modelId),
    MODEL_ID: modelId,
    CUTOFF: pickCutoff(modelId),
  }
}

// Placeholder syntax: `{{KEY}}` or `{{KEY|default}}`. The default carries the
// HAR-captured original value (written at import time) — that's the fallback
// used when the per-request substitution is missing or empty. Falling back to
// the literal `{{KEY}}` would itself be a fingerprint (real CC never emits
// `{{…}}` tokens), and falling back to '' produces malformed sentences like
// `"…model named . The exact…"` which are also identifiable. The HAR default
// is always a syntactically correct real-CC value.
const PLACEHOLDER_RE = /\{\{([A-Z_]+)(?:\|([^}]*))?\}\}/g

export function substitutePlaceholders(text: string, subs: Record<string, string>): string {
  return text.replace(PLACEHOLDER_RE, (_, key: string, defaultValue: string | undefined) => {
    const v = subs[key]
    if (typeof v === 'string' && v.length > 0) return v
    if (typeof defaultValue === 'string') return defaultValue
    // Template is missing a default for this key — neither subs nor the HAR
    // captured one. Returning the bare key would be a fingerprint leak, so we
    // drop the placeholder entirely. This path should never hit in practice
    // because the importer writes defaults for every known key.
    return ''
  })
}

// ── Request validation (reject non-CC traffic) ──

export function validateCCRequest(
  tools: any[] | undefined,
  accountId: string,
  userAgent: string,
  clientIp: string | null = null,
  requestShape?: RequestShape | null,
  permissive: boolean = false,
): void {
  if (!Array.isArray(tools) || tools.length === 0) {
    if (!requestShape) return
    // 与 inbound shape gate 的严格 allowlist 对齐:任何 ALLOWED_EMPTY_TOOLS_PROFILES
    // 内的 profile (含 _temperature_one_like / _structured_output_cc_like) 都信任。
    // permissive=true 时还接受 PENDING profile (toolless_thinking_disabled_like 等),
    // 对应账号开了 shapeAutoComplete / aggressiveDisguise — 否则第一道 gate 放行了,
    // 第二道 gate 仍按严格 allowlist 拒,两道标准不一致。
    if (allowsEmptyTools(requestShape, permissive)) return
    const expected = Array.from(CC_CORE_TOOL_NAMES).slice(0, 3)
    throw new NonCCRequestError(expected, [], accountId, userAgent, clientIp)
  }

  const gotNames: string[] = []
  for (const t of tools) {
    if (t && typeof t.name === 'string') gotNames.push(t.name)
  }

  let matches = 0
  for (const n of gotNames) {
    if (CC_CORE_TOOL_NAMES.has(n)) matches++
  }
  if (matches >= CC_CORE_MATCH_THRESHOLD) return

  // Tool count below threshold — check inbound UA as fallback.
  //
  // Legitimate CC sub-modes carry a different tool set than the standard
  // agentic set but always identify with a claude-cli/X.Y.Z or
  // claude-code/X.Y.Z user-agent:
  //   • agent-sdk (sdk-cli entrypoint): CronCreate/EnterPlanMode/Monitor/…
  //   • compact/summarization: minimal or empty tool set
  //
  // Non-CC clients (OpenClaw, wiki_*/fw_* tools, NewAPI bare mode) never
  // send a claude-{cli,code}/X.Y.Z UA — they use their own product UA.
  //
  // Note: we intentionally do NOT use the billing header as the signal.
  // The rewriter injects x-anthropic-billing-header into every request
  // (CC and non-CC alike) before validateCCRequest runs, making it
  // useless as a discriminator.
  if (
    /^claude-(cli|code)\//.test(userAgent)
    && (!requestShape || requestShape.family !== 'unknown')
  ) {
    log('debug', `cc-disguise: tool count ${matches}/${CC_CORE_MATCH_THRESHOLD} below threshold but UA="${userAgent.slice(0, 80)}" matches CC pattern — allowing CC sub-mode request (tools: ${gotNames.slice(0, 5).join(',')})`)
    return
  }

  const expected = Array.from(CC_CORE_TOOL_NAMES).slice(0, 3)
  throw new NonCCRequestError(expected, gotNames, accountId, userAgent, clientIp)
}

// ── Body disguise ──

/**
 * Inject the bound template's tools and system blocks into the request body.
 *
 * Throws NoTemplateBoundError if the account has no template — we never fall
 * back to a static default, because a stale default is a fingerprint leak
 * (tool names, system prompt text drift across CC versions).
 */
export async function disguiseBody(
  body: any,
  accountId: string,
  templateId: string | null,
  identity?: { env: IdentityProfileEnv | null; promptEnv: IdentityProfilePromptEnv | null } | null,
  aggressiveDisguise: boolean = false,
): Promise<void> {
  if (!body || typeof body !== 'object') return

  if (!templateId) throw new NoTemplateBoundError(accountId)
  const template = await readTemplateFromRedis(accountId, templateId)

  const model = body.model ?? ''
  const isHaikuSideQueryLike = isLikelyHaikuSideQuery(body, model)

  if (!isHaikuSideQueryLike) {
    const isEmpty = !body.tools || (Array.isArray(body.tools) && body.tools.length === 0)
    const isNonCCTools = aggressiveDisguise && !isEmpty && !looksLikeCCTools(body.tools)
    if (isEmpty || isNonCCTools) {
      const reason = isEmpty ? 'empty' : 'non-cc-replaced'
      // Preserve Anthropic server-side tools the client explicitly requested
      // (web_search, computer_*, code_execution_*, etc.). Replacing them would
      // cause "Tool '<name>' not found in provided tools" 400 when the model
      // invokes them. Template tools go first (CC fingerprint), preserved server
      // tools appended after.
      const preservedServerTools = isEmpty ? [] : pickAnthropicServerTools(body.tools)
      body.tools = [...template.tools, ...preservedServerTools]
      const suffix = preservedServerTools.length > 0
        ? ` + ${preservedServerTools.length} Anthropic server-tool(s) preserved`
        : ''
      log('debug', `cc-disguise: ${reason} → tools set from template ${template.templateId} (${body.tools.length})${suffix}`)
    }
  }

  const willInjectEnabledThinking =
    (body.thinking === undefined || body.thinking === null)
    && !supportsAdaptiveThinking(model)
    && supportsThinking(model)
  const floor = willInjectEnabledThinking ? 1025 : 1024
  if (typeof body.max_tokens === 'number' && body.max_tokens < floor) {
    const defaultMax = getDefaultMaxTokens(model)
    log('debug', `cc-disguise: raised max_tokens from ${body.max_tokens} to ${defaultMax}`)
    body.max_tokens = defaultMax
    if (body.thinking?.type === 'enabled' && body.thinking?.budget_tokens) {
      body.thinking.budget_tokens = defaultMax - 1
    }
  }

  if (body.thinking === undefined || body.thinking === null) {
    // Skip thinking injection when client params conflict with thinking:
    //   - tool_choice forces tool use (type='tool'/'any'/'required')
    //     → Anthropic 400: "Thinking may not be enabled when tool_choice forces tool use"
    //   - top_k is set
    //     → Anthropic 400: "top_k must be unset when thinking is enabled or in adaptive mode"
    // Both signals already indicate non-CC client behavior (CC client never sends these).
    // Injecting thinking would trigger 400 with no benefit — fingerprint is already broken
    // by these client params anyway.
    const tc = body.tool_choice
    const hasForcedTool = tc && (tc.type === 'tool' || tc.type === 'any' || tc.type === 'required')
    const hasTopK = body.top_k !== undefined && body.top_k !== null
    if (hasForcedTool || hasTopK) {
      log('debug', `cc-disguise: skipped thinking injection (forcedTool=${hasForcedTool}, topK=${hasTopK})`)
    } else if (!isHaikuSideQueryLike && supportsAdaptiveThinking(model)) {
      body.thinking = { type: 'adaptive' }
    } else if (!isHaikuSideQueryLike && supportsThinking(model)) {
      const maxTokens = body.max_tokens ?? getDefaultMaxTokens(model)
      body.thinking = { type: 'enabled', budget_tokens: maxTokens - 1 }
    }
    if (body.thinking) {
      log('debug', `cc-disguise: injected thinking=${JSON.stringify(body.thinking)}`)
    }
  }

  // After thinking injection, re-align temperature to CC fingerprint:
  // inbound normalize set temperature=1 when client lacked thinking; if disguise
  // then injected adaptive/enabled, temperature must be removed (CC source omits
  // it when hasThinking).
  const finalThinkingType = body.thinking?.type
  if (finalThinkingType === 'enabled' || finalThinkingType === 'adaptive') {
    if ('temperature' in body) {
      delete body.temperature
      log('debug', `cc-disguise: dropped temperature after thinking=${finalThinkingType} injected`)
    }
  }

  // context_management 模板化覆盖 — 必须在 thinking 注入之后判,基于最终 thinking 状态:
  //   CC source apiMicrocompact.ts:82 — `if (hasThinking && !isRedactThinkingActive)`
  //     thinking 存在 → 发标准 1 条 clear_thinking_20251015 + keep:'all'
  //     thinking 不存在 → 完全不发该字段
  //   HAR (proxyclawd-2026-04-* × 5) 验证。
  // 之前放在 thinking 注入之前的 bug:inbound 没 thinking → 跳过 cm 注入 → thinking 被
  // disguise 注入 adaptive 后,cm 字段仍缺失,fingerprint 异常被上游拒。
  if (aggressiveDisguise) {
    // Fix: CC source uses hasThinking, not just truthy thinking.
    // Customer can send {type: 'disabled'} → body.thinking truthy but Anthropic rejects
    // 'clear_thinking_20251015 strategy requires thinking to be enabled or adaptive'.
    // Only inject context_management when thinking.type matches CC source's hasThinking semantic.
    const ccmThinkingType = body.thinking?.type
    if (ccmThinkingType === 'enabled' || ccmThinkingType === 'adaptive') {
      body.context_management = { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] }
    } else if ('context_management' in body) {
      delete body.context_management
    }
  }

  // Template blocks carry the captured CC fingerprint verbatim, with PII
  // fields replaced by {{PLACEHOLDER}} tokens. Substitute per-account values
  // so each request sees its own cwd/platform/shell/os_version/model line.
  const subs = buildPlaceholderSubstitutions(
    identity?.env ?? null,
    identity?.promptEnv ?? null,
    accountId,
    model,
  )
  const resolvedBlocks = template.systemBlocks.map(b => {
    const block = typeof b === 'string' ? { type: 'text', text: b } : { ...b }
    if (typeof block.text === 'string') block.text = substitutePlaceholders(block.text, subs)
    return block
  })

  // OAuth 路径:template 注入前先算客户端已用 cache_control 预算,template 按
  // "剩余配额"保留 cache_control。详见 capCacheControlBlocks 注释。
  applyTemplateCacheControlBudget(body, resolvedBlocks, aggressiveDisguise)

  if (Array.isArray(body.system) && aggressiveDisguise) {
    // aggressiveDisguise=true: system 整体重置为 [billing, ...template]
    // 丢弃客户端塞的所有 block (含 'OpenClaw' 暴露 block / 'You are Claude Code' 诱饵 / 客户端业务 prompt)
    // 与 tools/context_management 替换同口径。第三方客户端的 system fingerprint 100% 干净。
    const billingBlock = body.system.find((b: any) => {
      const text = typeof b === 'string' ? b : b?.text
      return typeof text === 'string' && text.includes('x-anthropic-billing-header')
    })
    const droppedCount = body.system.length - (billingBlock ? 1 : 0)
    body.system = billingBlock ? [billingBlock, ...resolvedBlocks] : [...resolvedBlocks]
    log('debug', `cc-disguise: aggressive → system reset (dropped ${droppedCount} client blocks, kept billing + ${resolvedBlocks.length} template blocks)`)
  } else if (Array.isArray(body.system)) {
    const hasCC = body.system.some((b: any) => {
      const text = typeof b === 'string' ? b : b?.text
      return typeof text === 'string' && text.includes('You are Claude Code')
    })
    if (!hasCC) {
      const billingIdx = body.system.findIndex((b: any) => {
        const text = typeof b === 'string' ? b : b?.text
        return typeof text === 'string' && text.includes('x-anthropic-billing-header')
      })
      const insertAt = billingIdx >= 0 ? billingIdx + 1 : 0
      body.system.splice(insertAt, 0, ...resolvedBlocks)
      log('debug', `cc-disguise: injected ${resolvedBlocks.length} template blocks (placeholders resolved)`)
    }
  } else if (!body.system && !isHaikuSideQueryLike) {
    body.system = resolvedBlocks
  }
}

// ── Cache management ──

export function getTemplateCache(accountId: string): CCTemplateCache | undefined {
  return testTemplateByAccount.get(accountId)
}

export function resetTemplateCache(): void {
  testTemplateByAccount.clear()
  testTemplateById.clear()
}

export function invalidateTemplateCache(accountId: string): void {
  const existing = testTemplateByAccount.get(accountId)
  testTemplateByAccount.delete(accountId)
  if (existing) testTemplateById.delete(existing.templateId)
}

/**
 * Test-only. Manually seed a template into the in-memory cache without going
 * through the DB. Never called from production code.
 */
export function _setTemplateCacheForTest(accountId: string, entry: CCTemplateCache): void {
  testTemplateByAccount.set(accountId, entry)
  testTemplateById.set(entry.templateId, entry)
}

export function sourceVersionFromTemplateUA(sourceUA: string): string {
  return parseTemplateSourceVersion(sourceUA)
}

function isLikelyHaikuSideQuery(body: any, model: string): boolean {
  if (!/haiku/i.test(model)) return false
  if (body.thinking !== undefined && body.thinking !== null) return false
  const tools = Array.isArray(body.tools) ? body.tools : []
  if (tools.length > 0) return false
  if (body.output_config?.format) return true
  return body.max_tokens === 1
}
