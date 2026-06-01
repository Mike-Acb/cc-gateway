import { strict as assert } from 'assert'
import { makeCtx } from '../helpers/make-ctx.js'
import { ccBuildHeaders } from '../../src/features/cc-canonical/build-headers.js'
import { ccRewriteMessagesBody } from '../../src/features/cc-canonical/rewrite-messages-body.js'
import { ccSessionBinding } from '../../src/features/cc-canonical/session-binding.js'

// ── cc-build-headers 守卫 ──
{
  const ctx = makeCtx()
  ;(ctx.account as any).ccTemplateId = null
  const r = await ccBuildHeaders.run(ctx)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.status, 503)
    assert.equal(r.blockReason, 'no_cc_template')
    assert.equal(r.blockSource, 'gw')
  }
  console.log('✓ cc-build-headers ccTemplateId==null → 503 no_cc_template')
}
{
  const ctx = makeCtx()
  ;(ctx.account as any).ccTemplateId = 'tpl-1'
  const r = await ccBuildHeaders.run(ctx)
  assert.deepEqual(r, { ok: true })
  console.log('✓ cc-build-headers ccTemplateId 存在 → ok')
}
{
  const ctx = makeCtx({ path: '/v1/messages/count_tokens' })
  assert.equal(ccBuildHeaders.appliesTo!(ctx), false)
  console.log('✓ cc-build-headers skips count_tokens path')
}

// ── cc-rewrite-messages-body 占位 ──(Phase 4 填 wiring;现在只验 appliesTo + ok 路径)
{
  const ctx = makeCtx()
  const r = await ccRewriteMessagesBody.run(ctx)
  assert.deepEqual(r, { ok: true })
  console.log('✓ cc-rewrite-messages-body ok placeholder (Phase 4 fills wiring)')
}
{
  const ctx = makeCtx({ path: '/v1/messages/count_tokens' })
  assert.equal(ccRewriteMessagesBody.appliesTo!(ctx), false)
  console.log('✓ cc-rewrite-messages-body skips count_tokens path')
}

// ── cc-session-binding ──
{
  const ctx = makeCtx({ sessionKey: 'sess-A' })
  const r = await ccSessionBinding.run(ctx)
  assert.deepEqual(r, { ok: true })
  assert.ok(typeof ctx.derivedSessionId === 'string' && ctx.derivedSessionId.length > 0,
    'derivedSessionId 应被写入')
  console.log('✓ cc-session-binding writes derivedSessionId')
}
{
  const ctx = makeCtx({ path: '/v1/messages/count_tokens' })
  assert.equal(ccSessionBinding.appliesTo!(ctx), false)
  console.log('✓ cc-session-binding skips count_tokens path')
}

console.log('\n✅ cc-canonical features tests passed')
