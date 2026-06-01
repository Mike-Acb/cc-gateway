const NO_CONTENT_MESSAGE = '[No message content]'
const ORPHANED_TOOL_RESULT_PLACEHOLDER =
  '[Orphaned tool result removed due to conversation resume]'
const SYNTHETIC_TOOL_RESULT_PLACEHOLDER =
  '[Tool result missing due to internal error]'
const TOOL_INTERRUPTED_PLACEHOLDER = '[Tool use interrupted]'
const TOOL_REFERENCE_DISABLED_PLACEHOLDER =
  '[Tool references removed - tool search not enabled]'
const TOOL_REFERENCE_UNAVAILABLE_PLACEHOLDER =
  '[Tool references removed - tools no longer available]'

type ContentBlock = Record<string, any>
type Message = {
  role: string
  content: string | ContentBlock[]
  id?: string
}

export function stripSignatureBlocks(messages: any[]): any[] {
  let changed = false
  const result = messages.map(message => {
    if (!message || message.role !== 'assistant') return message
    const content = normalizeContent(message.content)
    const filtered = content.filter(
      block => block.type !== 'thinking' && block.type !== 'redacted_thinking',
    )
    if (filtered.length === content.length) return message
    changed = true
    return {
      ...message,
      content: filtered,
    }
  })
  return changed ? result : messages
}

function hasToolSearchEnabled(tools: any[]): boolean {
  return tools.some(
    tool =>
      tool
      && (
        tool.type === 'tool_search_20251015'
        || tool.name === 'tool_search'
        || (typeof tool.type === 'string' && tool.type.startsWith('tool_search_'))
      ),
  )
}

function isEmptyTextBlock(block: any): boolean {
  return !!block
    && typeof block === 'object'
    && block.type === 'text'
    && (typeof block.text !== 'string' || block.text.length === 0)
}

function normalizeContent(content: string | ContentBlock[] | undefined): ContentBlock[] {
  if (typeof content === 'string') {
    // 空字符串 content 不生成 block — Anthropic 拒绝空 text block。
    return content.length === 0 ? [] : [{ type: 'text', text: content }]
  }
  if (!Array.isArray(content)) return []
  // 过滤空 text block (text==='' 或非 string) — 客户端 SDK 缺陷常发空 text 占位,
  // body-integrity 会在 inbound 阶段做相同修复,但 rewriteBody 是基于原始 rawBody
  // 重新 parse 的(proxy.ts:1292),inbound mutation 不传到 outbound。这里是 outbound
  // 路径上的兜底过滤,确保发到 Anthropic 的 message content 永远不含空 text block。
  return content
    .filter(b => !isEmptyTextBlock(b))
    .map(block => ({ ...block }))
}

function isThinkingBlock(block: ContentBlock | undefined): boolean {
  return !!block && (block.type === 'thinking' || block.type === 'redacted_thinking')
}

function isToolReferenceBlock(block: ContentBlock | undefined): boolean {
  return !!block && block.type === 'tool_reference'
}

function isMediaBlock(block: ContentBlock | undefined): boolean {
  return !!block && (block.type === 'image' || block.type === 'document')
}

function normalizeUserTextContent(content: string | ContentBlock[]): ContentBlock[] {
  return normalizeContent(content)
}

function joinTextAtSeam(a: ContentBlock[], b: ContentBlock[]): ContentBlock[] {
  const lastA = a.at(-1)
  const firstB = b[0]
  if (lastA?.type === 'text' && firstB?.type === 'text') {
    return [...a.slice(0, -1), { ...lastA, text: String(lastA.text ?? '') + '\n' }, ...b]
  }
  return [...a, ...b]
}

function hoistToolResults(content: ContentBlock[]): ContentBlock[] {
  const toolResults: ContentBlock[] = []
  const otherBlocks: ContentBlock[] = []
  for (const block of content) {
    if (block.type === 'tool_result') toolResults.push(block)
    else otherBlocks.push(block)
  }
  return [...toolResults, ...otherBlocks]
}

function mergeUserMessages(a: Message, b: Message): Message {
  const merged = joinTextAtSeam(
    normalizeUserTextContent(a.content),
    normalizeUserTextContent(b.content),
  )
  return {
    ...a,
    content: hoistToolResults(merged),
  }
}

