import { strict as assert } from 'assert'
import { createToolNameReverseTransform } from '../src/sse-tool-name-transform.js'

/** 跑 transform,收集所有 push 出来的文本。 */
function run(reverseMap: Map<string, string>, chunks: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = createToolNameReverseTransform(reverseMap)
    const out: string[] = []
    t.on('data', (b: Buffer) => out.push(b.toString('utf-8')))
    t.on('end', () => resolve(out.join('')))
    t.on('error', reject)
    for (const c of chunks) t.write(Buffer.from(c, 'utf-8'))
    t.end()
  })
}

const RM = new Map<string, string>([
  ['Read', 'read'],
  ['Bash', 'exec'],
  ['SessionsSpawn', 'sessions_spawn'],
])

// ── 文本块完全透传 ──
{
  const events = [
    `event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"x"}}\n\n`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  ].join('')
  const out = await run(RM, [events])
  assert.equal(out, events)
  console.log('✓ text-only stream passes through unchanged')
}

// ── tool_use.name 反向 ──
{
  const events = [
    `event: content_block_start\ndata: ${JSON.stringify({
      type:'content_block_start', index:1,
      content_block:{ type:'tool_use', id:'tu_1', name:'Read', input:{} },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type:'content_block_delta', index:1,
      delta:{ type:'input_json_delta', partial_json:'{"file_path":"/a"}' },
    })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type:'content_block_stop', index:1 })}\n\n`,
  ].join('')
  const out = await run(RM, [events])
  // 客户端应当看到:start (name=read) + delta (rewritten partial) + stop
  assert.ok(out.includes('"name":"read"'), 'name reversed')
  // partial_json 是嵌套 JSON 字符串,里面 keys 是被转义的
  assert.ok(out.includes('\\"filePath\\":\\"/a\\"'), 'input keys camelCased inside partial_json')
  assert.ok(!out.includes('\\"file_path\\":\\"/a\\"'), 'no leftover snake key')
  console.log('✓ tool_use name + input reversed end-to-end')
}

// ── partial_json 跨 chunk ──
{
  const startEvent = `event: content_block_start\ndata: ${JSON.stringify({
    type:'content_block_start', index:0,
    content_block:{ type:'tool_use', id:'tu_2', name:'Bash', input:{} },
  })}\n\n`
  const delta = (s: string) => `event: content_block_delta\ndata: ${JSON.stringify({
    type:'content_block_delta', index:0,
    delta:{ type:'input_json_delta', partial_json: s },
  })}\n\n`
  const stop = `event: content_block_stop\ndata: ${JSON.stringify({ type:'content_block_stop', index:0 })}\n\n`
  // 故意切成 4 段,且其中一段把 SSE event 也切了一半
  const fullText = startEvent + delta('{"comm') + delta('and":"ls') + delta(' -la"}') + stop
  const cutPoints = [50, 120, 200, 350]
  const parts: string[] = []
  let last = 0
  for (const p of cutPoints) {
    if (p < fullText.length) { parts.push(fullText.slice(last, p)); last = p }
  }
  parts.push(fullText.slice(last))

  const out = await run(RM, parts)
  assert.ok(out.includes('"name":"exec"'), 'Bash → exec')
  assert.ok(out.includes('\\"command\\":\\"ls -la\\"'), 'input parsed correctly across chunks')
  console.log('✓ partial_json buffered across chunk boundaries')
}

// ── 多个 tool_use 块同流 ──
{
  const mkTU = (idx: number, name: string, partial: string) => [
    `event: content_block_start\ndata: ${JSON.stringify({
      type:'content_block_start', index:idx,
      content_block:{ type:'tool_use', id:'tu_'+idx, name, input:{} },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type:'content_block_delta', index:idx,
      delta:{ type:'input_json_delta', partial_json: partial },
    })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type:'content_block_stop', index:idx })}\n\n`,
  ].join('')
  const stream = mkTU(0, 'Read', '{"file_path":"/a"}') + mkTU(1, 'SessionsSpawn', '{"agent_name":"deep","max_steps":5}')
  const out = await run(RM, [stream])
  assert.ok(out.includes('"name":"read"'))
  assert.ok(out.includes('\\"filePath\\":\\"/a\\"'))
  assert.ok(out.includes('"name":"sessions_spawn"'))
  assert.ok(out.includes('\\"agentName\\":\\"deep\\"'))
  assert.ok(out.includes('\\"maxSteps\\":5'))
  console.log('✓ multiple tool_use blocks (per-index buffering)')
}

