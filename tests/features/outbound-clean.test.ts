import { strict as assert } from 'assert'
import { makeCtx } from '../helpers/make-ctx.js'
import { stripCcHeaders } from '../../src/features/outbound-clean/strip-cc-headers.js'
import { stripCcBetaFlags } from '../../src/features/outbound-clean/strip-cc-beta-flags.js'
import { sanitizeSystemText } from '../../src/features/outbound-clean/sanitize-system-text.js'
import { dropMetadata } from '../../src/features/outbound-clean/drop-metadata.js'

// ── strip-cc-headers ──
{
  const ctx = makeCtx({ outboundHeaders: {
    'x-claude-code-foo': 'a',
    'x-stainless-os': 'mac',
    'authorization': 'Bearer x',
    'x-api-key': 'sk-x',
    'cf-ray': 'r',
    'x-forwarded-for': '1.2.3.4',
    'cdn-loop': 'cf',
    'cookie': 'c',
    'x-app': 'cli',
    'content-type': 'application/json',  // 保留
    'user-agent': 'claude-cli/2.1.112',  // 保留(由 override feature 决定)
  } })
  await stripCcHeaders.run(ctx)
  assert.equal(ctx.outboundHeaders['x-claude-code-foo'], undefined)
  assert.equal(ctx.outboundHeaders['x-stainless-os'], undefined)
  assert.equal(ctx.outboundHeaders['authorization'], undefined)
  assert.equal(ctx.outboundHeaders['x-api-key'], undefined)
  assert.equal(ctx.outboundHeaders['cf-ray'], undefined)
  assert.equal(ctx.outboundHeaders['x-forwarded-for'], undefined)
  assert.equal(ctx.outboundHeaders['cdn-loop'], undefined)
  assert.equal(ctx.outboundHeaders['cookie'], undefined)
  assert.equal(ctx.outboundHeaders['x-app'], undefined)
  assert.equal(ctx.outboundHeaders['content-type'], 'application/json')
  assert.equal(ctx.outboundHeaders['user-agent'], 'claude-cli/2.1.112')
  console.log('✓ strip-cc-headers removes blacklist + prefixes; keeps content-type & user-agent')
}

// ── strip-cc-beta-flags ──
{
  const ctx = makeCtx({ outboundHeaders: {
    'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14,prompt-caching-2024-07-31',
  } })
  await stripCcBetaFlags.run(ctx)
  assert.equal(
    ctx.outboundHeaders['anthropic-beta'],
    'interleaved-thinking-2025-05-14,prompt-caching-2024-07-31',
  )
  console.log('✓ strip-cc-beta-flags strips claude-code-* keeps generic betas')
}
{
  const ctx = makeCtx({ outboundHeaders: { 'anthropic-beta': 'claude-code-20250219' } })
  await stripCcBetaFlags.run(ctx)
  assert.equal(ctx.outboundHeaders['anthropic-beta'], undefined)
  console.log('✓ strip-cc-beta-flags deletes header when only CC betas remain')
}
{
  const ctx = makeCtx({ outboundHeaders: {} })
  await stripCcBetaFlags.run(ctx)
  assert.equal(ctx.outboundHeaders['anthropic-beta'], undefined)
  console.log('✓ strip-cc-beta-flags no-op when header absent')
}

// ── sanitize-system-text ──
{
  const ctx = makeCtx({ parsedOutboundBody: {
    system: 'x-anthropic-billing-header: foo\nYou are Claude Code, Anthropic\'s official CLI for Claude.\nReal content',
    messages: [{ role: 'user', content: 'hi' }],
  } })
  await sanitizeSystemText.run(ctx)
  assert.equal(ctx.parsedOutboundBody.system, 'Real content')
  console.log('✓ sanitize-system-text strips billing header + CC intro')
}
{
  const ctx = makeCtx({ parsedOutboundBody: null })
  await sanitizeSystemText.run(ctx)
  assert.equal(ctx.parsedOutboundBody, null)
  console.log('✓ sanitize-system-text no-op on null body')
}

// ── drop-metadata ──
{
  const ctx = makeCtx({ parsedOutboundBody: { messages: [], metadata: { user_id: 'u' } } })
  await dropMetadata.run(ctx)
  assert.equal(ctx.parsedOutboundBody.metadata, undefined)
  assert.deepEqual(ctx.parsedOutboundBody, { messages: [] })
  // outboundBody 也同步更新
  const reparsed = JSON.parse(ctx.outboundBody.toString('utf-8'))
  assert.equal(reparsed.metadata, undefined)
  console.log('✓ drop-metadata removes metadata + syncs outboundBody')
}
{
  const ctx = makeCtx({ parsedOutboundBody: { messages: [] } })
  await dropMetadata.run(ctx)
  assert.deepEqual(ctx.parsedOutboundBody, { messages: [] })
  console.log('✓ drop-metadata no-op when metadata absent')
}

console.log('\n✅ outbound-clean features tests passed')