function mergeAdjacentMessages(messages: Message[]): Message[] {
  const out: Message[] = []
  for (const raw of messages) {
    const message: Message = { ...raw, content: normalizeContent(raw.content) }
    const prev = out.at(-1)
    if (!prev) {
      out.push(message)
      continue
    }
    if (message.role === 'user' && prev.role === 'user') {
      out[out.length - 1] = mergeUserMessages(prev, message)
      continue
    }
    out.push(message)
  }
  return out
}

function stripUnavailableToolReferencesFromToolResult(
  block: ContentBlock,
  availableToolNames: Set<string>,
): ContentBlock {
  if (block.type !== 'tool_result' || !Array.isArray(block.content)) return block
  const hasToolReference = block.content.some(isToolReferenceBlock)
  if (!hasToolReference) return block

  const filtered = block.content.filter((item: ContentBlock) => {
    if (!isToolReferenceBlock(item)) return true
    const toolName = typeof item.tool_name === 'string' ? item.tool_name : ''
    if (!toolName) return false
    return availableToolNames.has(toolName)
  })

  if (filtered.length === 0) {
    return {
      ...block,
      content: [{ type: 'text', text: availableToolNames.size > 0
        ? TOOL_REFERENCE_UNAVAILABLE_PLACEHOLDER
        : TOOL_REFERENCE_DISABLED_PLACEHOLDER }],
    }
  }
  return { ...block, content: filtered }
}

function stripToolReferencesFromToolResult(
  block: ContentBlock,
): ContentBlock {
  if (block.type !== 'tool_result' || !Array.isArray(block.content)) return block
  const hasToolReference = block.content.some(isToolReferenceBlock)
  if (!hasToolReference) return block

  const filtered = block.content.filter((item: ContentBlock) => !isToolReferenceBlock(item))
  if (filtered.length === 0) {
    return {
      ...block,
      content: [{ type: 'text', text: TOOL_REFERENCE_DISABLED_PLACEHOLDER }],
    }
  }
  return { ...block, content: filtered }
}

function stripCallerFieldFromAssistantMessage(message: Message): Message {
  if (message.role !== 'assistant') return message
  const content = normalizeContent(message.content)
  let changed = false
  const next = content.map(block => {
    if (block.type !== 'tool_use' || !('caller' in block)) return block
    changed = true
    return {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input,
    }
  })
  return changed ? { ...message, content: next } : message
}

function sanitizeErrorToolResultContent(messages: Message[]): Message[] {
  return messages.map(message => {
    if (message.role !== 'user') return message
    const content = normalizeContent(message.content)
    let changed = false
    const next = content.map(block => {
      if (block.type !== 'tool_result' || !block.is_error || !Array.isArray(block.content)) return block
      const textOnly = block.content.filter((item: ContentBlock) => item.type === 'text')
      if (textOnly.length === block.content.length) return block
      changed = true
      return { ...block, content: textOnly }
    })
    return changed ? { ...message, content: next } : message
  })
}

function contentHasToolReference(content: ContentBlock[]): boolean {
  return content.some(
    block =>
      block.type === 'tool_result'
      && Array.isArray(block.content)
      && block.content.some(isToolReferenceBlock),
  )
}

function smooshIntoToolResult(toolResult: ContentBlock, blocks: ContentBlock[]): ContentBlock | null {
  if (blocks.length === 0) return toolResult
  const existing = toolResult.content
  if (Array.isArray(existing) && existing.some(isToolReferenceBlock)) return null

  let incoming = blocks
  if (toolResult.is_error) {
    incoming = blocks.filter(block => block.type === 'text')
    if (incoming.length === 0) return toolResult
  }

  const allText = incoming.every(block => block.type === 'text')
  if (allText && (existing === undefined || typeof existing === 'string')) {
    const joined = [
      typeof existing === 'string' ? existing.trim() : '',
      ...incoming.map(block => String(block.text ?? '').trim()),
    ].filter(Boolean).join('\n\n')
    return { ...toolResult, content: joined }
  }

  const base: ContentBlock[] =
    existing === undefined
      ? []
      : typeof existing === 'string'
        ? (existing.trim() ? [{ type: 'text', text: existing.trim() }] : [])
        : [...existing]
  const merged: ContentBlock[] = []
  for (const block of [...base, ...incoming]) {
    if (block.type === 'text') {
      const text = String(block.text ?? '').trim()
      if (!text) continue
      const prev = merged.at(-1)
      if (prev?.type === 'text') {
        merged[merged.length - 1] = { ...prev, text: `${prev.text}\n\n${text}` }
      } else {
        merged.push({ type: 'text', text })
      }
    } else {
      merged.push(block)
    }
  }
  return { ...toolResult, content: merged }
}

