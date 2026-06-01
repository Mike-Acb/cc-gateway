/**
 * Anthropic SSE 流的 tool_use 反向 transform。
 *
 * 配合 non-cc-tool-canon.ts 的请求侧 canonicalize 使用 — 把上游回的
 *   - tool_use.name      PascalCase → 客户端原名 (走 reverseMap)
 *   - tool_use.input     keys snake_case → camelCase
 * 还原回去,让客户端 SDK 拿到的形态跟它发出去的命名风格一致。
 *
 * ── SSE 事件流 ──
 *   event: message_start
 *   data: {...}
 *
 *   event: content_block_start
 *   data: {"type":"content_block_start","index":1,
 *          "content_block":{"type":"tool_use","id":"...","name":"Read","input":{}}}
 *
 *   event: content_block_delta                          ← 多条,partial_json 切片
 *   data: {"type":"content_block_delta","index":1,
 *          "delta":{"type":"input_json_delta","partial_json":"{\"file"}}
 *   ...
 *   event: content_block_stop
 *   data: {"type":"content_block_stop","index":1}
 *
 * ── 策略 ──
 *   1. 按 \n\n 切 event,event 可能跨 chunk → 维护 leftover。
 *   2. content_block_start (tool_use):改 name,记 index→pending。
 *      非 tool_use 块的 start 直接透传。
 *   3. content_block_delta (input_json_delta) 且 index 在 pending:
 *        缓冲 partial_json,**不发**给客户端。
 *      其他 delta (text_delta / thinking_delta):透传,TTFT 不受影响。
 *   4. content_block_stop 且 index 在 pending:
 *        合并 buffer → JSON.parse → keys 反向 (snake_case → camelCase)
 *        → 发 1 条 input_json_delta(partial_json = 完整改写后 JSON)
 *        → 再发原 content_block_stop
 *   5. parse 异常 → 把 buffer 原样吐出再 stop,不阻塞流。
 *
 * 该 transform 只在 reverseMap 非空时挂(账号开了 canonicalizeNonCCTools
 * 且本次确实改写过 tools)— 普通 CC 流量不进这里。
 *
 * 上游必须是明文 SSE(没有 gzip/br)— 调用方负责把 outbound accept-encoding
 * 改为 identity。理由:transform 工作在解码后的文本,挂在 gzip 流上需要先解压
 * 再压缩,代码复杂且重压一遍。canonicalize 仅对小众账号生效,流量量级不值得。
 */
import { Transform } from 'stream'
import { reverseToolUseName, reverseToolUseInput } from './non-cc-tool-canon.js'

interface ToolUseState {
  jsonBuffer: string
}

export function createToolNameReverseTransform(reverseMap: Map<string, string>): Transform {
  let leftover = ''
  const pending = new Map<number, ToolUseState>()

  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const text = leftover + chunk.toString('utf-8')
      const events = text.split(/\n\n/)
      leftover = events.pop() ?? ''

      const outChunks: string[] = []
      for (const rawEvent of events) {
        if (rawEvent.length === 0) continue
        const out = handleEvent(rawEvent, reverseMap, pending)
        if (out !== null) outChunks.push(out + '\n\n')
      }
      if (outChunks.length > 0) this.push(outChunks.join(''))
      cb()
    },
    flush(cb) {
      if (leftover.length > 0) {
        const out = handleEvent(leftover, reverseMap, pending)
        if (out !== null) this.push(out)
      }
      cb()
    },
  })
}

/** 返回要发往客户端的 event 文本;返回 null 表示这个 event 被吞掉(input_json_delta buffered)。 */
function handleEvent(
  rawEvent: string,
  reverseMap: Map<string, string>,
  pending: Map<number, ToolUseState>,
): string | null {
  const lines = rawEvent.split('\n')
  let dataIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('data: ')) { dataIdx = i; break }
  }
  if (dataIdx === -1) return rawEvent  // ping / 空行 / 无 data

  const dataJson = lines[dataIdx].slice(6)
  let parsed: any
  try {
    parsed = JSON.parse(dataJson)
  } catch {
    return rawEvent
  }
  if (!parsed || typeof parsed !== 'object') return rawEvent

  // 1. tool_use 块开头
  //    - name 在 reverseMap 里 (canonicalize 真改过名) → 反向 name + 标 pending,
  //      由后续 delta/stop 把 input keys snake→camel 反向。
  //    - name 不在 map → 完全透传(包括后续 partial_json 增量)。
  //      避免污染同请求里没改过的真 CC 工具(file_path / old_string 被误改成 camelCase
  //      会触发客户端 zod 校验失败,UI 显示 "Invalid tool parameters")。
  //      只有同请求里至少一个工具被 canonicalize(reverseMap.size > 0)时 transform 才被挂上,
  //      所以这里的命中判断决定了具体哪条 tool_use 走反向。
  if (parsed.type === 'content_block_start'
      && parsed.content_block?.type === 'tool_use') {
    const origName = parsed.content_block.name
    if (typeof origName === 'string' && reverseMap.has(origName)) {
      parsed.content_block.name = reverseToolUseName(origName, reverseMap)
      pending.set(parsed.index, { jsonBuffer: '' })
      lines[dataIdx] = 'data: ' + JSON.stringify(parsed)
      return lines.join('\n')
    }
    // 未登记的 tool_use:整块原样透传
    return rawEvent
  }

  // 2. input_json_delta on a pending tool_use → 缓冲,不发
  if (parsed.type === 'content_block_delta'
      && parsed.delta?.type === 'input_json_delta'
      && pending.has(parsed.index)) {
    const state = pending.get(parsed.index)!
    const partial = parsed.delta.partial_json
    if (typeof partial === 'string') state.jsonBuffer += partial
    return null  // 吞掉
  }

  // 3. tool_use 块结束 — flush 反向 input + 原 stop
  if (parsed.type === 'content_block_stop' && pending.has(parsed.index)) {
    const state = pending.get(parsed.index)!
    pending.delete(parsed.index)

    let rewrittenPartial: string
    try {
      const inputObj = state.jsonBuffer.length > 0
        ? JSON.parse(state.jsonBuffer)
        : {}
      const rewritten = reverseToolUseInput(inputObj)
      rewrittenPartial = JSON.stringify(rewritten)
    } catch {
      // JSON 不完整或损坏 → 原样吐 buffer(客户端 SDK 大概率也 parse 失败,
      // 但至少不丢数据)
      rewrittenPartial = state.jsonBuffer
    }

    // 构造一条完整 input 的 input_json_delta + 原 stop
    const deltaEvent = {
      type: 'content_block_delta',
      index: parsed.index,
      delta: { type: 'input_json_delta', partial_json: rewrittenPartial },
    }
    return [
      `event: content_block_delta`,
      `data: ${JSON.stringify(deltaEvent)}`,
      ``,  // intra-event 空行
      rawEvent,  // 原 stop
    ].join('\n')
  }

  // 其他事件透传
  return rawEvent
}
