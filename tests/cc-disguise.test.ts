import { strict as assert } from 'assert'
import {
  disguiseBody,
  resetTemplateCache,
  validateCCRequest,
  NonCCRequestError,
  NoTemplateBoundError,
  _setTemplateCacheForTest,
  buildPlaceholderSubstitutions,
  substitutePlaceholders,
  validateThinkingParams,
  normalizeTemperatureForCC,
} from '../src/cc-disguise.js'

// Fixed synthetic CC 2.1.112 tools & system used across tests. Real templates
// are imported from HAR in production via the admin API; tests just need a
// stable shape with enough CC core tool names to pass validateCCRequest.
const STUB_TOOLS = [
  { name: 'Task', description: 'stub', input_schema: { type: 'object' } },
  { name: 'Bash', description: 'stub', input_schema: { type: 'object' } },
  { name: 'Edit', description: 'stub', input_schema: { type: 'object' } },
  { name: 'Read', description: 'stub', input_schema: { type: 'object' } },
  { name: 'Write', description: 'stub', input_schema: { type: 'object' } },
  { name: 'Glob', description: 'stub', input_schema: { type: 'object' } },
  { name: 'Grep', description: 'stub', input_schema: { type: 'object' } },
]
const STUB_SYSTEM = [
  { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
  { type: 'text', text: "You are an interactive agent that helps users with software engineering tasks." },
]

function seedTemplate(accountId = '_test') {
  _setTemplateCacheForTest(accountId, {
    templateId: `tpl-${accountId}`,
    tools: STUB_TOOLS,
    systemBlocks: STUB_SYSTEM,
    sourceUA: 'claude-cli/2.1.112 (external, cli)',
    loadedAt: Date.now(),
  })
}

// ── Test 1: tools injection from template ──
{
  resetTemplateCache(); seedTemplate()
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [],
    messages: [{ role: 'user', content: 'hello' }],
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.112.abc; cc_entrypoint=cli; cch=00000;' }],
    max_tokens: 4096,
    stream: true,
  }
  await disguiseBody(body, '_test', 'tpl-_test')
  assert.equal(body.tools.length, STUB_TOOLS.length, 'should inject template tools when empty')
  assert.equal(body.tools[0].name, 'Task', 'first tool should be Task')
  console.log(`✓ tools injection from template (${body.tools.length} tools)`)
}

// ── Test 2: tools NOT injected when caller passed some ──
{
  resetTemplateCache(); seedTemplate()
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [{ name: 'MyTool', description: 'custom', input_schema: { type: 'object', properties: {} } }],
    messages: [{ role: 'user', content: 'hello' }],
    system: [],
    max_tokens: 4096,
    stream: true,
  }
  await disguiseBody(body, '_test', 'tpl-_test')
  assert.equal(body.tools.length, 1, 'should not replace non-empty tools')
  assert.equal(body.tools[0].name, 'MyTool', 'should keep original tool')
  console.log('✓ tools preserved when non-empty')
}

