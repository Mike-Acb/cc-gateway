import { createHash } from 'crypto'

export type RequestFamily =
  | 'repl_main_thread'
  | 'side_query'
  | 'compact'
  | 'count_tokens'
  | 'telemetry'
  | 'unknown'

export type RequestShape = {
  family: RequestFamily
  profile: string
  confidence: number
  reason: Record<string, any>
}

export type RequestShapeInput = {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: any
  clientName?: string | null
}

const COMPACT_SYSTEM_HINT = 'You are a helpful AI assistant tasked with summarizing conversations.'

/**
 * Side-query profiles with zero tools that are allowed through.
 *
 * Only add profiles here after confirming the pattern in both:
 *   1) HAR captures (actual CC traffic evidence), and
 *   2) claude-code source code.
 *
 * Profiles that are classified but NOT listed here will still be logged
 * with their specific profile name (shape_profile_in in request_logs),
 * making future HAR-based validation easier.
 */
const ALLOWED_EMPTY_TOOLS_PROFILES = new Set([
  // HAR: proxyclawd-export*.har probe requests (haiku, max_tokens=1, no temp)
  'haiku_probe_like',
  // HAR: proxyclawd-2026-04-19(2).har (haiku, tools=0, output_config, temp=1)
  'haiku_structured_output_like',
  // HAR: proxyclawd-2026-04-14/16/17.har — high-frequency pattern
  //      haiku/any-model, tools=0, temp=1, no output_config
  //      CC source: sideQuery calls that set temperature=1 but omit output_format
  'toolless_side_query_temperature_one_like',
  // gwbk request_logs (2026-04-27 cs / claude-cli 2.1.119): structured-output
  // side queries that ALSO carry CC-specific markers — anthropic-beta contains
  // 'structured-outputs-2025-12-15' (auto-injected by claude-code/src/utils/
  // sideQuery.ts:131-137) and/or output_config.effort is set (set by main query
  // path via claude-code/src/services/api/claude.ts:1546-1556 configureEffortParams).
  // CC sources: utils/sessionTitle.ts, memdir/findRelevantMemories.ts,
  // utils/hooks/execPromptHook.ts, commands/rename/generateSessionName.ts.
  // Pairs with classifyMessagesShape() narrowing — see 'cc_like' branch below.
  'structured_output_side_query_cc_like',
  // gwbk trace ccg-mp4uizm6 (2026-05-14, claude-opus-4-7): tools=0 + thinking=adaptive
  // + stream + 单条 user message。CC 真实形态:hook 评测 / 单轮 prompt 调用,
  // adaptive thinking 保留但当次没 tools。与 agentic_*_like 同源,只差 toolsLen=0。
  'toolless_thinking_active_like',
  // --- Pending HAR confirmation (classified for observability, not yet allowlisted) ---
  // 'toolless_thinking_disabled_like',     // yoloClassifier: tools=0, thinking=disabled, temp=0
  // 'structured_output_side_query_like',   // SDK structured-output without CC betas/effort — keep blocked
  // 'toolless_side_query_generic_like',    // agenticSessionSearch / validateModel: tools=0, no thinking, no temp
])

/**
 * Side-query profiles with one or more tools that are allowed through.
 */
const ALLOWED_NONEMPTY_TOOLS_SIDE_QUERY_PROFILES = new Set([
  // HAR: confirmed in various captures; CC source: hooks / skill-improvement
  'tool_assisted_side_query_like',
  // HAR: ccg-mp4vk9za-d2bfbf6bca84 (agent-sdk/0.2.128 probe);
  // CC source: permissionExplainer.ts — tools>0, no thinking, no/default temp.
  // classifier 把 temperature === undefined 和 === 1 视为同一形态(messages
  // API 默认值即 1),所以本 profile 同时覆盖"不发 temp"和"显式发 1"两种调用。
  'tool_assisted_nothinker_like',
])

/**
 * CC 源码已确认行为但 HAR 还没抓到的 profile 集合。
 * 仅当账号 options.validate.shapeAutoComplete=true 时,这些 profile 也允许通过 gate。
 *
 * 严格 allowlist(ALLOWED_*) 仍然是 HAR + CC source 双确认;PENDING 这一档对应
 * "源码可信但样本 pending"——把放行权交给账号级开关,运营接受额外风险。
 *
 * 加入这里之前必须有 CC 源码引用作为依据。
 */
