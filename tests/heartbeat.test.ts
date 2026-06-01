import { strict as assert } from 'assert'
import { isHeartbeatRequest, matchHeartbeat, buildHeartbeatJsonBody } from '../src/heartbeat.js'

const PATH = '/v1/messages'

// 正例:用户给的真实样本
{
  const body = {
    model: 'claude-sonnet-4-6',
    stream: true,
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 5,
  }
  assert.equal(isHeartbeatRequest(PATH, body), true)
  console.log('✓ matches the canonical sample body')
}

// 正例:content 是 [{type:text,text:hello}] 数组形态
{
  const body = {
    model: 'x', stream: true, max_tokens: 5,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  }
  assert.equal(isHeartbeatRequest(PATH, body), true)
  console.log('✓ matches array text-block "hello"')
}

// 正例:各种大小写 / 标点 / 空白
{
  for (const t of ['hi', 'Hi', 'HI', 'hello', 'HELLO', 'Hello', 'Hi!', 'hi.', 'Hi ', ' hi', 'hello?', 'Hello,']) {
    const body = { model: 'x', stream: false, max_tokens: 32000, messages: [{ role: 'user', content: t }] }
    assert.equal(isHeartbeatRequest(PATH, body), true, `expected heartbeat: "${t}"`)
  }
  console.log('✓ all hi/hello casing+punctuation variants matched')
}

// 反例:非白名单的短词
{
  for (const t of ['ping', 'test', 'who are you', '你好', '什么是 LLM?']) {
    const body = { model: 'x', stream: false, max_tokens: 32000, messages: [{ role: 'user', content: t }] }
    assert.equal(isHeartbeatRequest(PATH, body), false, `should NOT be heartbeat: "${t}"`)
  }
  console.log('✓ non-whitelisted short phrases excluded')
}

// 反例:count_tokens 不应触发
{
  const body = { model: 'x', stream: true, max_tokens: 5, messages: [{ role: 'user', content: 'Hi' }] }
  assert.equal(isHeartbeatRequest('/v1/messages/count_tokens', body), false)
  console.log('✓ count_tokens path excluded')
}

// 正例:max_tokens 是业务默认值 (32000),真实心跳客户端不一定调小
// trace 3bb2470f / 898b2824 / b1f5deb1 等真实样本就是这种形态。
{
  const body = { model: 'x', stream: false, max_tokens: 32000, messages: [{ role: 'user', content: 'hi' }] }
  assert.equal(isHeartbeatRequest(PATH, body), true)
  console.log('✓ large max_tokens accepted (real-world heartbeat shape)')
}
// 正例:完全没有 max_tokens 也行
{
  const body = { model: 'x', stream: true, messages: [{ role: 'user', content: 'Hi' }] }
  assert.equal(isHeartbeatRequest(PATH, body), true)
  console.log('✓ missing max_tokens accepted')
}

// 正例:真 CC 形态的心跳 (带 tools/system/metadata,只看 messages)
// 用户提供的真实样本:claude-sonnet-4-6 + tools=[Read] + system="You are Claude Code" + max_tokens=16
{
  const body = {
    model: 'claude-sonnet-4-6',
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    messages: [{ role: 'user', content: 'hi' }],
    metadata: { user_id: '{"device_id":"abc"}' },
    max_tokens: 16,
  }
  assert.equal(isHeartbeatRequest(PATH, body), true)
  console.log('✓ real CC shape with tools+system+metadata accepted (only messages matters)')
}

// 正例:有 thinking 也无所谓
{
  const body = {
    model: 'x', stream: true, max_tokens: 5,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: 'Hi' }],
  }
  assert.equal(isHeartbeatRequest(PATH, body), true)
  console.log('✓ thinking present still accepted')
}

// 反例:多条 message
{
  const body = {
    model: 'x', stream: true, max_tokens: 5,
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
    ],
  }
  assert.equal(isHeartbeatRequest(PATH, body), false)
  console.log('✓ multiple messages excluded')
}

