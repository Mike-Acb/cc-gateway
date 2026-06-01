import type { ServerResponse } from 'http'

/**
 * 心跳探测识别 + 模拟 Anthropic 响应。
 *
 * 客户端常发的"号池可用性探测"形如:
 *   POST /v1/messages
 *   { model, stream:true, messages:[{role:'user',content:'Hi'}], max_tokens:5 }
 *
 * 真打 Anthropic 会浪费一次 quota + 触发限流计数,而探测本身只关心"网关 +
 * 号池是否能服务"。识别后:
 *   1. 不进 selectAccount / ensureValidToken — 零账号副作用
 *   2. 仅检查号池有 ≥1 active+未冷却账号 (hasAnyReadyAccount)
 *   3. 按真 Anthropic schema 返回 200,流式发完整 6 段 SSE / 非流式返单 JSON
 *
 * 识别 = 仅看 messages 结构 (其他字段一律放行):
 *   - path == /v1/messages (排除 count_tokens)
 *   - messages.length === 1
 *   - messages[0].role === 'user'
 *   - messages[0].content 命中下面任一:
 *       a) 文本归一化后 ∈ {hi, hello}  → 回 "OK"
 *       b) 以 "reply:" 开头 (大小写不敏感, 总长 <50)
 *          → 回 "reply:" 后面的内容,trim 后原样返回。这是一类显式心跳协议,
 *            探活方主动指定期望回包内容,适合做带签名的可用性探测。
 *
 * 不约束 tools / thinking / system / max_tokens:真 CC 客户端做探活时会
 * 套业务默认配置 (system="You are Claude Code", tools=[Read/Bash/...], max_tokens=32000),
 * 只换 prompt。约束这些字段会漏掉绝大部分真实形态的心跳。
 *
 * 误判面:真用户在 CC 里发 "hi" 想开聊天会被网关拦下返 "OK";真用户发 "Reply: ..."
 * 会被截走。代价 = 重发,远小于"漏掉心跳→burn quota"的代价。
 *
 * 白名单 = 精确匹配 hi/hello (大小写不敏感, trim 空白和常见尾随标点);
 * reply: 协议 = 任意 <50 字内容。运营要加新词扩 HEARTBEAT_PHRASES 即可。
 */

const HEARTBEAT_PHRASES = new Set([
  'hi',
  'hello',
])

function normalizeHeartbeatText(s: string): string {
  // 去首尾空白 + 去尾部所有标点 (! ? . ,) — "Hi!" / "hello." 也算心跳
  return s.trim().replace(/[\s!?.,。!?,.]+$/u, '').toLowerCase()
}

function extractFirstUserText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  // 心跳一定不含 image/tool_result/tool_use 等结构化 block,只接受纯 text 形态
  const out: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') return null
    const b = block as Record<string, unknown>
    if (b.type !== 'text') return null
    if (typeof b.text !== 'string') return null
    out.push(b.text)
  }
  return out.join('')
}

const REPLY_PREFIX_MAX_LEN = 50
const REPLY_PREFIX_RE = /^\s*reply\s*[:：]\s*/i  // 半角 ":" 和全角 ":" 都算

/**
 * 识别心跳请求,返回应回应的文本。
 *   - 命中 hi/hello 白名单 → "OK"
 *   - 命中 "reply: <X>" 协议 (总长 <50) → X (trim 后原样)
 *   - 不命中 → null,放行到正常上游流程
 */
export function matchHeartbeat(path: string, parsedBody: any): { replyText: string } | null {
  if (!path.startsWith('/v1/messages')) return null
  if (path.includes('/count_tokens')) return null
  if (!parsedBody || typeof parsedBody !== 'object') return null

  if (!Array.isArray(parsedBody.messages) || parsedBody.messages.length !== 1) return null
  const m = parsedBody.messages[0]
  if (!m || typeof m !== 'object' || m.role !== 'user') return null
  const text = extractFirstUserText(m.content)
  if (text === null) return null

  // hi/hello 白名单
  if (HEARTBEAT_PHRASES.has(normalizeHeartbeatText(text))) {
    return { replyText: 'OK' }
  }

  // "reply: X" 显式协议:总长上限防误判长 prompt
  if (text.length < REPLY_PREFIX_MAX_LEN && REPLY_PREFIX_RE.test(text)) {
    const payload = text.replace(REPLY_PREFIX_RE, '').trim()
    if (payload.length > 0) {
      return { replyText: payload }
    }
  }

  return null
}

/** Backwards-compat boolean wrapper — keep for tests that still call this name. */
export function isHeartbeatRequest(path: string, parsedBody: any): boolean {
  return matchHeartbeat(path, parsedBody) !== null
}

function genMsgId(traceId: string): string {
  // Anthropic 的 id 形如 msg_xxx;心跳走 gw 前缀,UI 里能一眼看出是模拟响应
  return `msg_gwhb_${traceId.replace(/^ccg-/, '').slice(0, 22)}`
}

interface HeartbeatBodyOpts {
  model: string
  traceId: string
  replyText: string
}

export function buildHeartbeatJsonBody({ model, traceId, replyText }: HeartbeatBodyOpts): string {
  return JSON.stringify({
    id: genMsgId(traceId),
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: replyText }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1,
      service_tier: 'standard',
    },
  })
}

function sseEvent(type: string, data: any): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * 真 Anthropic 流式响应 6 段:
 *   message_start → content_block_start → content_block_delta → content_block_stop
 *   → message_delta (含 stop_reason) → message_stop
 * 写完 stream 后必须 res.end() (不要写 [DONE], Anthropic 不发,客户端 SDK 不期望)。
 */
export function writeHeartbeatStream(res: ServerResponse, opts: HeartbeatBodyOpts): void {
  const msgId = genMsgId(opts.traceId)
  const messageStart = {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: opts.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 1,
        service_tier: 'standard',
      },
    },
  }
  res.write(sseEvent('message_start', messageStart))
  res.write(sseEvent('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }))
  res.write(sseEvent('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: opts.replyText },
  }))
  res.write(sseEvent('content_block_stop', {
    type: 'content_block_stop',
    index: 0,
  }))
  res.write(sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  }))
  res.write(sseEvent('message_stop', { type: 'message_stop' }))
  res.end()
}