// ── Test 2a: aggressiveDisguise=true, 客户端非 CC tools 被强制替换 ──
{
  resetTemplateCache(); seedTemplate()
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [
      { name: 'read' }, { name: 'edit' }, { name: 'write' }, { name: 'exec' },
      { name: 'sessions_list' }, { name: 'sessions_send' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
    system: [],
    max_tokens: 4096,
    stream: true,
  }
  await disguiseBody(body, '_test', 'tpl-_test', null, true)
  assert.equal(body.tools.length, STUB_TOOLS.length, 'non-CC tools replaced with template')
  assert.equal(body.tools[0].name, 'Task')
  console.log('✓ aggressiveDisguise=true: non-CC lowercase tools replaced')
}

// ── Test 2b: aggressiveDisguise=true 但 tools 看起来已是 CC,不动 ──
{
  resetTemplateCache(); seedTemplate()
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [
      { name: 'Read' }, { name: 'Edit' }, { name: 'Bash' }, { name: 'MyExtra' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
    system: [],
    max_tokens: 4096,
    stream: true,
  }
  await disguiseBody(body, '_test', 'tpl-_test', null, true)
  assert.equal(body.tools.length, 4, 'CC-shaped tools preserved')
  assert.equal(body.tools[3].name, 'MyExtra', 'extra tool preserved')
  console.log('✓ aggressiveDisguise=true: CC-shaped tools preserved')
}

// ── Test 2c: aggressiveDisguise=true, context_management 被覆盖 (thinking 存在) ──
{
  resetTemplateCache(); seedTemplate()
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [{ name: 'Task' }, { name: 'Bash' }, { name: 'Read' }],
    thinking: { type: 'enabled', budget_tokens: 1024 },
    context_management: {
      edits: [
        { type: 'compact_20260112' },
        { type: 'clear_thinking_20251015' },
        { type: 'clear_tool_uses_20250919', keep: { type: 'tool_uses', value: 5 } },
      ],
    },
    messages: [{ role: 'user', content: 'hi' }],
    system: [],
    max_tokens: 4096,
    stream: true,
  }
  await disguiseBody(body, '_test', 'tpl-_test', null, true)
  assert.deepEqual(body.context_management, {
    edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
  }, 'context_management replaced with CC standard form')
  console.log('✓ aggressiveDisguise=true: context_management overwritten with CC form')
}

// ── Test 2d: aggressiveDisguise=true, 模型不支持 thinking → 删 context_management ──
{
  resetTemplateCache(); seedTemplate()
  const body: any = {
    // haiku-4-4 不支持 thinking,disguise 不会注入,cm 被删除
    model: 'claude-haiku-4-4',
    tools: [{ name: 'Task' }, { name: 'Bash' }, { name: 'Read' }],
    context_management: { edits: [{ type: 'compact_20260112' }] },
    messages: [{ role: 'user', content: 'hi' }],
    system: [],
    max_tokens: 4096,
    stream: true,
  }
  await disguiseBody(body, '_test', 'tpl-_test', null, true)
  assert.equal(body.context_management, undefined, 'cm deleted when model lacks thinking support')
  assert.equal(body.thinking, undefined, 'thinking not injected for unsupported model')
  console.log('✓ aggressiveDisguise=true: cm deleted when model lacks thinking support')
}

// ── Test 2d2: aggressiveDisguise=true + 模型支持 thinking → disguise 注入 thinking,cm 同步成 standard form ──
// 这是上 fingerprint 场景:CC 真实在 thinking enabled/adaptive 时一定带 cm,缺 cm 就是异常
{
  resetTemplateCache(); seedTemplate()
  const body: any = {
    model: 'claude-haiku-4-5-20251001',  // supportsThinking → disguise 注入 enabled
    tools: [{ name: 'Task' }, { name: 'Bash' }, { name: 'Read' }],
    context_management: { edits: [{ type: 'compact_20260112' }] },
    messages: [{ role: 'user', content: 'hi' }],
    system: [],
    max_tokens: 4096,
    stream: true,
  }
  await disguiseBody(body, '_test', 'tpl-_test', null, true)
  assert.ok(body.thinking, 'thinking injected for thinking-supported model')
  assert.deepEqual(body.context_management, {
    edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
  }, 'cm replaced with CC standard form after thinking injection')
  console.log('✓ aggressiveDisguise=true: cm follows post-disguise thinking state')
}

// ── Test 2f: aggressiveDisguise=true, system 整体重置 (丢弃 OpenClaw + 诱饵) ──
{
  resetTemplateCache(); seedTemplate()
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [{ name: 'Task' }, { name: 'Bash' }, { name: 'Read' }],
    messages: [{ role: 'user', content: 'hi' }],
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.132.499; cc_entrypoint=cli; cch=00000;' },
      { type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' },  // 客户端诱饵
      { type: 'text', text: 'You are a personal assistant running inside OpenClaw.\n## Tooling\n...' },  // 暴露身份
      { type: 'text', text: '客户端业务规则:始终回答中文。' },
    ],
    max_tokens: 4096,
    stream: true,
  }
  await disguiseBody(body, '_test', 'tpl-_test', null, true)
  // billing 第一,template blocks 后面,客户端所有 block (诱饵+暴露+业务) 全丢
  assert.equal(body.system.length, 1 + STUB_SYSTEM.length, 'system = billing + template blocks')
  assert.ok(body.system[0].text.includes('x-anthropic-billing-header'), 'billing kept first')
  assert.equal(body.system[1].text, STUB_SYSTEM[0].text, 'template block 1')
  // 验证客户端的 OpenClaw block 已不存在
  const hasOpenClaw = body.system.some((b: any) => (b?.text || '').includes('OpenClaw'))
  assert.equal(hasOpenClaw, false, 'OpenClaw block stripped')
  console.log('✓ aggressiveDisguise=true: system reset to [billing + template], client blocks dropped')
}