function smooshSystemReminderSiblings(messages: Message[]): Message[] {
  return messages.map(message => {
    if (message.role !== 'user') return message
    const content = normalizeContent(message.content)
    if (!content.some(block => block.type === 'tool_result')) return message

    const systemReminderTexts: ContentBlock[] = []
    const kept: ContentBlock[] = []
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.startsWith('<system-reminder>')) {
        systemReminderTexts.push(block)
      } else {
        kept.push(block)
      }
    }
    if (systemReminderTexts.length === 0) return message

    let lastToolResultIdx = -1
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i]?.type === 'tool_result') {
        lastToolResultIdx = i
        break
      }
    }
    if (lastToolResultIdx < 0) return message
    const merged = smooshIntoToolResult(kept[lastToolResultIdx]!, systemReminderTexts)
    if (!merged) return message

    return {
      ...message,
      content: [...kept.slice(0, lastToolResultIdx), merged, ...kept.slice(lastToolResultIdx + 1)],
    }
  })
}

function filterOrphanedThinkingOnlyMessages(messages: Message[]): Message[] {
  const assistantIdsWithNonThinkingContent = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.id) continue
    const content = normalizeContent(message.content)
    const hasNonThinking = content.some(block => !isThinkingBlock(block))
    if (hasNonThinking) assistantIdsWithNonThinkingContent.add(message.id)
  }

  return messages.filter(message => {
    if (message.role !== 'assistant') return true
    const content = normalizeContent(message.content)
    if (content.length === 0) return true
    const allThinking = content.every(block => isThinkingBlock(block))
    if (!allThinking) return true
    if (message.id && assistantIdsWithNonThinkingContent.has(message.id)) return true
    return false
  })
}

function hasOnlyWhitespaceTextContent(content: ContentBlock[]): boolean {
  if (content.length === 0) return false
  for (const block of content) {
    if (block.type !== 'text') return false
    if (String(block.text ?? '').trim() !== '') return false
  }
  return true
}

function filterTrailingThinkingFromLastAssistant(messages: Message[]): Message[] {
  const lastMessage = messages.at(-1)
  if (!lastMessage || lastMessage.role !== 'assistant') return messages
  const content = normalizeContent(lastMessage.content)
  const lastBlock = content.at(-1)
  if (!isThinkingBlock(lastBlock)) return messages

  let lastValidIndex = content.length - 1
  while (lastValidIndex >= 0 && isThinkingBlock(content[lastValidIndex])) {
    lastValidIndex--
  }
  const nextContent = lastValidIndex < 0
    ? [{ type: 'text', text: NO_CONTENT_MESSAGE }]
    : content.slice(0, lastValidIndex + 1)
  return [...messages.slice(0, -1), { ...lastMessage, content: nextContent }]
}

function filterWhitespaceOnlyAssistantMessages(messages: Message[]): Message[] {
  const filtered = messages.filter(message => {
    if (message.role !== 'assistant') return true
    const content = normalizeContent(message.content)
    if (content.length === 0) return true
    return !hasOnlyWhitespaceTextContent(content)
  })
  return mergeAdjacentMessages(filtered)
}

function ensureNonEmptyAssistantContent(messages: Message[]): Message[] {
  if (messages.length === 0) return messages
  return messages.map((message, index) => {
    if (message.role !== 'assistant') return message
    if (index === messages.length - 1) return message
    const content = normalizeContent(message.content)
    if (content.length > 0) return message
    return {
      ...message,
      content: [{ type: 'text', text: NO_CONTENT_MESSAGE }],
    }
  })
}

/**
 * 静默修复:user message content 为空时塞占位文本。
 *
 * Anthropic 拒绝 `{role:'user', content:[]}` 或 `content:''`。
 * 已知 SDK 缺陷:某些客户端在重组对话历史时塞空 user 消息(中断/取消的轮次)。
 * 不修复就会报 "messages.X: user messages must have non-empty content"。
 *
 * 塞占位无副作用 — 等同于"那一轮用户没说话"(模型可能反问)。所有 user 消息
 * 都处理(包括最后一条) — 最新 user 空 content 通常是客户端 bug,塞占位
 * 让请求过比直接 fail 更友好。
 */
