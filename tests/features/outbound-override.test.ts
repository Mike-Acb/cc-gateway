import { strict as assert } from 'assert'
import { makeCtx } from '../helpers/make-ctx.js'
import { userAgent } from '../../src/features/outbound-override/user-agent.js'
import { anthropicVersion } from '../../src/features/outbound-override/anthropic-version.js'
import { anthropicBeta } from '../../src/features/outbound-override/anthropic-beta.js'
import { extraHeaders } from '../../src/features/outbound-override/extra-headers.js'

// ── user-agent ──
{
  const ctx = makeCtx({ outboundHeaders: { 'user-agent': 'inbound-cli/1.0' } })
  await userAgent({ mode: 'omit', value: null }).run(ctx)
  assert.equal(ctx.outboundHeaders['user-agent'], undefined)
  console.log('✓ user-agent omit deletes header')
}
{
  const ctx = makeCtx({
    outboundHeaders: {},
    requestHeadersIn: { 'user-agent': 'inbound-cli/1.0' } as any,
  })
  await userAgent({ mode: 'passthrough', value: null }).run(ctx)
  assert.equal(ctx.outboundHeaders['user-agent'], 'inbound-cli/1.0')
  console.log('✓ user-agent passthrough copies inbound')
}
{
  const ctx = makeCtx({ outboundHeaders: { 'user-agent': 'old' } })
  await userAgent({ mode: 'override', value: 'Mozilla/5.0' }).run(ctx)
  assert.equal(ctx.outboundHeaders['user-agent'], 'Mozilla/5.0')
  console.log('✓ user-agent override sets value')
}

// ── anthropic-version ──
{
  const ctx = makeCtx({ outboundHeaders: { 'anthropic-version': '2023-06-01' } })
  await anthropicVersion({ mode: 'omit', value: null }).run(ctx)
  assert.equal(ctx.outboundHeaders['anthropic-version'], undefined)
  console.log('✓ anthropic-version omit deletes')
}
{
  const ctx = makeCtx({ outboundHeaders: {} })
  await anthropicVersion({ mode: 'override', value: '2024-01-01' }).run(ctx)
  assert.equal(ctx.outboundHeaders['anthropic-version'], '2024-01-01')
  console.log('✓ anthropic-version override sets')
}

// ── anthropic-beta(四态)──
{
  const ctx = makeCtx({ outboundHeaders: { 'anthropic-beta': 'foo,bar' } })
  await anthropicBeta({ mode: 'omit', value: null }).run(ctx)
  assert.equal(ctx.outboundHeaders['anthropic-beta'], undefined)
  console.log('✓ anthropic-beta omit deletes')
}
{
  const ctx = makeCtx({ outboundHeaders: {} })
  await anthropicBeta({ mode: 'override', value: 'new-beta' }).run(ctx)
  assert.equal(ctx.outboundHeaders['anthropic-beta'], 'new-beta')
  console.log('✓ anthropic-beta override replaces')
}
{
  const ctx = makeCtx({ outboundHeaders: { 'anthropic-beta': 'existing' } })
  await anthropicBeta({ mode: 'append', value: 'extra' }).run(ctx)
  assert.equal(ctx.outboundHeaders['anthropic-beta'], 'existing,extra')
  console.log('✓ anthropic-beta append concatenates')
}
{
  const ctx = makeCtx({ outboundHeaders: {} })
  await anthropicBeta({ mode: 'append', value: 'extra' }).run(ctx)
  assert.equal(ctx.outboundHeaders['anthropic-beta'], 'extra')
  console.log('✓ anthropic-beta append from empty becomes value')
}

// ── extra-headers ──
{
  const ctx = makeCtx({ outboundHeaders: {} })
  await extraHeaders({ 'X-Pool-Key': 'abc', 'x-custom': 'def' }).run(ctx)
  assert.equal(ctx.outboundHeaders['x-pool-key'], 'abc')
  assert.equal(ctx.outboundHeaders['x-custom'], 'def')
  console.log('✓ extra-headers injects normalized lowercase keys')
}
{
  const ctx = makeCtx({ outboundHeaders: {} })
  await extraHeaders({}).run(ctx)
  assert.deepEqual(ctx.outboundHeaders, {})
  console.log('✓ extra-headers no-op on empty map')
}

console.log('\n✅ outbound-override features tests passed')