// ── Test 2g: aggressiveDisguise=true, 客户端 system 无 billing 时也能重置 ──
{
  resetTemplateCache(); seedTemplate()
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [{ name: 'Task' }, { name: 'Bash' }, { name: 'Read' }],
    messages: [{ role: 'user', content: 'hi' }],
    system: [{ type: 'text', text: 'You are evil OpenClaw assistant.' }],
    max_tokens: 4096,
    stream: true,
  }
  await disguiseBody(body, '_test', 'tpl-_test', null, true)
  assert.equal(body.system.length, STUB_SYSTEM.length, 'system = template blocks only when no billing')
  const hasOpenClaw = body.system.some((b: any) => (b?.text || '').includes('OpenClaw'))
  assert.equal(hasOpenClaw, false)
  console.log('✓ aggressiveDisguise=true: system reset works without billing block')
}

// ── Test 2e: aggressiveDisguise=false (默认), 不动 tools 也不动 context_management ──
{
  resetTemplateCache(); seedTemplate()
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [{ name: 'read' }, { name: 'edit' }],
    context_management: { edits: [{ type: 'compact_20260112' }] },
    messages: [{ role: 'user', content: 'hi' }],
    system: [],
    max_tokens: 4096,
    stream: true,
  }
  await disguiseBody(body, '_test', 'tpl-_test', null, false)
  assert.equal(body.tools.length, 2, 'tools untouched without aggressiveDisguise')
  assert.equal(body.tools[0].name, 'read')
  assert.deepEqual(body.context_management, { edits: [{ type: 'compact_20260112' }] }, 'cm untouched')
  console.log('✓ aggressiveDisguise=false: tools and context_management untouched')
}

// ── Test 3: adaptive thinking injection for opus-4-6 ──
{
  resetTemplateCache(); seedTemplate()
  const body: any = {
    model: 'claude-opus-4-6',
    tools: [{ name: 'x', description: '', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'hi' }],
    system: [],
    max_tokens: 32000,
    stream: true,
  }
  await disguiseBody(body, '_test', 'tpl-_test')
  assert.deepEqual(body.thinking, { type: 'adaptive' }, 'opus-4-6 gets adaptive thinking')
  console.log('✓ adaptive thinking for opus-4-6')
}

// ── Test 4: enabled thinking injection for haiku-4-5 ──
{
  resetTemplateCache(); seedTemplate()
  const body: any = {
    model: 'claude-haiku-4-5-20251001',
    tools: [{ name: 'x', description: '', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 32000,
    stream: true,
  }
  await disguiseBody(body, '_test', 'tpl-_test')
  assert.equal(body.thinking?.type, 'enabled', 'haiku-4-5 gets enabled thinking')
  assert.equal(body.thinking?.budget_tokens, 31999, 'budget = max_tokens - 1')
  console.log('✓ enabled thinking for haiku-4-5')
}

// ── Test 5: max_tokens floor raised + budget re-derived ──
{
  resetTemplateCache(); seedTemplate()
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [{ name: 'x', description: '', input_schema: { type: 'object' } }],
    messages: [],
    max_tokens: 100,   // below floor
  }
  await disguiseBody(body, '_test', 'tpl-_test')
  assert.ok(body.max_tokens >= 1024, 'max_tokens should be raised to at least 1024')
  console.log(`✓ max_tokens floor (raised to ${body.max_tokens})`)
}

// ── Test 5b: haiku side-query shape does NOT inject thinking ──
{
  resetTemplateCache(); seedTemplate()
  const body: any = {
    model: 'claude-haiku-4-5-20251001',
    tools: [],
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 32000,
    output_config: { format: { type: 'json_schema', schema: {} } },
    temperature: 1,
  }
  await disguiseBody(body, '_test', 'tpl-_test')
  assert.equal(body.thinking, undefined, 'haiku structured-output side-query should keep thinking absent')
  assert.deepEqual(body.tools, [], 'haiku structured-output side-query should keep tools empty')
  console.log('✓ no thinking injection for haiku side-query shape')
}

// ── Test 5c: haiku quota probe keeps system absent and tools undefined ──
{
  resetTemplateCache(); seedTemplate()
  const body: any = {
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: 'quota' }],
    max_tokens: 1,
  }
  await disguiseBody(body, '_test', 'tpl-_test')
  assert.equal(body.system, undefined, 'quota probe should keep system absent')
  assert.equal(body.tools, undefined, 'quota probe should keep tools absent')
  assert.equal(body.thinking, undefined, 'quota probe should keep thinking absent')
  console.log('✓ quota probe keeps system/tools absent')
}

