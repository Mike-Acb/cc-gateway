import { strict as assert } from 'assert'
import { run } from '../../src/pipeline/runner.js'
import { makeCtx } from '../helpers/make-ctx.js'
import type { Feature } from '../../src/features/types.js'

// 短路:第二个 feature 失败,第三个不被调用,blockReason 写入 ctx
{
  const calls: string[] = []
  const f1: Feature = { id: 'a', phase: 'inbound-validate',
    run: () => { calls.push('a'); return { ok: true } } }
  const f2: Feature = { id: 'b', phase: 'inbound-validate',
    run: () => { calls.push('b'); return { ok: false, status: 400, reason: 'x', blockReason: 'y', blockSource: 'gw' } } }
  const f3: Feature = { id: 'c', phase: 'inbound-validate',
    run: () => { calls.push('c'); return { ok: true } } }
  const ctx = makeCtx()
  const r = await run([f1, f2, f3], ctx)
  assert.equal(r.ok, false)
  assert.deepEqual(calls, ['a', 'b'])
  assert.equal(ctx.blockReason, 'y')
  assert.equal(ctx.blockSource, 'gw')
  console.log('✓ runner 短路 + 写 blockReason/blockSource')
}

// appliesTo=false 跳过
{
  const calls: string[] = []
  const f: Feature = { id: 'x', phase: 'inbound-validate',
    appliesTo: () => false,
    run: () => { calls.push('x'); return { ok: true } } }
  const ctx = makeCtx()
  const r = await run([f], ctx)
  assert.equal(r.ok, true)
  assert.deepEqual(calls, [])
  console.log('✓ runner appliesTo=false 跳过')
}

// 全 ok
{
  const f1: Feature = { id: 'a', phase: 'inbound-validate', run: () => ({ ok: true }) }
  const f2: Feature = { id: 'b', phase: 'inbound-validate', run: () => ({ ok: true }) }
  const ctx = makeCtx()
  const r = await run([f1, f2], ctx)
  assert.equal(r.ok, true)
  console.log('✓ runner 全 ok')
}

console.log('\n✅ runner tests passed')