const PENDING_HAR_EMPTY_TOOLS_PROFILES = new Set([
  // CC source: yoloClassifier.ts `thinking: disableThinking` (=false → {type:'disabled'})
  // /  hooks / API-key-verify path
  // 客户端已显式发 thinking=disabled — gateway 不能改写,只能整 profile 放行。
  'toolless_thinking_disabled_like',
  // 注意:`toolless_side_query_generic_like`(无 thinking + 无 temp 兜底)
  //       不放进 PENDING,而是通过 applyShapeAutoComplete 补 temperature=1
  //       让形态升级到严格 allowlist 内的 _temperature_one_like — 规范化更彻底。
])

const PENDING_HAR_NONEMPTY_TOOLS_PROFILES = new Set<string>([
  // 2026-05-15:tool_assisted_nothinker_like 已升级到 ALLOWED 集合
  // (HAR ccg-mp4vk9za-d2bfbf6bca84 确认 agent-sdk/permissionExplainer 形态)。
])

export function classifyRequestShape(input: RequestShapeInput): RequestShape {
  const path = input.path || '/'

  if (path.includes('/event_logging/') && path.includes('/batch')) {
    return shape('telemetry', 'event_logging_batch', 100, {
      path,
      method: input.method,
    })
  }
  if (path.startsWith('/api/eval/')) {
    return shape('telemetry', 'session_init_growthbook_eval', 100, { path })
  }
  if (path === '/api/oauth/account/settings') {
    return shape('telemetry', 'session_init_account_settings', 100, { path })
  }
  if (path === '/api/claude_code_grove') {
    return shape('telemetry', 'session_init_grove', 100, { path })
  }
  if (path === '/api/claude_cli/bootstrap') {
    return shape('telemetry', 'session_init_bootstrap', 100, { path })
  }
  if (path === '/api/claude_code_penguin_mode') {
    return shape('telemetry', 'session_init_penguin_mode', 100, { path })
  }
  if (path.startsWith('/v1/mcp_servers')) {
    return shape('telemetry', 'session_init_mcp_servers', 100, { path })
  }
  if (path.startsWith('/v1/messages/count_tokens')) {
    return classifyCountTokensShape(input)
  }
  if (path.startsWith('/v1/messages')) {
    return classifyMessagesShape(input)
  }
  return shape('unknown', 'unknown_path', 0, { path, method: input.method })
}

function classifyCountTokensShape(input: RequestShapeInput): RequestShape {
  const body = asObject(input.body)
  const model = asString(body.model)
  const toolsLen = toolsLength(body.tools)
  const thinkingType = asString(body.thinking?.type)
  const hasOutputConfig = !!body.output_config?.format
  const systemTexts = collectSystemTexts(body.system)
  const compactLike = systemTexts.some(t => t.includes(COMPACT_SYSTEM_HINT))

  if (/haiku/i.test(model) && toolsLen === 0 && !thinkingType) {
    return shape('count_tokens', 'count_tokens_haiku_probe_like', 95, {
      model,
      tools_len: toolsLen,
      thinking_type: thinkingType,
      output_config: hasOutputConfig,
    })
  }
  if (compactLike) {
    return shape('count_tokens', 'count_tokens_compact_like', 90, {
      model,
      system_hash: hashStrings(systemTexts),
    })
  }
  return shape('count_tokens', 'count_tokens_generic_like', 70, {
    model,
    tools_len: toolsLen,
    thinking_type: thinkingType,
    output_config: hasOutputConfig,
  })
}

