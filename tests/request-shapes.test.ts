import { strict as assert } from 'assert'
import {
  applyShapeAutoComplete,
  classifyRequestShape,
  validateRequestShape,
} from '../src/request-shapes.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ✗ ${name}`)
    console.log(`    ${err}`)
  }
}

console.log('\nrequest-shapes')

test('classifies Haiku probe side-query', () => {
  const shape = classifyRequestShape({
    method: 'POST',
    path: '/v1/messages?beta=true',
    headers: { 'user-agent': 'claude-cli/2.1.112 (external, cli)' },
    body: {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [],
    },
  })
  assert.equal(shape.family, 'side_query')
  assert.equal(shape.profile, 'haiku_probe_like')
})

test('classifies Haiku structured-output side-query', () => {
  const shape = classifyRequestShape({
    method: 'POST',
    path: '/v1/messages?beta=true',
    headers: { 'user-agent': 'claude-cli/2.1.112 (external, cli)' },
    body: {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 32000,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [],
      output_config: { format: { type: 'json_schema', schema: {} } },
      temperature: 1,
    },
  })
  assert.equal(shape.family, 'side_query')
  assert.equal(shape.profile, 'haiku_structured_output_like')
})

test('classifies count_tokens path separately', () => {
  const shape = classifyRequestShape({
    method: 'POST',
    path: '/v1/messages/count_tokens?beta=true',
    headers: {},
    body: {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      tools: [],
    },
  })
  assert.equal(shape.family, 'count_tokens')
})

test('classifies compact requests by system prompt', () => {
  const shape = classifyRequestShape({
    method: 'POST',
    path: '/v1/messages?beta=true',
    headers: {},
    body: {
      model: 'claude-sonnet-4-6',
      thinking: { type: 'disabled' },
      tools: [{ name: 'FileReadTool' }],
      system: [{ type: 'text', text: 'You are a helpful AI assistant tasked with summarizing conversations.' }],
    },
  })
  assert.equal(shape.family, 'compact')
  assert.equal(shape.profile, 'compact_summary_like')
})