// ── Test 6: system blocks injected when user's system does not contain "You are Claude Code" ──
{
  resetTemplateCache(); seedTemplate()
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [{ name: 'x', description: '', input_schema: { type: 'object' } }],
    messages: [],
    system: [{ type: 'text', text: 'some external system' }],
  }
  await disguiseBody(body, '_test', 'tpl-_test')
  assert.ok(body.system.length > 1, 'template system blocks should be prepended')
  assert.ok(body.system.some((b: any) => (typeof b === 'string' ? b : b?.text ?? '').includes('You are Claude Code')), 'CC system block must be present')
  console.log('✓ system injection when non-CC system present')
}

// ── Test 7: system blocks NOT re-injected when already contains "You are Claude Code" ──
{
  resetTemplateCache(); seedTemplate()
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [{ name: 'x', description: '', input_schema: { type: 'object' } }],
    messages: [],
    system: [{ type: 'text', text: "You are Claude Code, don't touch me" }],
  }
  await disguiseBody(body, '_test', 'tpl-_test')
  assert.equal(body.system.length, 1, 'should NOT re-inject when CC marker already present')
  console.log('✓ system not re-injected')
}

// ── Test 8: system blocks injected after billing header block when present ──
{
  resetTemplateCache(); seedTemplate()
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [{ name: 'x', description: '', input_schema: { type: 'object' } }],
    messages: [],
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.112; cc_entrypoint=cli; cch=00000;' },
      { type: 'text', text: 'user custom block' },
    ],
  }
  await disguiseBody(body, '_test', 'tpl-_test')
  const texts = body.system.map((b: any) => typeof b === 'string' ? b : b?.text ?? '')
  const billingIdx = texts.findIndex((t: string) => t.startsWith('x-anthropic-billing-header:'))
  const ccIdx = texts.findIndex((t: string) => t.includes('You are Claude Code'))
  assert.ok(ccIdx === billingIdx + 1, 'CC block should be inserted directly after billing header')
  console.log('✓ CC blocks inserted after billing header')
}

// ── Test 9: no template bound → throws NoTemplateBoundError ──
{
  resetTemplateCache()
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [],
    messages: [],
  }
  let threw = false
  try {
    await disguiseBody(body, 'unbound-account', null)
  } catch (err) {
    threw = err instanceof NoTemplateBoundError
    if (threw) {
      assert.equal((err as NoTemplateBoundError).accountId, 'unbound-account')
    }
  }
  assert.ok(threw, 'disguiseBody must throw NoTemplateBoundError when account has no template')
  console.log('✓ NoTemplateBoundError on missing template')
}

// ── Test 10: null/non-object body is a no-op (defensive) ──
{
  resetTemplateCache(); seedTemplate()
  await disguiseBody(null, '_test', 'tpl-_test')                // no throw
  await disguiseBody('not an object' as any, '_test', 'tpl-_test')
  console.log('✓ null/non-object body is a no-op')
}

// ── Test 11: validateCCRequest — empty/undefined tools pass through ──
{
  validateCCRequest([], 'acct-empty', 'claude-cli/2.1.112', '1.2.3.4')
  validateCCRequest(undefined, 'acct-empty', 'claude-cli/2.1.112', '1.2.3.4')
  console.log('✓ validateCCRequest: empty/undefined tools pass')
}

