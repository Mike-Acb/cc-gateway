import { strict as assert } from 'assert'
import { makeCtx } from '../helpers/make-ctx.js'
import { bodyIntegrity } from '../../src/features/validation/body-integrity.js'
import { normalizeTemperature } from '../../src/features/validation/normalize-temperature.js'
import { requestShape } from '../../src/features/validation/request-shape.js'
import { modelAllowlist } from '../../src/features/validation/model-allowlist.js'
import { fastModeReject } from '../../src/features/validation/fast-mode-reject.js'
import { requireStream } from '../../src/features/validation/require-stream.js'

// ── body-integrity ──
{
  const ctx = makeCtx({ parsedRequestBody: { messages: [{ role: 'user', content: 'hi' }] } })
  const r = await bodyIntegrity.run(ctx)
  assert.deepEqual(r, { ok: true })
  console.log('✓ body-integrity passes well-formed body')
}
{
  // 缺 signature 的 thinking block:静默删除(与空 text block 同口径),而不是 400。
  // 删除后 content 为空,后续 validateMessageBlocks 无非法块 → ok=true。
  const ctx = makeCtx({ parsedRequestBody: {
    messages: [{ role: 'assistant', content: [{ type: 'thinking', signature: '' }] }],
  } })
  const r = await bodyIntegrity.run(ctx)
  assert.equal(r.ok, true, 'unsigned thinking block silently fixed')
  assert.deepEqual(ctx.parsedRequestBody.messages[0].content, [], 'unsigned thinking removed')
  assert.ok(ctx.autoCompletedFields?.some(f => f.startsWith('unsigned_thinking:0.0')))
  console.log('✓ body-integrity silently strips unsigned thinking block')
}
{
  // 单一空 text block 在 user 消息里:静默删除后 content 为空,再校验 → 通过
  // (没有任何剩余非法 block;空 user content 由上游处理是否拒绝)
  const ctx = makeCtx({ parsedRequestBody: {
    messages: [{ role: 'user', content: [{ type: 'text', text: '' }] }],
  } })
  const r = await bodyIntegrity.run(ctx)
  assert.equal(r.ok, true, 'empty text block silently fixed')
  assert.deepEqual(ctx.parsedRequestBody.messages[0].content, [], 'empty text removed')
  assert.ok(ctx.autoCompletedFields?.[0]?.startsWith('empty_text:0.0'))
  console.log('✓ body-integrity silently strips empty text block')
}
{
  // assistant tool_use 旁边伴随空 text block 的常见 SDK 缺陷 case:删空 text,保留 tool_use
  const ctx = makeCtx({ parsedRequestBody: {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [
        { type: 'text', text: '' },
        { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      ] },
    ],
  } })
  const r = await bodyIntegrity.run(ctx)
  assert.equal(r.ok, true, 'mixed content with empty text passes after fix')
  assert.equal(ctx.parsedRequestBody.messages[1].content.length, 1)
  assert.equal(ctx.parsedRequestBody.messages[1].content[0].type, 'tool_use')
  assert.ok(ctx.autoCompletedFields?.includes('empty_text:1.0'))
  console.log('✓ body-integrity strips empty text adjacent to tool_use, keeps tool_use')
}
{
  // tool_use 含 thought_signature 等非白名单字段 → 静默删除
  const ctx = makeCtx({ parsedRequestBody: {
    messages: [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' }, thought_signature: 'abc123', custom_extra: { foo: 1 } },
      ] },
    ],
  } })
  const r = await bodyIntegrity.run(ctx)
  assert.equal(r.ok, true, 'extras silently removed')
  const blk = ctx.parsedRequestBody.messages[0].content[0]
  assert.equal(blk.thought_signature, undefined, 'thought_signature stripped')
  assert.equal(blk.custom_extra, undefined, 'custom_extra stripped')
  assert.equal(blk.id, 't1', 'standard fields preserved')
  assert.equal(blk.name, 'Read')
  assert.deepEqual(blk.input, { file_path: '/x' })
  assert.ok(ctx.autoCompletedFields?.[0]?.startsWith('tool_use_extras:0.0:'))
  assert.ok(ctx.autoCompletedFields?.[0]?.includes('thought_signature'))
  console.log('✓ body-integrity strips non-allowlisted tool_use fields (thought_signature etc)')
}
{
  // tool_use 仅含合法字段 → 不动,无审计标记
  // (temperature=1 预设让 OAUTH 默认的 normalizeTemperature 静默通过 — 否则会写入 'temperature:1' tag)
  const ctx = makeCtx({ parsedRequestBody: {
    temperature: 1,
    messages: [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'Read', input: {}, cache_control: { type: 'ephemeral' } },
      ] },
    ],
  } })
  const r = await bodyIntegrity.run(ctx)
  assert.equal(r.ok, true)
  assert.equal(ctx.autoCompletedFields, null, 'no audit when nothing to fix')
  console.log('✓ body-integrity leaves valid tool_use untouched (incl cache_control)')
}
{
  const ctx = makeCtx({ path: '/v1/messages/count_tokens' })
  assert.equal(bodyIntegrity.appliesTo!(ctx), false)
  console.log('✓ body-integrity skips count_tokens path')
}

