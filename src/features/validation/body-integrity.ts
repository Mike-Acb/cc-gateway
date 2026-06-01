import type { Feature, FeatureResult, PipelineContext } from '../types.js'
import { isMessagesNotCountTokens } from '../types.js'
import { normalizeTemperatureForCC, validateThinkingParams } from '../../cc-disguise.js'

/**
 * 静默修复:删除空 text block (text==='' 或非 string)。
 * SDK 发空 text 是常见缺陷 (assistant 直接 tool_use 没文字时,某些 SDK 塞空 text 占位)。
 * Anthropic 上游不接受空 text block,gateway 提前帮客户端删 — 空 text 没信息,无副作用。
 *
 * 返回删除的 (msgIdx, blockIdx) 坐标列表,用于审计。
 */
function fixEmptyTextBlocks(messages: any[]): Array<[number, number]> {
  const fixed: Array<[number, number]> = []
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]
    if (!msg || !Array.isArray(msg.content)) continue
    const kept: any[] = []
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi]
      if (block && typeof block === 'object' && block.type === 'text') {
        const t = block.text
        if (typeof t !== 'string' || t.length === 0) {
          fixed.push([mi, bi])
          continue
        }
      }
      kept.push(block)
    }
    if (kept.length !== msg.content.length) msg.content = kept
  }
  return fixed
}

/**
 * 静默修复:tool_use block 删除非白名单字段 (如 SDK 错塞的 thought_signature)。
 *
 * Anthropic API 对 tool_use block 字段严格白名单:type/id/name/input/cache_control。
 * 任何其他字段都会触发上游 400 "Extra inputs are not permitted"。
 *
 * 已知 SDK 缺陷:某些客户端在历史回传 tool_use 时塞 'thought_signature' (Claude 4.x
 * thinking signature 字段被错挪到 tool_use 上)。HAR 验证真 CC 从不发这字段。
 *
 * 删非白名单字段对请求语义零影响 (Anthropic 本来就忽略它们)。
 */
const ALLOWED_TOOL_USE_FIELDS = new Set(['type', 'id', 'name', 'input', 'cache_control'])

function fixToolUseExtraFields(messages: any[]): Array<[number, number, string[]]> {
  const fixed: Array<[number, number, string[]]> = []
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]
    if (!msg || !Array.isArray(msg.content)) continue
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi]
      if (!block || typeof block !== 'object' || block.type !== 'tool_use') continue
      const extras: string[] = []
      for (const k of Object.keys(block)) {
        if (!ALLOWED_TOOL_USE_FIELDS.has(k)) {
          extras.push(k)
          delete block[k]
        }
      }
      if (extras.length > 0) fixed.push([mi, bi, extras])
    }
  }
  return fixed
}

/**
 * 静默修复:删除缺 signature 的 thinking block。
 *
 * Anthropic API 要求 thinking block 必须带非空 signature 字段(模型签名,
 * 用于上游重放校验)。客户端 SDK 在保存/重组对话历史时若丢失 signature,
 * 这条 thinking block 注定会被上游 reject。
 *
 * 删除该 block 无副作用:思考过程不影响回答语义,只是丢失了那次 thinking
 * 的可见痕迹;assistant 后续 block(text / tool_use)仍保留,模型基于剩余
 * 上下文继续回答。等价于"那次轮回里 model 直接回答没思考"。
 */
function fixUnsignedThinkingBlocks(messages: any[]): Array<[number, number]> {
  const fixed: Array<[number, number]> = []
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]
    if (!msg || !Array.isArray(msg.content)) continue
    const kept: any[] = []
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi]
      if (block && typeof block === 'object' && block.type === 'thinking') {
        const sig = block.signature
        if (typeof sig !== 'string' || sig.length === 0) {
          fixed.push([mi, bi])
          continue
        }
      }
      kept.push(block)
    }
    if (kept.length !== msg.content.length) msg.content = kept
  }
  return fixed
}