test('classifies agentic main-thread requests', () => {
  const shape = classifyRequestShape({
    method: 'POST',
    path: '/v1/messages?beta=true',
    headers: { 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20' },
    body: {
      model: 'claude-sonnet-4-6',
      stream: true,
      thinking: { type: 'adaptive' },
      tools: Array.from({ length: 12 }, (_, i) => ({ name: `Tool${i}` })),
      system: [{ type: 'text', text: 'x-anthropic-billing-header: ...' }],
    },
  })
  assert.equal(shape.family, 'repl_main_thread')
})

test('classifies telemetry event batch', () => {
  const shape = classifyRequestShape({
    method: 'POST',
    path: '/api/event_logging/v2/batch',
    headers: {},
    body: { events: [] },
  })
  assert.equal(shape.family, 'telemetry')
  assert.equal(shape.profile, 'event_logging_batch')
})

test('allows compact-like request shape', () => {
  const input = {
    method: 'POST',
    path: '/v1/messages?beta=true',
    headers: {},
    body: {
      model: 'claude-sonnet-4-6',
      thinking: { type: 'disabled' },
      tools: [{ name: 'FileReadTool' }],
      system: [{ type: 'text', text: 'You are a helpful AI assistant tasked with summarizing conversations.' }],
    },
  }
  const shape = classifyRequestShape(input)
  assert.equal(validateRequestShape(input, shape), null)
})

test('allows empty-tools Haiku side-query shape', () => {
  const input = {
    method: 'POST',
    path: '/v1/messages?beta=true',
    headers: {},
    body: {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 32000,
      tools: [],
      output_config: { format: { type: 'json_schema', schema: {} } },
      temperature: 1,
    },
  }
  const shape = classifyRequestShape(input)
  assert.equal(validateRequestShape(input, shape), null)
})

test('rejects empty-tools unknown shape', () => {
  const input = {
    method: 'POST',
    path: '/v1/messages?beta=true',
    headers: {},
    body: {
      model: 'claude-sonnet-4-6',
      tools: [],
      max_tokens: 32000,
    },
  }
  const shape = classifyRequestShape(input)
  assert.ok(validateRequestShape(input, shape)?.includes('empty-tools side-query shape is not allowlisted'))
})

// HAR: gwbk request_logs 2026-04-27 cs / claude-cli 2.1.119, sessionTitle path.
// Carries 'structured-outputs-2025-12-15' beta + output_config.effort, so it
// must be classified as the CC-fingerprinted variant and pass validation.
test('classifies CC-fingerprinted structured-output side-query (beta + effort)', () => {
  const input = {
    method: 'POST',
    path: '/v1/messages?beta=true',
    headers: {
      'user-agent': 'claude-cli/2.1.119 (external, cli)',
      'anthropic-beta':
        'claude-code-20250219,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,'
        + 'context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24,'
        + 'structured-outputs-2025-12-15',
    },
    body: {
      model: 'claude-opus-4-7',
      stream: true,
      tools: [],
      max_tokens: 64000,
      messages: [{ role: 'user', content: 'irrelevant' }],
      output_config: {
        effort: 'xhigh',
        format: { type: 'json_schema', schema: { type: 'object' } },
      },
    },
  }
  const shape = classifyRequestShape(input)
  assert.equal(shape.family, 'side_query')
  assert.equal(shape.profile, 'structured_output_side_query_cc_like')
  assert.equal(validateRequestShape(input, shape), null)
})

// CC-fingerprinted variant must also pass when only the structured-outputs beta
// is present (no effort) — covers older sideQuery callers like findRelevantMemories.
test('classifies CC-fingerprinted structured-output side-query (beta only)', () => {
  const input = {
    method: 'POST',
    path: '/v1/messages?beta=true',
    headers: {
      'user-agent': 'claude-cli/2.1.119 (external, cli)',
      'anthropic-beta': 'claude-code-20250219,structured-outputs-2025-12-15',
    },
    body: {
      model: 'claude-sonnet-4-6',
      stream: true,
      tools: [],
      max_tokens: 256,
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
    },
  }
  const shape = classifyRequestShape(input)
  assert.equal(shape.profile, 'structured_output_side_query_cc_like')
  assert.equal(validateRequestShape(input, shape), null)
})

// Same body shape but no CC beta and no effort — must fall through to the
// generic profile, which is NOT allowlisted (alice's manual SDK test pattern).
test('rejects generic structured-output side-query without CC betas', () => {
  const input = {
    method: 'POST',
    path: '/v1/messages?beta=true',
    headers: {
      'user-agent': 'claude-cli/2.1.119 (external, cli)',
      'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219,prompt-caching-scope-2026-01-05',
    },
    body: {
      model: 'claude-sonnet-4-6',
      stream: true,
      tools: [],
      max_tokens: 10240,
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
    },
  }
  const shape = classifyRequestShape(input)
  assert.equal(shape.profile, 'structured_output_side_query_like')
  const err = validateRequestShape(input, shape)
  assert.ok(err?.includes('structured_output_side_query_like'))
  assert.ok(!err?.includes('cc_like'))
})

// ── shapeAutoComplete (permissive + applyShapeAutoComplete) ──

test('strict reject of toolless_side_query_generic_like', () => {
  const input = {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'user-agent': 'sdk/1.0' },
    body: {
      model: 'claude-sonnet-4-5',
      stream: true,
      tools: [],
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hi' }],
    },
  }
  const shape = classifyRequestShape(input)
  assert.equal(shape.profile, 'toolless_side_query_generic_like')
  assert.ok(validateRequestShape(input, shape)?.includes('toolless_side_query_generic_like'))
  // permissive 也不直接放行 generic_like — 走补字段升级路径
  assert.ok(validateRequestShape(input, shape, { permissive: true })?.includes('toolless_side_query_generic_like'))
})