// ── looksLikeCCTools 阈值判定 ──
{
  // import 在文件顶,这里直接用
  const { looksLikeCCTools } = await import('../src/cc-disguise.js')
  assert.equal(looksLikeCCTools([]), false)
  assert.equal(looksLikeCCTools(undefined), false)
  assert.equal(looksLikeCCTools([{ name: 'read' }, { name: 'edit' }, { name: 'write' }]), false)  // 小写非 CC
  assert.equal(looksLikeCCTools([{ name: 'Read' }, { name: 'Edit' }]), false)  // 命中 2 < 3 阈值
  assert.equal(looksLikeCCTools([{ name: 'Read' }, { name: 'Edit' }, { name: 'Bash' }]), true)  // 阈值
  assert.equal(looksLikeCCTools([
    { name: 'Read' }, { name: 'Edit' }, { name: 'Write' }, { name: 'my_extra_tool' },
  ]), true)  // CC 子模式带额外工具
  console.log('✓ looksLikeCCTools threshold semantics')
}

// ── Test 11a: validateCCRequest — empty tools + temperature_one_like 不应被拒 ──
// 与 inbound shape gate 严格 allowlist 对齐;补齐升级后的请求要能过这道二级 gate。
{
  validateCCRequest(
    [], 'acct-tone', 'claude-cli/2.1.112', '1.2.3.4',
    { family: 'side_query', profile: 'toolless_side_query_temperature_one_like', confidence: 75, reason: {} },
  )
  validateCCRequest(
    [], 'acct-tone', 'sdk/1.0', '1.2.3.4',
    { family: 'side_query', profile: 'haiku_probe_like', confidence: 100, reason: {} },
  )
  validateCCRequest(
    [], 'acct-tone', 'sdk/1.0', '1.2.3.4',
    { family: 'side_query', profile: 'structured_output_side_query_cc_like', confidence: 90, reason: {} },
  )
  console.log('✓ validateCCRequest: allowsEmptyTools profiles bypass non-CC reject')
}

// ── Test 11b: validateCCRequest — empty tools + non-allowlisted profile 仍拒 ──
{
  try {
    validateCCRequest(
      [], 'acct-bad', 'sdk/1.0', '1.2.3.4',
      { family: 'side_query', profile: 'toolless_side_query_generic_like', confidence: 70, reason: {} },
    )
    assert.fail('should have thrown')
  } catch (err) {
    assert.ok(err instanceof NonCCRequestError)
  }
  console.log('✓ validateCCRequest: empty tools + generic_like still rejected')
}