function classifyMessagesShape(input: RequestShapeInput): RequestShape {
  const body = asObject(input.body)
  const model = asString(body.model)
  const toolsLen = toolsLength(body.tools)
  const toolNames = collectToolNames(body.tools)
  const thinkingType = asString(body.thinking?.type)
  const temperature = body.temperature
  const topP = body.top_p
  const maxTokens = body.max_tokens
  const hasOutputConfig = !!body.output_config?.format
  const effort = asString(body.output_config?.effort)
  const systemTexts = collectSystemTexts(body.system)
  const compactLike = systemTexts.some(t => t.includes(COMPACT_SYSTEM_HINT))
  const stream = body.stream !== false
  const ua = firstHeaderValue(input.headers, 'user-agent')
  const betas = firstHeaderValue(input.headers, 'anthropic-beta')
  const reasonBase = {
    model,
    tools_len: toolsLen,
    tool_names: toolNames.slice(0, 8),
    thinking_type: thinkingType,
    temperature,
    top_p: topP,
    max_tokens: maxTokens,
    output_config: hasOutputConfig,
    effort,
    stream,
    system_hash: hashStrings(systemTexts),
    ua,
    betas,
  }

  if (compactLike) {
    return shape('compact', 'compact_summary_like', 98, reasonBase)
  }

  if (
    /haiku/i.test(model)
    && toolsLen === 0
    && !thinkingType
    && maxTokens === 1
    && !hasOutputConfig
    && temperature === undefined
  ) {
    return shape('side_query', 'haiku_probe_like', 100, reasonBase)
  }

  if (
    /haiku/i.test(model)
    && toolsLen === 0
    && !thinkingType
    && hasOutputConfig
    && temperature === 1
  ) {
    return shape('side_query', 'haiku_structured_output_like', 100, reasonBase)
  }

  if (
    toolsLen > 0
    && thinkingType === 'disabled'
  ) {
    return shape('side_query', 'tool_assisted_side_query_like', 88, reasonBase)
  }

  if (
    toolsLen === 0
    && !thinkingType
    && temperature === 1
  ) {
    return shape('side_query', 'toolless_side_query_temperature_one_like', 75, reasonBase)
  }

  if (
    toolsLen > 0
    && stream
    && (thinkingType === 'adaptive' || thinkingType === 'enabled')
    && temperature === undefined
    && topP === undefined
  ) {
    if (/opus/i.test(model) && (maxTokens >= 50000 || String(betas).includes('context-1m-2025-08-07'))) {
      return shape('repl_main_thread', 'agentic_opus_long_context_like', 92, reasonBase)
    }
    if (/opus/i.test(model)) {
      return shape('repl_main_thread', 'agentic_opus_like', 90, reasonBase)
    }
    if (/sonnet/i.test(model)) {
      return shape('repl_main_thread', 'agentic_sonnet_like', 90, reasonBase)
    }
    if (/haiku/i.test(model)) {
      return shape('repl_main_thread', 'agentic_haiku_like', 85, reasonBase)
    }
    return shape('repl_main_thread', 'agentic_generic_like', 80, reasonBase)
  }

  // Toolless side query / 评测 prompt with active thinking (adaptive/enabled), no tools.
  // Real CC 形态:某些 hook 调用 / 单轮评测题 不带工具但保留 adaptive thinking。
  // 例:gwbk trace ccg-mp4uizm6-3cca2a4422e8 — opus-4-7,tools=0,thinking=adaptive,
  // system 含 "You are Claude Code" 校验通过,messages 是单条评测 prompt。
  // 与 agentic_*_like 的差别仅是 toolsLen:thinking 主动 + adaptive 是同一类客户端
  // 行为,只是这次调用没传 tools。
  if (
    toolsLen === 0
    && stream
    && (thinkingType === 'adaptive' || thinkingType === 'enabled')
    && temperature === undefined
    && topP === undefined
  ) {
    return shape('side_query', 'toolless_thinking_active_like', 85, reasonBase)
  }

  // Main REPL loop with thinking disabled (temp=1 is sent explicitly when !hasThinking).
  // Covers haiku as primary model, or any model running without extended thinking.
  // CC source: claude.ts `temperature = !hasThinking ? (options.temperatureOverride ?? 1) : undefined`
  if (
    toolsLen > 0
    && stream
    && !thinkingType
    && temperature === 1
    && topP === undefined
  ) {
    if (/opus/i.test(model) && (maxTokens >= 50000 || String(betas).includes('context-1m-2025-08-07'))) {
      return shape('repl_main_thread', 'agentic_opus_t1_long_context_like', 88, reasonBase)
    }
    if (/opus/i.test(model)) {
      return shape('repl_main_thread', 'agentic_opus_t1_like', 88, reasonBase)
    }
    if (/sonnet/i.test(model)) {
      return shape('repl_main_thread', 'agentic_sonnet_t1_like', 88, reasonBase)
    }
    if (/haiku/i.test(model)) {
      return shape('repl_main_thread', 'agentic_haiku_t1_like', 90, reasonBase)
    }
    return shape('repl_main_thread', 'agentic_generic_t1_like', 82, reasonBase)
  }

  // yoloClassifier / hooks / API-key-verify: thinking explicitly disabled, no tools.
  // CC source: yoloClassifier.ts `thinking: disableThinking` (=false → {type:'disabled'})
  if (toolsLen === 0 && thinkingType === 'disabled') {
    return shape('side_query', 'toolless_thinking_disabled_like', 80, reasonBase)
  }

  // Tool-assisted sideQuery without explicit thinking (permissionExplainer, etc.).
  // CC source: permissionExplainer.ts sends tools=[EXPLAIN_COMMAND_TOOL] with no thinking.
  // temperature 接受 undefined 或 1 — 上游 messages API 默认值即 1,显式发 1
  // 与不发等价,SDK 调用方常显式带 1(HAR ccg-mp4vk9za-d2bfbf6bca84)。
  // 注意:agentic_*_t1_like 分支要求 stream=true,本分支兜底非 stream 调用,
  //       两者不会互抢。
  if (
    toolsLen > 0
    && !thinkingType
    && (temperature === undefined || temperature === 1)
    && topP === undefined
  ) {
    return shape('side_query', 'tool_assisted_nothinker_like', 75, reasonBase)
  }

  // Structured output sideQuery on any model (sessionTitle / findRelevantMemories /
  // execPromptHook / generateSessionName). Catches cases where haiku_structured_
  // output_like doesn't match (non-haiku or temp≠1).
  //
  // Splits by CC fingerprint:
  // - *_cc_like: anthropic-beta contains 'structured-outputs-2025-12-15' (auto-
  //   injected by sideQuery.ts:131-137) OR output_config.effort is set (set by
  //   main query path in claude.ts:1546-1556 configureEffortParams). HAR-confirmed
  //   in claude-cli 2.1.119 — see ALLOWED_EMPTY_TOOLS_PROFILES comment.
  // - generic *_like: same body shape but missing the CC-specific betas/effort,
  //   typically third-party SDKs using gateway as a proxy. Blocked pending HAR.
  if (toolsLen === 0 && !thinkingType && hasOutputConfig) {
    const hasStructuredOutputsBeta = String(betas ?? '').includes('structured-outputs-2025-12-15')
    if (hasStructuredOutputsBeta || effort) {
      return shape('side_query', 'structured_output_side_query_cc_like', 90, reasonBase)
    }
    return shape('side_query', 'structured_output_side_query_like', 70, reasonBase)
  }

  // General toolless sideQuery: session search, validateModel (non-haiku), auto_mode critique, etc.
  // All have tools=0, no explicit thinking, and varied or absent temperature.
  if (toolsLen === 0 && !thinkingType) {
    return shape('side_query', 'toolless_side_query_generic_like', 70, reasonBase)
  }

  return shape('unknown', 'unknown_messages_shape', 20, reasonBase)
}