// 反例:assistant 角色
{
  const body = {
    model: 'x', stream: true, max_tokens: 5,
    messages: [{ role: 'assistant', content: 'Hi' }],
  }
  assert.equal(isHeartbeatRequest(PATH, body), false)
  console.log('✓ non-user role excluded')
}

// 反例:长 prompt
{
  const body = {
    model: 'x', stream: true, max_tokens: 5,
    messages: [{ role: 'user', content: 'hello world write me a sonnet' }],
  }
  assert.equal(isHeartbeatRequest(PATH, body), false)
  console.log('✓ long prompt excluded (even when starts with hello)')
}

// 反例:content 含 image block
{
  const body = {
    model: 'x', stream: true, max_tokens: 5,
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'Hi' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ] }],
  }
  assert.equal(isHeartbeatRequest(PATH, body), false)
  console.log('✓ image block in user content excluded')
}

// 非流式正例 — buildHeartbeatJsonBody 形态校验
{
  const json = buildHeartbeatJsonBody({ model: 'claude-sonnet-4-6', traceId: 'ccg-abc-deadbeef', replyText: 'OK' })
  const parsed = JSON.parse(json)
  assert.equal(parsed.type, 'message')
  assert.equal(parsed.role, 'assistant')
  assert.equal(parsed.model, 'claude-sonnet-4-6')
  assert.equal(parsed.stop_reason, 'end_turn')
  assert.deepEqual(parsed.content, [{ type: 'text', text: 'OK' }])
  assert.ok(parsed.id.startsWith('msg_gwhb_'))
  console.log('✓ non-stream JSON body matches Anthropic schema')
}

// ── "reply: X" 协议 ──
{
  // 用户给的真实样本: temperature=0 + content="Reply: OK"
  const body = {
    model: 'claude-sonnet-4-6', stream: true, max_tokens: 128, temperature: 0,
    messages: [{ role: 'user', content: 'Reply: OK' }],
  }
  const r = matchHeartbeat(PATH, body)
  assert.deepEqual(r, { replyText: 'OK' })
  console.log('✓ "Reply: OK" → replyText "OK"')
}
{
  for (const [input, expected] of [
    ['reply: ping', 'ping'],
    ['Reply: 你好', '你好'],
    ['REPLY: alive', 'alive'],
    ['reply:42', '42'],
    ['  reply :  test ', 'test'],
    ['reply:OK', 'OK'],
    ['reply:health-check-v2', 'health-check-v2'],
    ['Reply: hello world', 'hello world'],  // 包含空格但 <50 字
  ] as const) {
    const body = { messages: [{ role: 'user', content: input }] }
    const r = matchHeartbeat(PATH, body)
    assert.deepEqual(r, { replyText: expected }, `input="${input}"`)
  }
  console.log('✓ reply: protocol — multiple casing / payload variants')
}
{
  // 反例:长度 ≥50
  const body = {
    messages: [{ role: 'user', content: 'Reply: ' + 'x'.repeat(60) }],
  }
  assert.equal(matchHeartbeat(PATH, body), null)
  console.log('✓ reply: protocol total length ≥50 excluded')
}
{
  // 反例:reply 后面是空的
  const body = { messages: [{ role: 'user', content: 'Reply:   ' }] }
  assert.equal(matchHeartbeat(PATH, body), null)
  console.log('✓ reply: with empty payload excluded')
}
{
  // 反例:不是以 reply: 开头
  for (const t of ['answer: ok', 'please reply: hi', 'reply this please']) {
    const body = { messages: [{ role: 'user', content: t }] }
    assert.equal(matchHeartbeat(PATH, body), null, `should NOT match: "${t}"`)
  }
  console.log('✓ non-prefix reply text excluded')
}

console.log('\n✅ heartbeat tests passed')
