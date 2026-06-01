import { z } from 'zod'

const FORBIDDEN_HEADER_KEYS = new Set([
  'authorization', 'x-api-key', 'host', 'cookie',
  'content-length', 'connection', 'proxy-connection',
  'cdn-loop', 'x-real-ip', 'forwarded',
])

const triState = z.object({
  mode: z.enum(['omit', 'passthrough', 'override']),
  value: z.string().nullable(),
})

const betaState = z.object({
  mode: z.enum(['omit', 'passthrough', 'override', 'append']),
  value: z.string().nullable(),
})

const extraHeaders = z.record(z.string(), z.string()).refine(
  (rec) => Object.keys(rec).every((k) => !FORBIDDEN_HEADER_KEYS.has(k.toLowerCase())),
  { message: 'extraHeaders 禁止包含 authorization / x-api-key / host / cookie 等敏感头' },
)

export const AccountOptionsSchema = z.object({
  validate: z.object({
    body: z.boolean(),
    shape: z.boolean(),
    // 放宽 shape gate:除严格 HAR allowlist 外,接受 CC 源码确认但 HAR Pending
    // 的 profile (toolless_thinking_disabled_like / toolless_side_query_generic_like 等),
    // 同时对缺 temperature 的请求自动补 1 (CC 真实分布的等价值,响应语义无副作用)。
    // 仅在 OAuth 通道有意义;关闭时严格按 ALLOWED_EMPTY_TOOLS_PROFILES 行事。
    shapeAutoComplete: z.boolean().default(false),
    // 主动语义破坏伪装:
    //   - 客户端 tools 不像 CC 时,用 template.tools 替换 (上游收到 CC 工具集)
    //   - body.context_management 用 CC 真实形态覆盖 (避免上游 schema 拒绝)
    // 代价:客户端发的 tool_use 调用、自定义 compact 配置全部失效。
    // 与 shapeAutoComplete 的"零副作用"边界明确分开 — 这个开关代表"愿意为
    // 伪装牺牲多少客户端语义"。
    aggressiveDisguise: z.boolean().default(false),
    // 把 temperature 规整到 CC 真实分布:thinking active → 删 temperature;
    // 否则 → temperature=1。CC source: claude.ts
    //   `temperature = !hasThinking ? (override ?? 1) : undefined`
    // 这个 normalize 必须在 inbound-validate 第一步跑,使 unknown_messages_shape
    // 的请求(如 IDE agent 默认 temperature=0)经修正后可重分类为 agentic_*_t1_like,
    // 自动通过 shape 校验。OAuth 通道默认开;APIKEY 通道透传客户端原始值,默认关。
    normalizeTemperature: z.boolean().default(false),
    model: z.boolean(),
    fastMode: z.boolean(),
    requireStream: z.boolean(),
  }),
  clean: z.object({
    ccHeaders: z.boolean(),
    ccBetaFlags: z.boolean(),
    systemText: z.boolean(),
    metadata: z.boolean(),
    // 截断 assistant 消息中最后一个 tool_use 之后的 text/thinking/redacted_thinking 块。
    // 客户端 SDK 在重组 thinking + tool_use streaming 时常把 text 重复输出,产生
    // [text, tool_use, text(重复)] 这种畸形结构。Anthropic 上游隐式校验该结构会
    // 报 `tool_use ids were found without tool_result blocks immediately after`
    // (实际是 block 顺序违规,不是配对缺失)。OAuth 通道关闭=400;APIKEY 透传到
    // 第三方 provider 时可关。
    toolUseTrailing: z.boolean().default(true),
    // anthropic API hard limit:cache_control 块 ≤4(system+tools+messages 累计)。
    // 客户端意外发超 4 个 → 上游 400 "A maximum of 4 blocks with cache_control"。
    // 开启后 gateway 兜底从尾部 strip 多余 cache_control。OAuth 路径
    // disguiseBody 内的 template-budget 修剪是另一层(模板注入前算预算);本开关
    // 是 disguiseBody 之后 / ApiKey 直连路径的最终兜底。
    capCacheControl: z.boolean().default(true),
    // 把非 CC 风格的 tools (opencode/crush 的 snake_case 命名) 改写成 CC 风格:
    //   tool.name           snake_case → PascalCase  (read→Read, sessions_spawn→SessionsSpawn)
    //   tool.input_schema   camelCase keys → snake_case  (filePath → file_path)
    //   tool name `exec` 唯一 alias → `Bash`
    // 响应 SSE 阶段再反向 (tool_use.name + input keys) 把客户端的命名风格还原。
    // 仅在愿意服务非 CC TUI agent (opencode 等) 的账号开启 — 命中后请求过
    // validateCCRequest baseline,Anthropic 上游收到的 tool name 是 CC 形态。
    // 风险:tool input_schema 字段虽改成 snake_case,但语义仍是客户端约定的
    // (`filePath` 含义);若 Anthropic 反作弊算 tool schema 指纹,可能识别为
    // 第三方。默认关。
    canonicalizeNonCCTools: z.boolean().default(false),
  }),
  override: z.object({
    userAgent: triState,
    anthropicVersion: triState,
    anthropicBeta: betaState,
    extraHeaders,
  }),
  events: z.object({
    emitTengu: z.boolean(),
  }),
  canonicalCcMessages: z.boolean(),
})

export type AccountOptions = z.infer<typeof AccountOptionsSchema>

export const OAUTH_DEFAULT_OPTIONS: AccountOptions = {
  validate:  { body: true, shape: true, shapeAutoComplete: false, aggressiveDisguise: false, normalizeTemperature: true, model: true, fastMode: true, requireStream: true },
  clean:     { ccHeaders: false, ccBetaFlags: false, systemText: false, metadata: false, toolUseTrailing: true, capCacheControl: true, canonicalizeNonCCTools: false },
  override:  {
    userAgent:        { mode: 'omit', value: null },
    anthropicVersion: { mode: 'omit', value: null },
    anthropicBeta:    { mode: 'omit', value: null },
    extraHeaders: {},
  },
  events: { emitTengu: true },
  canonicalCcMessages: true,
}

export const APIKEY_DEFAULT_OPTIONS: AccountOptions = {
  validate:  { body: true, shape: true, shapeAutoComplete: true, aggressiveDisguise: false, normalizeTemperature: false, model: true, fastMode: true, requireStream: true },
  clean:     { ccHeaders: true, ccBetaFlags: true, systemText: true, metadata: true, toolUseTrailing: true, capCacheControl: true, canonicalizeNonCCTools: false },
  override:  {
    userAgent:        { mode: 'omit', value: null },
    anthropicVersion: { mode: 'omit', value: null },
    anthropicBeta:    { mode: 'omit', value: null },
    extraHeaders: {},
  },
  events: { emitTengu: false },
  canonicalCcMessages: false,
}

export function decodeOptions(raw: unknown, authKind: 'oauth' | 'api_key'): AccountOptions {
  const parsed = AccountOptionsSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  // 容错:DB row 出错时回退到默认,日志在调用方打
  return authKind === 'oauth' ? OAUTH_DEFAULT_OPTIONS : APIKEY_DEFAULT_OPTIONS
}