// ── Test 11pre: disguiseBody 注入 thinking 后清掉 temperature(对齐 CC fingerprint) ──
//   场景:Roo 风格客户端(无 thinking、temperature 已被 inbound normalize 拉到 1)
//   走 sonnet → disguise 注入 adaptive thinking → temperature 必须被删,否则上游
//   会看到 "thinking + temperature=1" 这条非 CC 真实分布的 fingerprint。
{
  resetTemplateCache(); seedTemplate()
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [{ name: 'apply_diff', description: 'roo', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 8192,
    temperature: 1,
  }
  await disguiseBody(body, '_test', 'tpl-_test')
  assert.deepEqual(body.thinking, { type: 'adaptive' }, 'sonnet should get adaptive thinking injected')
  assert.ok(!('temperature' in body), 'temperature must be removed after thinking injected (CC fingerprint)')
  console.log('✓ disguise: drops temperature after thinking injected')
}

// ── Test 11b: validateThinkingParams — top_p only (temperature 不再校验) ──
{
  assert.equal(
    validateThinkingParams({ top_p: 1 }),
    '`top_p` is deprecated and not supported by this model. Remove `top_p` from your request.',
  )
  // temperature 已迁移到 normalizeTemperatureForCC,validateThinkingParams 不再过问
  assert.equal(validateThinkingParams({ thinking: { type: 'adaptive' }, temperature: 1 }), null)
  assert.equal(validateThinkingParams({ temperature: 0.7 }), null)
  assert.equal(validateThinkingParams({ temperature: 1 }), null)
  console.log('✓ validateThinkingParams: top_p only (temperature delegated to normalize)')
}

// ── Test 11c: normalizeTemperatureForCC — CC 真实分布对齐 ──
{
  // thinking active (adaptive) → 删 temperature
  const a: any = { thinking: { type: 'adaptive' }, temperature: 1 }
  assert.equal(normalizeTemperatureForCC(a), 'temperature:omit')
  assert.ok(!('temperature' in a))

  // thinking active (enabled) → 删 temperature
  const b: any = { thinking: { type: 'enabled', budget_tokens: 1024 }, temperature: 0.7 }
  assert.equal(normalizeTemperatureForCC(b), 'temperature:omit')
  assert.ok(!('temperature' in b))

  // thinking disabled → 视作 no thinking,temperature=1
  const c: any = { thinking: { type: 'disabled' }, temperature: 0 }
  assert.equal(normalizeTemperatureForCC(c), 'temperature:1')
  assert.equal(c.temperature, 1)

  // 无 thinking + 无 temperature → 强制 temperature=1
  const d: any = {}
  assert.equal(normalizeTemperatureForCC(d), 'temperature:1')
  assert.equal(d.temperature, 1)

  // 无 thinking + temperature=0 (Roo Code 场景) → 改成 1
  const e: any = { temperature: 0 }
  assert.equal(normalizeTemperatureForCC(e), 'temperature:1')
  assert.equal(e.temperature, 1)

  // 无 thinking + temperature=1 → 不动 (无操作)
  const f: any = { temperature: 1 }
  assert.equal(normalizeTemperatureForCC(f), null)
  assert.equal(f.temperature, 1)

  // thinking active + 无 temperature → 不动
  const g: any = { thinking: { type: 'adaptive' } }
  assert.equal(normalizeTemperatureForCC(g), null)
  assert.ok(!('temperature' in g))

  console.log('✓ normalizeTemperatureForCC: CC distribution rules')
}

// ── Test 12: validateCCRequest — insufficient core match rejects ──
{
  try {
    validateCCRequest([{ name: 'Task' }, { name: 'Bash' }], 'acct-nop', 'Python/3.11', '1.2.3.4')
    assert.fail('should have thrown')
  } catch (err) {
    assert.ok(err instanceof NonCCRequestError, 'must throw NonCCRequestError')
    assert.equal((err as NonCCRequestError).accountId, 'acct-nop')
  }
  console.log('✓ validateCCRequest: insufficient core match rejected')
}

// ── Test 13: validateCCRequest — lowercase tools pass when UA is CC-shaped ──
{
  const openclawTools = [
    { name: 'read' }, { name: 'edit' }, { name: 'write' },
    { name: 'bash' }, { name: 'grep' }, { name: 'glob' },
    { name: 'wiki_search' },
  ]
  validateCCRequest(openclawTools, 'acct-oc', 'claude-cli/2.1.112 (external, cli)', '5.6.7.8')
  console.log('✓ validateCCRequest: lowercase tools allowed under CC-shaped UA fallback')
}

// ── Test 14: validateCCRequest — real CC traffic passes ──
{
  const realCC = [
    { name: 'Task' }, { name: 'Bash' }, { name: 'Edit' }, { name: 'Read' }, { name: 'Write' },
  ]
  validateCCRequest(realCC, 'acct-real', 'claude-cli/2.1.112 (external, cli)', '1.1.1.1')
  console.log('✓ validateCCRequest: genuine CC tools pass')
}

// ── Test 15: buildPlaceholderSubstitutions maps identity + model → placeholders ──
{
  const subs = buildPlaceholderSubstitutions(
    { platform: 'darwin', arch: 'arm64', node_version: 'v24.3.0', terminal: 'iTerm.app', version: '2.1.112' },
    { platform: 'darwin', shell: 'zsh', os_version: 'Darwin 24.3.0', home_prefix: '/Users/dev/' },
    'acct-subs',
    'claude-opus-4-7',
  )
  assert.ok(subs.CWD.startsWith('/Users/dev/workspace-'), 'CWD derived from home_prefix')
  assert.equal(subs.PLATFORM, 'darwin')
  assert.equal(subs.SHELL, 'zsh')
  assert.equal(subs.OS_VERSION, 'Darwin 24.3.0')
  assert.equal(subs.MODEL_ID, 'claude-opus-4-7')
  assert.equal(subs.MODEL_MARKETING, 'Opus 4.7')
  assert.equal(subs.CUTOFF, 'January 2026')
  console.log('✓ buildPlaceholderSubstitutions produces correct mapping')
}

// ── Test 16: buildPlaceholderSubstitutions falls back sanely when promptEnv missing ──
{
  const subs = buildPlaceholderSubstitutions(null, null, 'acct-fb', 'claude-sonnet-4-6')
  assert.equal(subs.PLATFORM, 'darwin')
  assert.equal(subs.SHELL, 'zsh')
  assert.equal(subs.OS_VERSION, 'Darwin 24.3.0')
  assert.ok(subs.CWD.startsWith('/Users/dev/workspace-'), 'fallback home_prefix')
  assert.equal(subs.MODEL_MARKETING, 'Sonnet 4.6')
  assert.equal(subs.CUTOFF, 'August 2025')
  console.log('✓ buildPlaceholderSubstitutions null fallback')
}

// ── Test 17: substitutePlaceholders prefers subs, falls back to HAR default ──
{
  const subs = { CWD: '/Users/x/proj', PLATFORM: 'linux', MODEL_ID: '' /* empty = treated as missing */ }
  const tpl = [
    'cwd={{CWD}}',
    'plat={{PLATFORM|darwin}}',
    'shell={{SHELL|zsh}}',                 // no sub → use default
    'model={{MODEL_ID|claude-opus-4-7}}',  // empty sub → use default
    'unknown={{UNKNOWN}}',                 // no sub, no default → drop
  ].join(' ')
  const out = substitutePlaceholders(tpl, subs)
  assert.equal(
    out,
    'cwd=/Users/x/proj plat=linux shell=zsh model=claude-opus-4-7 unknown=',
    'runtime values win; missing/empty fall through to HAR default; totally-unknown drops to empty',
  )
  console.log('✓ substitutePlaceholders: runtime > HAR default > drop')
}

// ── Test 18: disguiseBody resolves placeholders in template blocks ──
{
  resetTemplateCache()
  const envTemplate = [
    '# Environment',
    'You have been invoked in the following environment: ',
    ' - Primary working directory: {{CWD}}',
    '  - Is a git repository: true',
    ' - Platform: {{PLATFORM}}',
    ' - Shell: {{SHELL}}',
    ' - OS Version: {{OS_VERSION}}',
    ' - You are powered by the model named {{MODEL_MARKETING}}. The exact model ID is {{MODEL_ID}}.',
    ' - Assistant knowledge cutoff is {{CUTOFF}}.',
    " - The most recent Claude model family is Claude 4.X. Model IDs — Opus 4.7: 'claude-opus-4-7', Sonnet 4.6: 'claude-sonnet-4-6', Haiku 4.5: 'claude-haiku-4-5-20251001'. When building AI applications, default to the latest and most capable Claude models.",
  ].join('\n')
  _setTemplateCacheForTest('acct-sub', {
    templateId: 'tpl-sub',
    tools: STUB_TOOLS,
    systemBlocks: [
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: 'text', text: 'core body', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `# Text output\nfoo\n\n${envTemplate}\n\nWhen working with tool results, ...` },
    ],
    sourceUA: 'claude-cli/2.1.112 (external, cli)',
    loadedAt: Date.now(),
  })
  const body: any = {
    model: 'claude-opus-4-7',
    tools: [{ name: 'foo', description: '', input_schema: { type: 'object' } }],
    messages: [],
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.112.abc; cc_entrypoint=cli; cch=00000;' },
    ],
  }
  await disguiseBody(body, 'acct-sub', 'tpl-acct-sub', {
    env: { platform: 'darwin', arch: 'arm64', node_version: 'v24.3.0', terminal: 'iTerm.app', version: '2.1.112' },
    promptEnv: { platform: 'darwin', shell: 'zsh', os_version: 'Darwin 24.3.0', home_prefix: '/Users/dev/' },
  })
  assert.equal(body.system.length, 4, 'billing + 3 template blocks = 4 total')
  const last = body.system[3].text
  assert.ok(!last.includes('{{CWD}}'), 'CWD placeholder must be resolved')
  assert.ok(!last.includes('{{PLATFORM}}'), 'PLATFORM placeholder must be resolved')
  assert.ok(last.includes('Primary working directory: /Users/dev/workspace-'), 'real cwd value substituted')
  assert.ok(last.includes('Platform: darwin'), 'real platform substituted')
  assert.ok(last.includes('You are powered by the model named Opus 4.7. The exact model ID is claude-opus-4-7.'), 'model line substituted from body.model')
  assert.ok(last.includes('Assistant knowledge cutoff is January 2026.'), 'cutoff substituted for opus-4-7')
  assert.ok(last.includes("Claude 4.X. Model IDs — Opus 4.7:"), 'CC-version static text preserved verbatim')
  assert.equal(body.system[2].cache_control?.type, 'ephemeral', 'core block cache_control preserved')
  console.log('✓ disguiseBody substitutes placeholders across template blocks')
}