test('classifies + strictly allows toolless_thinking_active_like (opus + adaptive)', () => {
  // gwbk trace ccg-mp4uizm6:tools=0, thinking=adaptive, opus-4-7, 单条 user prompt
  const input = {
    method: 'POST',
    path: '/v1/messages',
    headers: {},
    body: {
      model: 'claude-opus-4-7',
      stream: true,
      tools: [],
      max_tokens: 10240,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: '请回答下面的近期知识题。1|...' }],
    },
  }
  const shape = classifyRequestShape(input)
  assert.equal(shape.family, 'side_query')
  assert.equal(shape.profile, 'toolless_thinking_active_like')
  // strict allowlist 直接放行,不需要 permissive
  assert.equal(validateRequestShape(input, shape), null)
})

test('toolless_thinking_active_like also matches enabled (not just adaptive)', () => {
  const input = {
    method: 'POST',
    path: '/v1/messages',
    headers: {},
    body: {
      model: 'claude-sonnet-4-6',
      stream: true,
      tools: [],
      thinking: { type: 'enabled' },
      messages: [{ role: 'user', content: 'x' }],
    },
  }
  const shape = classifyRequestShape(input)
  assert.equal(shape.profile, 'toolless_thinking_active_like')
  assert.equal(validateRequestShape(input, shape), null)
})

test('permissive accepts toolless_thinking_disabled_like', () => {
  const input = {
    method: 'POST',
    path: '/v1/messages',
    headers: {},
    body: {
      model: 'claude-sonnet-4-5',
      stream: true,
      tools: [],
      max_tokens: 256,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'hi' }],
    },
  }
  const shape = classifyRequestShape(input)
  assert.equal(shape.profile, 'toolless_thinking_disabled_like')
  assert.ok(validateRequestShape(input, shape)) // strict fail
  assert.equal(validateRequestShape(input, shape, { permissive: true }), null) // permissive pass
})

test('permissive does NOT relax structured_output_side_query_like', () => {
  // 没 CC betas/effort 标记的 SDK structured-output:permissive 也不放行
  const input = {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'anthropic-beta': 'oauth-2025-04-20' },
    body: {
      model: 'claude-sonnet-4-5',
      stream: true,
      tools: [],
      max_tokens: 256,
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
    },
  }
  const shape = classifyRequestShape(input)
  assert.equal(shape.profile, 'structured_output_side_query_like')
  assert.ok(validateRequestShape(input, shape, { permissive: true })?.includes('structured_output_side_query_like'))
})

test('applyShapeAutoComplete fills temperature when no thinking and no temp', () => {
  const body: any = { model: 'haiku', tools: [], max_tokens: 100 }
  const completed = applyShapeAutoComplete(body)
  assert.deepEqual(completed, ['temperature:1'])
  assert.equal(body.temperature, 1)
})

test('applyShapeAutoComplete fills temperature when thinking disabled and no temp', () => {
  const body: any = { thinking: { type: 'disabled' }, tools: [] }
  const completed = applyShapeAutoComplete(body)
  assert.deepEqual(completed, ['temperature:1'])
  assert.equal(body.temperature, 1)
})

test('applyShapeAutoComplete keeps explicit temperature unchanged', () => {
  const body: any = { temperature: 0.7, tools: [] }
  const completed = applyShapeAutoComplete(body)
  assert.deepEqual(completed, [])
  assert.equal(body.temperature, 0.7)
})

test('applyShapeAutoComplete does NOT add temperature when thinking enabled', () => {
  const body: any = { thinking: { type: 'enabled', budget_tokens: 1024 }, tools: [{ name: 'X' }] }
  const completed = applyShapeAutoComplete(body)
  assert.deepEqual(completed, [])
  assert.equal(body.temperature, undefined)
})