export interface ValidateShapeOpts {
  /**
   * 放宽到"CC 源码确认但 HAR Pending"集合 — 由账号级
   * options.validate.shapeAutoComplete 控制。
   */
  permissive?: boolean
}

export function validateRequestShape(
  input: RequestShapeInput,
  requestShape: RequestShape,
  opts: ValidateShapeOpts = {},
): string | null {
  const path = input.path || '/'
  const body = asObject(input.body)
  const toolsLen = toolsLength(body.tools)
  const permissive = opts.permissive === true

  if (path.startsWith('/v1/messages/count_tokens')) {
    return requestShape.family === 'count_tokens'
      ? null
      : `count_tokens request shape mismatch: ${requestShape.profile}`
  }

  if (!path.startsWith('/v1/messages')) return null

  if (requestShape.family === 'compact') return null
  if (requestShape.family === 'repl_main_thread') return null

  if (requestShape.family === 'side_query') {
    if (toolsLen === 0) {
      if (ALLOWED_EMPTY_TOOLS_PROFILES.has(requestShape.profile)) return null
      if (permissive && PENDING_HAR_EMPTY_TOOLS_PROFILES.has(requestShape.profile)) return null
      return `empty-tools side-query shape is not allowlisted: ${requestShape.profile}`
    }
    if (ALLOWED_NONEMPTY_TOOLS_SIDE_QUERY_PROFILES.has(requestShape.profile)) return null
    if (permissive && PENDING_HAR_NONEMPTY_TOOLS_PROFILES.has(requestShape.profile)) return null
    return `side-query shape is not allowlisted: ${requestShape.profile}`
  }

  if (toolsLen === 0) {
    return 'empty tools are only allowed for verified side-query shapes'
  }

  return `request shape not allowed: ${requestShape.profile}`
}