// ── Test 19: unknown model id falls back to HAR-captured marketing/cutoff defaults ──
// This is the "what if body.model is something we don't recognize" scenario
// that would otherwise produce malformed sentences. The template's HAR-captured
// defaults must cover the gap.
{
  resetTemplateCache()
  _setTemplateCacheForTest('acct-unk', {
    templateId: 'tpl-unk',
    tools: STUB_TOOLS,
    systemBlocks: [
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
      {
        type: 'text',
        text: [
          'You are powered by the model named {{MODEL_MARKETING|Opus 4.7}}.',
          'The exact model ID is {{MODEL_ID|claude-opus-4-7}}.',
          'Assistant knowledge cutoff is {{CUTOFF|January 2026}}.',
        ].join('\n'),
      },
    ],
    sourceUA: 'claude-cli/2.1.112 (external, cli)',
    loadedAt: Date.now(),
  })
  const body: any = {
    model: 'claude-future-9000',  // gateway has no marketing/cutoff for this
    tools: [{ name: 'foo', description: '', input_schema: { type: 'object' } }],
    messages: [],
    system: [{ type: 'text', text: 'x-anthropic-billing-header: x' }],
  }
  await disguiseBody(body, 'acct-unk', 'tpl-acct-unk', {
    env: { platform: 'darwin', arch: 'arm64', node_version: 'v24.3.0', terminal: 'iTerm.app', version: '2.1.112' },
    promptEnv: { platform: 'darwin', shell: 'zsh', os_version: 'Darwin 24.3.0', home_prefix: '/Users/dev/' },
  })
  const rendered = body.system[2].text
  // MODEL_ID should be the actual body.model (buildPlaceholderSubstitutions
  // copies modelId verbatim, since that's the Anthropic-server-facing truth).
  assert.ok(rendered.includes('The exact model ID is claude-future-9000.'), 'MODEL_ID always wins from body.model')
  // MODEL_MARKETING/CUTOFF derivation fails for truly exotic ids → fall back
  // to the template's HAR default ("Opus 4.7" / "January 2026").
  assert.ok(rendered.includes('named Opus 4.7.'), 'MODEL_MARKETING falls back to HAR default when derivation fails')
  assert.ok(rendered.includes('cutoff is January 2026.'), 'CUTOFF falls back to HAR default when map miss')
  console.log('✓ unknown model uses HAR-captured defaults (no malformed sentences)')
}