// ── 上游 tool_use.name 不在 map 里 (模型自创) — 保留原名 ──
{
  const events =
    `event: content_block_start\ndata: ${JSON.stringify({
      type:'content_block_start', index:0,
      content_block:{ type:'tool_use', id:'tu_x', name:'WeirdTool', input:{} },
    })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({
      type:'content_block_delta', index:0,
      delta:{ type:'input_json_delta', partial_json:'{"someValue":1}' },
    })}\n\n` +
    `event: content_block_stop\ndata: ${JSON.stringify({ type:'content_block_stop', index:0 })}\n\n`
  const out = await run(RM, [events])
  assert.ok(out.includes('"name":"WeirdTool"'), 'unknown name preserved')
  // input keys 仍走 snake→camel (someValue 本就是 camelCase,反向 no-op)
  assert.ok(out.includes('\\"someValue\\":1'), 'input keys still pass-through ok')
  console.log('✓ unknown upstream tool name fall back to original')
}

// ── Regression: reverseMap 里没登记的 tool_use 必须透传 ──
//   场景:同请求里 MCP 工具触发 canonicalize,reverseMap = { McpFoo → mcp__foo__bar },
//   但响应里出现真 CC 的 Edit tool_use — name 不在 map,Edit 的 partial_json
//   (file_path / old_string / new_string) 必须原样透传给客户端,否则 CLI 的
//   zod 校验会拒 (file_path 是 required,filePath 不识别)。
{
  const rmMcpOnly = new Map<string, string>([['McpFooBar', 'mcp__foo__bar']])
  const events =
    `event: content_block_start\ndata: ${JSON.stringify({
      type:'content_block_start', index:0,
      content_block:{ type:'tool_use', id:'tu_e', name:'Edit', input:{} },
    })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({
      type:'content_block_delta', index:0,
      delta:{ type:'input_json_delta', partial_json:'{"file_path":"/a"' },
    })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({
      type:'content_block_delta', index:0,
      delta:{ type:'input_json_delta', partial_json:',"old_string":"x","new_string":"y"}' },
    })}\n\n` +
    `event: content_block_stop\ndata: ${JSON.stringify({ type:'content_block_stop', index:0 })}\n\n`
  const out = await run(rmMcpOnly, [events])
  // name 保留 Edit (没在 map 里)
  assert.ok(out.includes('"name":"Edit"'), 'Edit name preserved')
  // partial_json 增量原样透传 — 保留 snake_case keys,且增量分片不合并
  assert.ok(out.includes('\\"file_path\\":\\"/a\\"'), 'file_path preserved as snake_case')
  assert.ok(out.includes('\\"old_string\\":\\"x\\"'), 'old_string preserved')
  assert.ok(out.includes('\\"new_string\\":\\"y\\"'), 'new_string preserved')
  // 不能出现 camelCase 残留
  assert.ok(!out.includes('"filePath"') && !out.includes('\\"filePath\\"'), 'no camelCase leak')
  assert.ok(!out.includes('"oldString"') && !out.includes('\\"oldString\\"'), 'no camelCase leak')
  // 客户端必须收到 stop
  assert.ok(out.includes('content_block_stop'), 'stop event delivered')
  console.log('✓ unmapped tool_use (CC tool in MCP-canonicalized request) passes through verbatim')
}

// ── 损坏的 partial_json 不阻塞流 ──
{
  const events =
    `event: content_block_start\ndata: ${JSON.stringify({
      type:'content_block_start', index:0,
      content_block:{ type:'tool_use', id:'tu_b', name:'Read', input:{} },
    })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({
      type:'content_block_delta', index:0,
      delta:{ type:'input_json_delta', partial_json:'{"file_path":' },
    })}\n\n` +  // 截断
    `event: content_block_stop\ndata: ${JSON.stringify({ type:'content_block_stop', index:0 })}\n\n`
  const out = await run(RM, [events])
  // name 还是要反向
  assert.ok(out.includes('"name":"read"'))
  // partial 原样发(不能阻塞流 / 不能丢 stop)
  assert.ok(out.includes('content_block_stop'))
  console.log('✓ malformed partial_json does not block stream')
}

// ── empty input (没有 input_json_delta 就直接 stop) ──
{
  const events =
    `event: content_block_start\ndata: ${JSON.stringify({
      type:'content_block_start', index:0,
      content_block:{ type:'tool_use', id:'tu_e', name:'Read', input:{} },
    })}\n\n` +
    `event: content_block_stop\ndata: ${JSON.stringify({ type:'content_block_stop', index:0 })}\n\n`
  const out = await run(RM, [events])
  assert.ok(out.includes('"name":"read"'))
  // 应该插一条 partial_json:"{}" 然后 stop —— partial_json value 是字符串 "{}"
  assert.ok(out.includes('\\"partial_json\\":\\"{}\\"') || out.includes('"partial_json":"{}"'))
  console.log('✓ empty input tool_use emits {} partial then stop')
}

console.log('\n✅ sse-tool-name-transform tests passed')