function ensureNonEmptyUserContent(messages: Message[]): Message[] {
  return messages.map(message => {
    if (message.role !== 'user') return message
    const content = normalizeContent(message.content)
    if (content.length > 0) return message
    return {
      ...message,
      content: [{ type: 'text', text: NO_CONTENT_MESSAGE }],
    }
  })
}

function stripExcessMediaItems(messages: Message[], limit = 100): Message[] {
  let toRemove = 0
  for (const message of messages) {
    for (const block of normalizeContent(message.content)) {
      if (isMediaBlock(block)) toRemove++
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (isMediaBlock(nested)) toRemove++
        }
      }
    }
  }
  toRemove -= limit
  if (toRemove <= 0) return messages

  return messages.map(message => {
    if (toRemove <= 0) return message
    const content = normalizeContent(message.content)
    let changed = false
    const next = content
      .map(block => {
        if (toRemove <= 0 || block.type !== 'tool_result' || !Array.isArray(block.content)) return block
        const filtered = block.content.filter((nested: ContentBlock) => {
          if (toRemove > 0 && isMediaBlock(nested)) {
            toRemove--
            changed = true
            return false
          }
          return true
        })
        return filtered.length === block.content.length ? block : { ...block, content: filtered }
      })
      .filter(block => {
        if (toRemove > 0 && isMediaBlock(block)) {
          toRemove--
          changed = true
          return false
        }
        return true
      })
    return changed ? { ...message, content: next } : message
  })
}

/**
 * 客户端 SDK 在重组 thinking + tool_use streaming 时常把 text 重复输出,产生
 * [text, tool_use, text(重复)] 这种畸形结构 (真实 trace ccg-moxta8zc-2972c92fb8f7
 * 中第二个 text 跟第一个字符级完全一致)。Anthropic 上游对历史 assistant 消息有隐式
 * 不变量:含 tool_use 时 content 必须是 [text*, thinking?, tool_use+] 形态,tool_use
 * 之后不能再有 text/thinking/redacted_thinking;否则上游误判该 turn 还在输出,报
 * `tool_use ids were found without tool_result blocks immediately after`(字面是
 * 配对缺失,实际是 block 顺序违规)。
 *
 * 这里只截最后一个 client `tool_use` 之后的纯输出块 — server_tool_use / mcp_tool_use
 * 之后合法跟 server_tool_result,不能误删。
 */
function dropContentAfterFinalToolUse(messages: Message[]): Message[] {
  let changed = false
  const next = messages.map(message => {
    if (message.role !== 'assistant') return message
    const content = normalizeContent(message.content)
    let lastToolUseIdx = -1
    for (let i = content.length - 1; i >= 0; i--) {
      if (content[i]?.type === 'tool_use') {
        lastToolUseIdx = i
        break
      }
    }
    if (lastToolUseIdx < 0) return message
    if (lastToolUseIdx === content.length - 1) return message
    const tail = content.slice(lastToolUseIdx + 1)
    const hasOnlyTextLikeTail = tail.every(b =>
      b.type === 'text' || b.type === 'thinking' || b.type === 'redacted_thinking',
    )
    if (!hasOnlyTextLikeTail) return message
    changed = true
    return { ...message, content: content.slice(0, lastToolUseIdx + 1) }
  })
  return changed ? next : messages
}