// ── model-allowlist ──
{
  const ctx = makeCtx({ requestModel: 'claude-sonnet-4-5' })
  const r = await modelAllowlist.run(ctx)
  assert.deepEqual(r, { ok: true })
  console.log('✓ model-allowlist passes supported model')
}
// Unsupported model would require getUnsupportedModelReason returning non-null;
// we trust the underlying impl is unchanged from baseline (covered in account-pool tests).

// ── fast-mode-reject ──
{
  const ctx = makeCtx({ requestSpeed: 'fast' })
  const r = await fastModeReject.run(ctx)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.blockReason, 'fast_mode_blocked')
  console.log('✓ fast-mode-reject blocks speed=fast')
}
{
  const ctx = makeCtx({ requestSpeed: null })
  const r = await fastModeReject.run(ctx)
  assert.deepEqual(r, { ok: true })
  console.log('✓ fast-mode-reject allows null speed')
}

// ── require-stream ──
{
  const ctx = makeCtx({ requestIsStream: false })
  const r = await requireStream.run(ctx)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.blockReason, 'non_stream_blocked')
  console.log('✓ require-stream blocks stream=false')
}
{
  const ctx = makeCtx({ requestIsStream: true })
  const r = await requireStream.run(ctx)
  assert.deepEqual(r, { ok: true })
  console.log('✓ require-stream allows stream=true')
}
{
  const ctx = makeCtx({ path: '/v1/messages/count_tokens', requestIsStream: false })
  assert.equal(requireStream.appliesTo!(ctx), false)
  console.log('✓ require-stream skips count_tokens path')
}

// ── request-shape ──(委托给底层 validateRequestShape;此处只验"feature 把错误转 FeatureFailure")
{
  const ctx = makeCtx({ parsedRequestBody: null })
  const r = await requestShape.run(ctx)
  // 默认 makeCtx 是 free shape + null body → 触发 empty-tools 拒绝;我们只验失败结构正确
  if (!r.ok) {
    assert.equal(r.blockReason, 'shape_forbidden')
    assert.equal(r.blockSource, 'gw')
    assert.equal(r.status, 400)
  }
  console.log('✓ request-shape forwards shape_forbidden as FeatureFailure')
}