/**
 * 静默修复:tool_use.id / tool_result.tool_use_id 含非法字符 → 替换为 `_`,
 * 同对话内 tool_use 和后续 tool_result 同步重写,保持配对。
 *
 * Anthropic API 要求 id 匹配 `^[a-zA-Z0-9_-]+$`。
 * 已知 SDK 缺陷:某些客户端用 OpenAI Function Calling 风格 `functions.Bash:17`
 * 这种含 . / : / 等字符的 id,被 Anthropic 上游 reject。
 *
 * 替换策略:`[^a-zA-Z0-9_-]` → `_`。同 id 多处出现保证替换结果一致。
 * 极端冲突(两个不同旧 id 映射到同一新 id)概率极小,且即使发生,
 * 仅影响日志可读性 — Anthropic 看到的 tool_use/tool_result 仍能配对。
 */
function fixToolUseIdChars(messages: any[]): Array<[number, number, string, string]> {
  const fixed: Array<[number, number, string, string]> = []
  const idMap = new Map<string, string>()  // 第一次遇到非法 id 时建立映射

  const sanitize = (id: string): string => {
    let mapped = idMap.get(id)
    if (mapped) return mapped
    mapped = id.replace(/[^a-zA-Z0-9_-]/g, '_')
    idMap.set(id, mapped)
    return mapped
  }

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]
    if (!msg || !Array.isArray(msg.content)) continue
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi]
      if (!block || typeof block !== 'object') continue
      if (block.type === 'tool_use' && typeof block.id === 'string' && !/^[a-zA-Z0-9_-]+$/.test(block.id)) {
        const oldId = block.id
        block.id = sanitize(oldId)
        fixed.push([mi, bi, oldId, block.id])
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && !/^[a-zA-Z0-9_-]+$/.test(block.tool_use_id)) {
        const oldId = block.tool_use_id
        block.tool_use_id = sanitize(oldId)
        fixed.push([mi, bi, oldId, block.tool_use_id])
      }
    }
  }
  return fixed
}

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

export const bodyIntegrity: Feature = {
  id: 'body-integrity',
  phase: 'inbound-validate',
  appliesTo: isMessagesNotCountTokens,
  run(ctx: PipelineContext): FeatureResult {
    const body = ctx.parsedRequestBody
    if (!body || typeof body !== 'object') return { ok: true }

    if (Array.isArray(body.messages)) {
      // 先做静默修复;剩余非法 block 才走严格校验。
      const tags: string[] = []
      const emptyTextFixed = fixEmptyTextBlocks(body.messages)
      for (const [m, b] of emptyTextFixed) tags.push(`empty_text:${m}.${b}`)
      const toolUseFixed = fixToolUseExtraFields(body.messages)
      for (const [m, b, extras] of toolUseFixed) tags.push(`tool_use_extras:${m}.${b}:${extras.join(',')}`)
      const unsignedThinkingFixed = fixUnsignedThinkingBlocks(body.messages)
      for (const [m, b] of unsignedThinkingFixed) tags.push(`unsigned_thinking:${m}.${b}`)
      const idCharFixed = fixToolUseIdChars(body.messages)
      for (const [m, b, oldId] of idCharFixed) tags.push(`tool_use_id_chars:${m}.${b}:${oldId}`)
      if (tags.length > 0) {
        ctx.autoCompletedFields = [...(ctx.autoCompletedFields ?? []), ...tags]
      }
      const err = validateMessageBlocks(body.messages)
      if (err) return { ok: false, status: 400, reason: err, blockReason: 'malformed_block', blockSource: 'gw' }
    }
    // Temperature normalize 必须在 requestShape feature 之前跑(同 phase,顺序由
    // build.ts 决定 — bodyIntegrity 在 requestShape 之前)。把 temperature 拉到
    // CC 真实分布(thinking active → 删;否则 → 1),让原本 unknown_messages_shape
    // 的请求(如 IDE agent 默认 temperature=0)经修正后命中 agentic_*_t1_like。
    if (ctx.account.options.validate.normalizeTemperature) {
      const tag = normalizeTemperatureForCC(body)
      if (tag) ctx.autoCompletedFields = [...(ctx.autoCompletedFields ?? []), tag]
    }
    const thinkingErr = validateThinkingParams(body)
    if (thinkingErr) return { ok: false, status: 400, reason: thinkingErr, blockReason: 'malformed_block', blockSource: 'gw' }
    return { ok: true }
  },
}