// ── Test 20: future CC model ids (not in any table) derive marketing from pattern ──
// Ensures `cc-disguise.ts` does NOT need a code change for future models.
// Covers the most common naming shapes Anthropic has used historically.
{
  const cases: Array<[string, string]> = [
    ['claude-opus-4-7', 'Opus 4.7'],
    ['claude-opus-4-7[1m]', 'Opus 4.7 (1M context)'],
    ['claude-sonnet-4-6', 'Sonnet 4.6'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['claude-opus-5-0', 'Opus 5.0'],                 // hypothetical future
    ['claude-sonnet-4-8[1m]', 'Sonnet 4.8 (1M context)'], // hypothetical future
  ]
  for (const [id, expected] of cases) {
    const subs = buildPlaceholderSubstitutions(null, null, 'acct-derive', id)
    assert.equal(subs.MODEL_MARKETING, expected, `${id} should derive to ${expected}`)
    assert.equal(subs.MODEL_ID, id, `${id}: MODEL_ID must be body.model verbatim`)
  }
  // Truly exotic → empty (falls through to HAR default at substitute time)
  const exotic = buildPlaceholderSubstitutions(null, null, 'acct-exotic', 'foo-bar')
  assert.equal(exotic.MODEL_MARKETING, '', 'exotic model returns empty marketing')
  assert.equal(exotic.MODEL_ID, 'foo-bar', 'exotic model still flows MODEL_ID verbatim')
  console.log('✓ marketing derived from model id pattern (zero-code-change for new models)')
}

console.log('\n✅ cc-disguise tests passed')