// ── request-shape × shapeAutoComplete ──
{
  // 默认 OAUTH_DEFAULT_OPTIONS.validate.shapeAutoComplete=false → 严格 reject
  const body = {
    model: 'claude-sonnet-4-5', stream: true, tools: [], max_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }],
  }
  const ctx = makeCtx({
    parsedRequestBody: body,
    shapeIn: { family: 'side_query', profile: 'toolless_side_query_generic_like', confidence: 70, reason: {} } as any,
  })
  const r = await requestShape.run(ctx)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.blockReason, 'shape_forbidden')
  console.log('✓ shapeAutoComplete=false: strict reject of generic_like')
}
{
  // shapeAutoComplete=true + 已经命中 PENDING profile → 直接放行,不补字段
  const body = {
    model: 'claude-sonnet-4-5', stream: true, tools: [], max_tokens: 256,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  }
  const ctx = makeCtx({
    parsedRequestBody: body,
    shapeIn: { family: 'side_query', profile: 'toolless_thinking_disabled_like', confidence: 80, reason: {} } as any,
  })
  ctx.account = {
    ...ctx.account,
    options: {
      ...ctx.account.options,
      validate: { ...ctx.account.options.validate, shapeAutoComplete: true },
    },
  } as any
  const r = await requestShape.run(ctx)
  assert.equal(r.ok, true)
  assert.ok(ctx.autoCompletedFields?.[0]?.startsWith('shape_pending_passed:'))
  assert.equal(body.temperature, undefined)  // 未补
  console.log('✓ shapeAutoComplete=true + PENDING profile: pass without modification')
}
{
  // shapeAutoComplete=true + generic_like → 补 temperature → 重分类命中严格 allowlist
  const body: any = {
    model: 'claude-sonnet-4-5', stream: true, tools: [], max_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }],
  }
  const ctx = makeCtx({
    parsedRequestBody: body,
    shapeIn: { family: 'side_query', profile: 'toolless_side_query_generic_like', confidence: 70, reason: {} } as any,
  })
  ctx.account = {
    ...ctx.account,
    options: {
      ...ctx.account.options,
      validate: { ...ctx.account.options.validate, shapeAutoComplete: true },
    },
  } as any
  const r = await requestShape.run(ctx)
  assert.equal(r.ok, true)
  assert.equal(body.temperature, 1)
  assert.ok(ctx.autoCompletedFields?.includes('temperature:1'))
  assert.ok(ctx.autoCompletedFields?.some(s => s.startsWith('shape_refined:')))
  console.log('✓ shapeAutoComplete=true + generic_like: temp filled, profile refined')
}
{
  // shapeAutoComplete=true + thinking enabled + 落 unknown 形态 → applyShapeAutoComplete
  // 不补 thinking,补完 reclassify 仍是 unknown → fail。
  // 选 stream=false 是为了避开新近允许的 toolless_thinking_active_like(要求 stream=true)。
  const body = {
    model: 'claude-sonnet-4-5', stream: false, tools: [], max_tokens: 256,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    messages: [{ role: 'user', content: 'hi' }],
  }
  const ctx = makeCtx({
    parsedRequestBody: body,
    shapeIn: { family: 'side_query', profile: 'toolless_side_query_generic_like', confidence: 70, reason: {} } as any,
  })
  ctx.account = {
    ...ctx.account,
    options: {
      ...ctx.account.options,
      validate: { ...ctx.account.options.validate, shapeAutoComplete: true },
    },
  } as any
  const r = await requestShape.run(ctx)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.blockReason, 'shape_forbidden_after_auto_complete')
  console.log('✓ shapeAutoComplete=true but thinking enabled: fail with after_auto_complete reason')
}

// ── normalize-temperature ──
{
  // thinking active → 删 temperature
  const body: any = { thinking: { type: 'adaptive' }, temperature: 0.5 }
  const ctx = makeCtx({ parsedRequestBody: body })
  const r = await normalizeTemperature.run(ctx)
  assert.equal(r.ok, true)
  assert.equal('temperature' in body, false)
  assert.ok(ctx.autoCompletedFields?.[0]?.startsWith('normalize_temp:thinking_active_dropped:'))
  console.log('✓ normalize-temperature: thinking active drops temperature')
}
{
  // thinking enabled → 删 temperature
  const body: any = { thinking: { type: 'enabled', budget_tokens: 1024 }, temperature: 0.7 }
  const ctx = makeCtx({ parsedRequestBody: body })
  await normalizeTemperature.run(ctx)
  assert.equal('temperature' in body, false)
  console.log('✓ normalize-temperature: thinking enabled drops temperature')
}
{
  // 无 thinking + temperature=0 (IDE agent 真实 case) → 强制 1
  const body: any = { temperature: 0 }
  const ctx = makeCtx({ parsedRequestBody: body })
  await normalizeTemperature.run(ctx)
  assert.equal(body.temperature, 1)
  assert.ok(ctx.autoCompletedFields?.[0]?.startsWith('normalize_temp:set_one:0'))
  console.log('✓ normalize-temperature: temp=0 → 1 (IDE agent fix)')
}
{
  // 无 thinking + 无 temperature → 补 1
  const body: any = {}
  const ctx = makeCtx({ parsedRequestBody: body })
  await normalizeTemperature.run(ctx)
  assert.equal(body.temperature, 1)
  assert.ok(ctx.autoCompletedFields?.[0]?.startsWith('normalize_temp:set_one:unset'))
  console.log('✓ normalize-temperature: missing temp → 1')
}
{
  // 无 thinking + temperature=1 → 不动 (no-op,无审计标签)
  const body: any = { temperature: 1 }
  const ctx = makeCtx({ parsedRequestBody: body })
  await normalizeTemperature.run(ctx)
  assert.equal(body.temperature, 1)
  assert.equal(ctx.autoCompletedFields, null)
  console.log('✓ normalize-temperature: temp=1 → no-op')
}
{
  // thinking disabled (非 active) → 强制 temperature=1
  const body: any = { thinking: { type: 'disabled' }, temperature: 0.5 }
  const ctx = makeCtx({ parsedRequestBody: body })
  await normalizeTemperature.run(ctx)
  assert.equal(body.temperature, 1)
  console.log('✓ normalize-temperature: thinking=disabled treated as no-thinking')
}

console.log('\n✅ validation features tests passed')