/**
 * 只在账号开 shapeAutoComplete 时调用 — 在 body 上原地补 CC 真实分布等价的字段,
 * 让原本兜底的 *_generic_like 跳到严格 allowlist 内的 profile。
 *
 * 当前只补一件事:thinking 不是 enabled/adaptive 时,缺 temperature 就补 1。
 * (CC source: claude.ts `temperature = !hasThinking ? (override ?? 1) : undefined`,
 *  上游 messages API 默认 temp=1,所以补值=默认值,响应语义零副作用。)
 *
 * 不补 thinking / tools / metadata / messages — 详见设计讨论:
 * - thinking 字段不存在是 CC 真实形态(toolless side query 的特征);补 disabled
 *   反而落到 PENDING profile 而非严格 allowlist。
 * - tools / metadata / messages 改写会破坏客户端响应语义。
 *
 * 返回实际补齐的字段名列表(用于审计日志)。
 */
export function applyShapeAutoComplete(body: any): string[] {
  if (!body || typeof body !== 'object') return []
  const t = body.thinking?.type
  const hasActiveThinking = t === 'enabled' || t === 'adaptive'
  const completed: string[] = []
  if (body.temperature === undefined && !hasActiveThinking) {
    body.temperature = 1
    completed.push('temperature:1')
  }
  return completed
}

export function allowsEmptyTools(requestShape: RequestShape, permissive: boolean = false): boolean {
  if (requestShape.family === 'count_tokens') return true
  if (requestShape.family !== 'side_query') return false
  if (ALLOWED_EMPTY_TOOLS_PROFILES.has(requestShape.profile)) return true
  // permissive 模式:对齐 inbound shape gate 的放宽行为 — 第一道 gate 接受了的
  // PENDING profile (toolless_thinking_disabled_like 等),第二道 cc-disguise gate
  // 也要接受,否则两道 gate 标准不一致,permissive 通过的请求会被这里误杀。
  if (permissive && PENDING_HAR_EMPTY_TOOLS_PROFILES.has(requestShape.profile)) return true
  return false
}

function shape(
  family: RequestFamily,
  profile: string,
  confidence: number,
  reason: Record<string, any>,
): RequestShape {
  return { family, profile, confidence, reason }
}

function asObject(value: any): Record<string, any> {
  return value && typeof value === 'object' ? value : {}
}

function asString(value: any): string {
  return typeof value === 'string' ? value : ''
}

function firstHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== name) continue
    if (Array.isArray(v)) return v[0] ?? ''
    return typeof v === 'string' ? v : ''
  }
  return ''
}

function toolsLength(tools: any): number {
  return Array.isArray(tools) ? tools.length : 0
}

function collectToolNames(tools: any): string[] {
  if (!Array.isArray(tools)) return []
  return tools
    .map(t => typeof t?.name === 'string' ? t.name : '')
    .filter(Boolean)
}

function collectSystemTexts(system: any): string[] {
  if (typeof system === 'string') return [system]
  if (!Array.isArray(system)) return []
  return system
    .map(block => typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : '')
    .filter(Boolean)
}

function hashStrings(values: string[]): string {
  if (values.length === 0) return ''
  return createHash('sha256').update(values.join('\n---\n')).digest('hex')
}