function ensureToolResultPairing(messages: Message[]): Message[] {
  const result: Message[] = []
  const allSeenToolUseIds = new Set<string>()

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!

    if (message.role !== 'assistant') {
      const content = normalizeContent(message.content)
      if (message.role === 'user' && result.at(-1)?.role !== 'assistant') {
        const stripped = content.filter(block => block.type !== 'tool_result')
        if (stripped.length !== content.length) {
          const nextContent = stripped.length > 0
            ? stripped
            : result.length === 0
              ? [{ type: 'text', text: ORPHANED_TOOL_RESULT_PLACEHOLDER }]
              : null
          if (nextContent) result.push({ ...message, content: nextContent })
          continue
        }
      }
      result.push({ ...message, content })
      continue
    }

    const content = normalizeContent(message.content)
    const serverResultIds = new Set<string>()
    for (const block of content) {
      if (typeof block.tool_use_id === 'string') serverResultIds.add(block.tool_use_id)
    }

    const seenToolUseIds = new Set<string>()
    const finalContent = content.filter(block => {
      if (block.type === 'tool_use') {
        const id = String(block.id ?? '')
        if (allSeenToolUseIds.has(id)) return false
        allSeenToolUseIds.add(id)
        seenToolUseIds.add(id)
      }
      if (
        (block.type === 'server_tool_use' || block.type === 'mcp_tool_use')
        && typeof block.id === 'string'
        && !serverResultIds.has(block.id)
      ) {
        return false
      }
      return true
    })

    const assistantContent = finalContent.length > 0
      ? finalContent
      : [{ type: 'text', text: TOOL_INTERRUPTED_PLACEHOLDER }]
    const assistantMessage = { ...message, content: assistantContent }
    result.push(assistantMessage)

    const toolUseIds = [...seenToolUseIds]
    const nextMessage = messages[i + 1]
    const existingToolResultIds = new Set<string>()
    let hasDuplicateToolResults = false

    if (nextMessage?.role === 'user') {
      for (const block of normalizeContent(nextMessage.content)) {
        if (block.type === 'tool_result') {
          const id = String(block.tool_use_id ?? '')
          if (existingToolResultIds.has(id)) hasDuplicateToolResults = true
          existingToolResultIds.add(id)
        }
      }
    }

    const toolUseIdSet = new Set(toolUseIds)
    const missingIds = toolUseIds.filter(id => !existingToolResultIds.has(id))
    const orphanedIds = [...existingToolResultIds].filter(id => !toolUseIdSet.has(id))

    if (missingIds.length === 0 && orphanedIds.length === 0 && !hasDuplicateToolResults) {
      continue
    }

    const syntheticBlocks = missingIds.map(id => ({
      type: 'tool_result',
      tool_use_id: id,
      content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
      is_error: true,
    }))

    if (nextMessage?.role === 'user') {
      let nextContent = normalizeContent(nextMessage.content)
      if (orphanedIds.length > 0 || hasDuplicateToolResults) {
        const orphanedSet = new Set(orphanedIds)
        const seenToolResultIds = new Set<string>()
        nextContent = nextContent.filter(block => {
          if (block.type !== 'tool_result') return true
          const id = String(block.tool_use_id ?? '')
          if (orphanedSet.has(id)) return false
          if (seenToolResultIds.has(id)) return false
          seenToolResultIds.add(id)
          return true
        })
      }

      const patched = hoistToolResults([...syntheticBlocks, ...nextContent])
      i++
      if (patched.length > 0) {
        result.push({ ...nextMessage, content: patched })
      } else {
        result.push({ role: 'user', content: [{ type: 'text', text: NO_CONTENT_MESSAGE }] })
      }
    } else if (syntheticBlocks.length > 0) {
      result.push({ role: 'user', content: syntheticBlocks })
    }
  }

  return result
}

export function normalizeMessagesForAPI(
  messages: any[],
  tools: any[] = [],
  options?: { stripSignatures?: boolean; dropTrailingAfterToolUse?: boolean },
): any[] {
  const useToolSearch = hasToolSearchEnabled(tools)
  const availableToolNames = new Set(
    tools
      .map(tool => (typeof tool?.name === 'string' ? tool.name : ''))
      .filter(Boolean),
  )

  const preprocessed = options?.stripSignatures ? stripSignatureBlocks(messages) : messages

  let normalized: Message[] = preprocessed
    .filter(message => message && (message.role === 'user' || message.role === 'assistant'))
    .map(message => {
      const content = normalizeContent(message.content).map(block => {
        if (block.type === 'tool_result') {
          return useToolSearch
            ? stripUnavailableToolReferencesFromToolResult(block, availableToolNames)
            : stripToolReferencesFromToolResult(block)
        }
        return { ...block }
      })
      return {
        ...message,
        content,
      }
    })

  normalized = mergeAdjacentMessages(normalized)
  if (options?.dropTrailingAfterToolUse) {
    normalized = dropContentAfterFinalToolUse(normalized)
  }
  if (!useToolSearch) {
    normalized = normalized.map(stripCallerFieldFromAssistantMessage)
  }
  normalized = filterOrphanedThinkingOnlyMessages(normalized)
  normalized = filterTrailingThinkingFromLastAssistant(normalized)
  normalized = filterWhitespaceOnlyAssistantMessages(normalized)
  normalized = ensureNonEmptyAssistantContent(normalized)
  normalized = ensureNonEmptyUserContent(normalized)
  normalized = smooshSystemReminderSiblings(normalized)
  normalized = sanitizeErrorToolResultContent(normalized)
  normalized = ensureToolResultPairing(normalized)
  normalized = stripExcessMediaItems(normalized)

  return normalized.map(message => ({
    ...message,
    content: normalizeContent(message.content),
  }))
}