test('applyShapeAutoComplete does NOT add temperature when thinking adaptive', () => {
  const body: any = { thinking: { type: 'adaptive' }, tools: [{ name: 'X' }] }
  const completed = applyShapeAutoComplete(body)
  assert.deepEqual(completed, [])
})

test('refined: generic_like + temp补齐 → temperature_one_like', () => {
  const inputBefore = {
    method: 'POST',
    path: '/v1/messages',
    headers: {},
    body: {
      model: 'claude-sonnet-4-5',
      stream: true,
      tools: [],
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hi' }],
    },
  }
  const before = classifyRequestShape(inputBefore)
  assert.equal(before.profile, 'toolless_side_query_generic_like')
  applyShapeAutoComplete(inputBefore.body)
  const after = classifyRequestShape(inputBefore)
  assert.equal(after.profile, 'toolless_side_query_temperature_one_like')
  // 补齐后属于严格 allowlist
  assert.equal(validateRequestShape(inputBefore, after), null)
})

// HAR ccg-mp4vk9za-d2bfbf6bca84:agent-sdk/0.2.128 探测请求,tools>0、no thinking、
// temperature=1 显式发、stream=false、max_tokens=1。classifier 把"显式 temp=1"和
// "不发 temp"视为同一形态 → 命中 tool_assisted_nothinker_like → 严格 allowlist 直接放行。
test('agent-sdk probe: tools>0 + no thinking + temp=1 hits nothinker_like and is strict-allowed', () => {
  const input = {
    method: 'POST',
    path: '/v1/messages?beta=true',
    headers: {
      'user-agent': 'claude-cli/2.1.128 (external, claude-desktop-3p, agent-sdk/0.2.128)',
    },
    body: {
      model: 'claude-haiku-4-5-20251001',
      stream: false,
      max_tokens: 1,
      temperature: 1,
      tools: [
        { name: 'AskUserQuestion' }, { name: 'CronCreate' }, { name: 'CronDelete' },
        { name: 'CronList' }, { name: 'EnterPlanMode' }, { name: 'EnterWorktree' },
        { name: 'ExitPlanMode' }, { name: 'ExitWorktree' },
      ],
      messages: [{ role: 'user', content: 'probe' }],
    },
  }
  const shape = classifyRequestShape(input)
  assert.equal(shape.family, 'side_query')
  assert.equal(shape.profile, 'tool_assisted_nothinker_like')
  // 严格 allowlist 直接放行 — 不需要 shapeAutoComplete 兜底
  assert.equal(validateRequestShape(input, shape), null)
})

// 同一 profile,temperature=undefined(原 permissionExplainer 形态)也要继续命中
test('permissionExplainer: tools>0 + no thinking + no temp also hits nothinker_like', () => {
  const input = {
    method: 'POST',
    path: '/v1/messages',
    headers: {},
    body: {
      model: 'claude-haiku-4-5-20251001',
      tools: [{ name: 'EXPLAIN_COMMAND_TOOL' }],
      messages: [{ role: 'user', content: 'why' }],
    },
  }
  const shape = classifyRequestShape(input)
  assert.equal(shape.profile, 'tool_assisted_nothinker_like')
  assert.equal(validateRequestShape(input, shape), null)
})

// 边界:temperature=0.7 不该归入 nothinker_like(显式非默认值,语义不同)
test('explicit temperature=0.7 with tools+no-thinking does NOT hit nothinker_like', () => {
  const input = {
    method: 'POST',
    path: '/v1/messages',
    headers: {},
    body: {
      model: 'claude-sonnet-4-5',
      tools: [{ name: 'X' }],
      temperature: 0.7,
      messages: [{ role: 'user', content: 'x' }],
    },
  }
  const shape = classifyRequestShape(input)
  assert.notEqual(shape.profile, 'tool_assisted_nothinker_like')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
