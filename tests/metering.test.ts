import { strict as assert } from 'assert'
import { applyBillableExclusion } from '../src/metering.js'
import {
  buildBillableExclusionMessagesProbeBody,
  parseMessagesProbeInputTokens,
} from '../src/billable-exclusion.js'
import { resolveTemplateBillableExcludedTokens } from '../src/billable-exclusion-cache.js'
import {
  resolveBillableExcludedTokensForUsage,
  resolveBillableExclusionPreflight,
} from '../src/billable-exclusion-runtime.js'
import {
  normalizeTemplateBillableExcludedModel,
  templateBillableExcludedTokensRedisKey,
} from '../src/billable-exclusion-store.js'
import {
  rewriteJSONUsageForBillableResponse,
  rewriteSSEEventUsage,
} from '../src/response-usage.js'

// Most metering logic is tested inline to avoid DB setup; applyBillableExclusion
// is imported directly because it is pure and has no database dependency at call time.

type UsageData = {
  model: string
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
}

type ModelPrice = {
  modelPattern: string
  inputMtok: number
  outputMtok: number
  cacheReadMtok: number
  cacheWriteMtok: number
}

function calculateCostWith(usage: UsageData, price: ModelPrice | undefined): number {
  if (!price) return 0
  return (
    (usage.inputTokens / 1_000_000) * price.inputMtok +
    (usage.outputTokens / 1_000_000) * price.outputMtok +
    (usage.cacheRead / 1_000_000) * price.cacheReadMtok +
    (usage.cacheWrite / 1_000_000) * price.cacheWriteMtok
  )
}

function parseUsageFromJSON(body: string): UsageData | null {
  try {
    const data = JSON.parse(body)
    if (!data.usage || !data.model) return null
    return {
      model: data.model,
      inputTokens: data.usage.input_tokens ?? 0,
      outputTokens: data.usage.output_tokens ?? 0,
      cacheRead: data.usage.cache_read_input_tokens ?? 0,
      cacheWrite: data.usage.cache_creation_input_tokens ?? 0,
    }
  } catch {
    return null
  }
}

function parseUsageFromSSE(text: string): UsageData | null {
  let model = ''
  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let cacheWrite = 0

  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    try {
      const data = JSON.parse(line.slice(6))
      if (data.type === 'message_start' && data.message) {
        model = data.message.model ?? ''
        if (data.message.usage) {
          inputTokens = data.message.usage.input_tokens ?? 0
          cacheRead = data.message.usage.cache_read_input_tokens ?? 0
          cacheWrite = data.message.usage.cache_creation_input_tokens ?? 0
        }
      }
      if (data.type === 'message_delta' && data.usage) {
        outputTokens = data.usage.output_tokens ?? 0
      }
    } catch {}
  }

  if (!model) return null
  return { model, inputTokens, outputTokens, cacheRead, cacheWrite }
}

let passed = 0
let failed = 0
const pending: Promise<void>[] = []

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

function asyncTest(name: string, fn: () => Promise<void>) {
  pending.push((async () => {
    try {
      await fn()
      passed++
      console.log(`  ✓ ${name}`)
    } catch (err) {
      failed++
      console.log(`  ✗ ${name}`)
      console.log(`    ${err}`)
    }
  })())
}

// ============================================================
console.log('\ncalculateCost')
// ============================================================

const sonnetPrice: ModelPrice = {
  modelPattern: 'claude-sonnet-4-20250514',
  inputMtok: 3,
  outputMtok: 15,
  cacheReadMtok: 0.3,
  cacheWriteMtok: 3.75,
}

test('computes cost correctly with known prices', () => {
  const usage: UsageData = {
    model: 'claude-sonnet-4-20250514',
    inputTokens: 1000,
    outputTokens: 500,
    cacheRead: 2000,
    cacheWrite: 100,
  }
  const cost = calculateCostWith(usage, sonnetPrice)
  // (1000/1M)*3 + (500/1M)*15 + (2000/1M)*0.3 + (100/1M)*3.75
  const expected =
    (1000 / 1_000_000) * 3 +
    (500 / 1_000_000) * 15 +
    (2000 / 1_000_000) * 0.3 +
    (100 / 1_000_000) * 3.75
  assert.equal(cost, expected)
})

test('returns 0 when no price found', () => {
  const usage: UsageData = {
    model: 'unknown-model',
    inputTokens: 1000,
    outputTokens: 500,
    cacheRead: 0,
    cacheWrite: 0,
  }
  const cost = calculateCostWith(usage, undefined)
  assert.equal(cost, 0)
})

test('handles zero tokens', () => {
  const usage: UsageData = {
    model: 'claude-sonnet-4-20250514',
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
  }
  const cost = calculateCostWith(usage, sonnetPrice)
  assert.equal(cost, 0)
})

test('handles large token counts', () => {
  const usage: UsageData = {
    model: 'claude-sonnet-4-20250514',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheRead: 1_000_000,
    cacheWrite: 1_000_000,
  }
  const cost = calculateCostWith(usage, sonnetPrice)
  const expected = 3 + 15 + 0.3 + 3.75
  assert.equal(cost, expected)
})

// ============================================================
console.log('\nparseUsageFromJSON')
// ============================================================

test('parses standard Anthropic JSON response', () => {
  const body = JSON.stringify({
    id: 'msg_123',
    type: 'message',
    model: 'claude-sonnet-4-20250514',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 10,
    },
  })
  const result = parseUsageFromJSON(body)
  assert.deepEqual(result, {
    model: 'claude-sonnet-4-20250514',
    inputTokens: 100,
    outputTokens: 50,
    cacheRead: 200,
    cacheWrite: 10,
  })
})

test('returns null for missing usage field', () => {
  const body = JSON.stringify({ model: 'claude-sonnet-4-20250514' })
  assert.equal(parseUsageFromJSON(body), null)
})

test('returns null for missing model field', () => {
  const body = JSON.stringify({ usage: { input_tokens: 100 } })
  assert.equal(parseUsageFromJSON(body), null)
})

test('returns null for malformed JSON', () => {
  assert.equal(parseUsageFromJSON('not json at all'), null)
})

test('returns null for empty string', () => {
  assert.equal(parseUsageFromJSON(''), null)
})

test('defaults missing token fields to 0', () => {
  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    usage: { input_tokens: 100 },
  })
  const result = parseUsageFromJSON(body)
  assert.ok(result)
  assert.equal(result.outputTokens, 0)
  assert.equal(result.cacheRead, 0)
  assert.equal(result.cacheWrite, 0)
})

// ============================================================
console.log('\napplyBillableExclusion')
// ============================================================

test('deducts excluded template tokens from cache write, then cache read only', () => {
  const usage: UsageData = {
    model: 'claude-sonnet-4-20250514',
    inputTokens: 100,
    outputTokens: 50,
    cacheRead: 30,
    cacheWrite: 20,
  }

  const result = applyBillableExclusion(usage, 65)

  assert.deepEqual(result, {
    model: 'claude-sonnet-4-20250514',
    inputTokens: 100,
    outputTokens: 50,
    cacheRead: 0,
    cacheWrite: 0,
  })
  assert.deepEqual(usage, {
    model: 'claude-sonnet-4-20250514',
    inputTokens: 100,
    outputTokens: 50,
    cacheRead: 30,
    cacheWrite: 20,
  })
})

test('never deducts below zero when excluded template tokens exceed usage', () => {
  const usage: UsageData = {
    model: 'claude-sonnet-4-20250514',
    inputTokens: 10,
    outputTokens: 50,
    cacheRead: 5,
    cacheWrite: 3,
  }

  const result = applyBillableExclusion(usage, 100)

  assert.deepEqual(result, {
    model: 'claude-sonnet-4-20250514',
    inputTokens: 10,
    outputTokens: 50,
    cacheRead: 0,
    cacheWrite: 0,
  })
})

// ============================================================
console.log('\nbillable exclusion messages probe helpers')
// ============================================================

test('builds messages probe body from fixed template context only', () => {
  const outbound = Buffer.from(JSON.stringify({
    model: 'claude-sonnet-4-5',
    system: [{ type: 'text', text: 'template system' }],
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'real user prompt that must not be counted' }],
    max_tokens: 32000,
  }))

  const result = buildBillableExclusionMessagesProbeBody(outbound, 'claude-sonnet-4-5')

  assert.deepEqual(result, {
    model: 'claude-sonnet-4-5',
    max_tokens: 1,
    stream: false,
    system: [{ type: 'text', text: 'template system' }],
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'ping' }],
  })
})

test('returns null messages probe body when outbound body has no fixed template context', () => {
  const outbound = Buffer.from(JSON.stringify({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'hello' }],
  }))

  assert.equal(buildBillableExclusionMessagesProbeBody(outbound, 'claude-sonnet-4-5'), null)
})

test('parses messages probe input-side usage responses', () => {
  assert.equal(parseMessagesProbeInputTokens('{"usage":{"input_tokens":123.9,"cache_creation_input_tokens":5,"cache_read_input_tokens":"7"}}'), 135)
  assert.equal(parseMessagesProbeInputTokens('{"input_tokens":123}'), null)
  assert.equal(parseMessagesProbeInputTokens('not json'), null)
})

test('normalizes dated response model ids for billable exclusion cache keys', () => {
  assert.equal(
    normalizeTemplateBillableExcludedModel('claude-haiku-4-5-20251001'),
    'claude-haiku-4-5',
  )
  assert.equal(
    templateBillableExcludedTokensRedisKey('tpl_1', 'claude-haiku-4-5-20251001'),
    templateBillableExcludedTokensRedisKey('tpl_1', 'claude-haiku-4-5'),
  )
})

test('rewrites JSON response usage to billable usage', () => {
  const original = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    usage: {
      input_tokens: 507,
      output_tokens: 72,
      cache_read_input_tokens: 23936,
      cache_creation_input_tokens: 1755,
    },
  })

  const result = rewriteJSONUsageForBillableResponse(original, 26044)
  const parsed = JSON.parse(result.text)

  assert.equal(result.rewritten, true)
  assert.equal(parsed.usage.cache_creation_input_tokens, 0)
  assert.equal(parsed.usage.cache_read_input_tokens, 0)
  assert.equal(parsed.usage.input_tokens, 507)
  assert.equal(parsed.usage.output_tokens, 72)
})

test('rewrites SSE message_start usage to billable usage', () => {
  const event = [
    'event: message_start',
    `data: ${JSON.stringify({
      type: 'message_start',
      message: {
        model: 'claude-haiku-4-5-20251001',
        usage: {
          input_tokens: 507,
          output_tokens: 0,
          cache_read_input_tokens: 23936,
          cache_creation_input_tokens: 1755,
        },
      },
    })}`,
  ].join('\n')

  const rewritten = rewriteSSEEventUsage(event, 26044, 'claude-haiku-4-5')
  const dataLine = rewritten.split('\n').find((line) => line.startsWith('data: '))
  const parsed = JSON.parse(dataLine!.slice(6))

  assert.equal(parsed.message.usage.cache_creation_input_tokens, 0)
  assert.equal(parsed.message.usage.cache_read_input_tokens, 0)
  assert.equal(parsed.message.usage.input_tokens, 507)
})

asyncTest('does not call messages probe on Redis miss unless auto calculation is enabled', async () => {
  let calculated = 0
  const result = await resolveTemplateBillableExcludedTokens({
    templateId: 'tpl_1',
    model: 'claude-sonnet-4-5',
    outboundBody: Buffer.from('{"system":"fixed","messages":[{"role":"user","content":"hi"}]}'),
    upstream: new URL('https://api.anthropic.com'),
    headers: { authorization: 'Bearer token' },
  }, {
    read: async () => ({ hit: false, value: 0 }),
    write: async () => { throw new Error('should not write') },
    isRedisAvailable: () => true,
    getRedis: () => ({
      get: async () => null,
      set: async () => { throw new Error('should not lock') },
      del: async () => 1,
    }),
    calculate: async () => {
      calculated++
      return 77
    },
    sleep: async () => {},
    shouldAutoCalculate: () => false,
  })

  assert.equal(result, 0)
  assert.equal(calculated, 0)
})

asyncTest('computes and stores billable exclusion on Redis miss when auto calculation is enabled', async () => {
  const writes: Array<{ templateId: string; model: string; tokens: number }> = []
  const sleeps: number[] = []
  let calculated = 0
  const result = await resolveTemplateBillableExcludedTokens({
    templateId: 'tpl_1',
    model: 'claude-sonnet-4-5',
    outboundBody: Buffer.from('{"system":"fixed","messages":[{"role":"user","content":"hi"}]}'),
    upstream: new URL('https://api.anthropic.com'),
    headers: { authorization: 'Bearer token' },
  }, {
    read: async () => ({ hit: false, value: 0 }),
    write: async (templateId, model, tokens) => { writes.push({ templateId, model, tokens }) },
    isRedisAvailable: () => true,
    getRedis: () => ({
      get: async () => null,
      set: async () => 'OK',
      del: async () => 1,
    }),
    calculate: async () => {
      calculated++
      return 77
    },
    sleep: async (ms) => { sleeps.push(ms) },
    shouldAutoCalculate: () => true,
    random: () => 0.5,
  })

  assert.equal(result, 77)
  assert.equal(calculated, 1)
  assert.deepEqual(writes, [{ templateId: 'tpl_1', model: 'claude-sonnet-4-5', tokens: 77 }])
  assert.deepEqual(sleeps, [2000])
})

asyncTest('sets a short cooldown when messages probe calculation fails', async () => {
  const redisSets: Array<{ key: string; value: string; mode: string; seconds: number; flag?: string }> = []
  const result = await resolveTemplateBillableExcludedTokens({
    templateId: 'tpl_1',
    model: 'claude-sonnet-4-5',
    outboundBody: Buffer.from('{"system":"fixed","messages":[{"role":"user","content":"hi"}]}'),
    upstream: new URL('https://api.anthropic.com'),
    headers: { authorization: 'Bearer token' },
  }, {
    read: async () => ({ hit: false, value: 0 }),
    write: async () => { throw new Error('should not write') },
    isRedisAvailable: () => true,
    getRedis: () => ({
      get: async () => null,
      set: async (key: string, value: string, mode: 'EX', seconds: number, flag?: 'NX') => {
        redisSets.push({ key, value, mode, seconds, flag })
        return 'OK'
      },
      del: async () => 1,
    }),
    calculate: async () => null,
    sleep: async () => {},
    shouldAutoCalculate: () => true,
  })

  assert.equal(result, 0)
  assert.ok(redisSets.some((s) =>
    s.key.includes('cc_disguise_template_billable_excluded_cooldown')
    && s.value === '1'
    && s.mode === 'EX'
    && s.seconds === 60
  ))
})

asyncTest('returns cached billable exclusion without messages probe calls', async () => {
  let calculated = 0
  const sleeps: number[] = []
  const result = await resolveTemplateBillableExcludedTokens({
    templateId: 'tpl_1',
    model: 'claude-sonnet-4-5',
    outboundBody: Buffer.from('{}'),
    upstream: new URL('https://api.anthropic.com'),
    headers: {},
  }, {
    read: async () => ({ hit: true, value: 12 }),
    write: async () => { throw new Error('should not write') },
    isRedisAvailable: () => true,
    getRedis: () => ({
      get: async () => null,
      set: async () => { throw new Error('should not lock') },
      del: async () => 1,
    }),
    calculate: async () => {
      calculated++
      return 77
    },
    sleep: async (ms) => { sleeps.push(ms) },
  })

  assert.equal(result, 12)
  assert.equal(calculated, 0)
  assert.deepEqual(sleeps, [])
})

asyncTest('runtime preflight calculates only metered oauth message requests', async () => {
  const calls: any[] = []
  const result = await resolveBillableExclusionPreflight({
    shouldMeter: true,
    path: '/v1/messages',
    accountAuthKind: 'oauth',
    templateId: 'tpl_1',
    requestModel: 'fallback-model',
    outboundBody: Buffer.from('{"model":"claude-sonnet-4-5","system":"fixed"}'),
    upstream: new URL('https://api.anthropic.com'),
    headers: { authorization: 'Bearer token' },
    traceId: 'trace_1',
  }, {
    resolve: async (args, deps) => {
      calls.push({ args, deps })
      return 44
    },
  })

  assert.deepEqual(result, { model: 'claude-sonnet-4-5', tokens: 44 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.templateId, 'tpl_1')
  assert.equal(calls[0].args.model, 'claude-sonnet-4-5')
  assert.equal(calls[0].deps.shouldAutoCalculate(), true)
})

asyncTest('runtime preflight skips non-oauth and count token paths', async () => {
  let calls = 0
  const skippedApiKey = await resolveBillableExclusionPreflight({
    shouldMeter: true,
    path: '/v1/messages',
    accountAuthKind: 'api_key',
    templateId: 'tpl_1',
    requestModel: 'claude-sonnet-4-5',
    outboundBody: Buffer.from('{}'),
    upstream: new URL('https://api.anthropic.com'),
    headers: {},
  }, {
    resolve: async () => {
      calls++
      return 44
    },
  })
  const skippedCount = await resolveBillableExclusionPreflight({
    shouldMeter: true,
    path: '/v1/messages/count_tokens',
    accountAuthKind: 'oauth',
    templateId: 'tpl_1',
    requestModel: 'claude-sonnet-4-5',
    outboundBody: Buffer.from('{}'),
    upstream: new URL('https://api.anthropic.com'),
    headers: {},
  }, {
    resolve: async () => {
      calls++
      return 44
    },
  })

  assert.deepEqual(skippedApiKey, { model: null, tokens: null })
  assert.deepEqual(skippedCount, { model: null, tokens: null })
  assert.equal(calls, 0)
})

asyncTest('runtime usage resolver reuses normalized matching preflight tokens', async () => {
  let calls = 0
  const result = await resolveBillableExcludedTokensForUsage({
    accountAuthKind: 'oauth',
    templateId: 'tpl_1',
    usageModel: 'claude-haiku-4-5-20251001',
    preflight: { model: 'claude-haiku-4-5', tokens: 123 },
    outboundBody: Buffer.from('{}'),
    upstream: new URL('https://api.anthropic.com'),
    headers: {},
  }, {
    resolve: async () => {
      calls++
      return 44
    },
  })

  assert.equal(result, 123)
  assert.equal(calls, 0)
})

asyncTest('runtime usage resolver falls back when preflight model differs', async () => {
  const calls: any[] = []
  const result = await resolveBillableExcludedTokensForUsage({
    accountAuthKind: 'oauth',
    templateId: 'tpl_1',
    usageModel: 'claude-opus-4-8',
    preflight: { model: 'claude-haiku-4-5', tokens: 123 },
    outboundBody: Buffer.from('{}'),
    upstream: new URL('https://api.anthropic.com'),
    headers: {},
    traceId: 'trace_2',
  }, {
    resolve: async (args) => {
      calls.push(args)
      return 44
    },
  })

  assert.equal(result, 44)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, 'claude-opus-4-8')
})

// ============================================================
console.log('\nparseUsageFromSSE')
// ============================================================

test('parses SSE stream with message_start and message_delta', () => {
  const stream = [
    'event: message_start',
    `data: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_123',
        model: 'claude-sonnet-4-20250514',
        usage: {
          input_tokens: 150,
          cache_read_input_tokens: 300,
          cache_creation_input_tokens: 20,
        },
      },
    })}`,
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
    '',
    'event: message_delta',
    `data: ${JSON.stringify({
      type: 'message_delta',
      usage: { output_tokens: 75 },
    })}`,
    '',
  ].join('\n')

  const result = parseUsageFromSSE(stream)
  assert.deepEqual(result, {
    model: 'claude-sonnet-4-20250514',
    inputTokens: 150,
    outputTokens: 75,
    cacheRead: 300,
    cacheWrite: 20,
  })
})

test('returns null when no message_start event', () => {
  const stream = [
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0}',
    '',
  ].join('\n')
  assert.equal(parseUsageFromSSE(stream), null)
})

test('returns null for empty string', () => {
  assert.equal(parseUsageFromSSE(''), null)
})

test('handles message_start without usage', () => {
  const stream = [
    'event: message_start',
    `data: ${JSON.stringify({
      type: 'message_start',
      message: { id: 'msg_1', model: 'claude-sonnet-4-20250514' },
    })}`,
    '',
    'event: message_delta',
    `data: ${JSON.stringify({
      type: 'message_delta',
      usage: { output_tokens: 42 },
    })}`,
    '',
  ].join('\n')
  const result = parseUsageFromSSE(stream)
  assert.ok(result)
  assert.equal(result.model, 'claude-sonnet-4-20250514')
  assert.equal(result.inputTokens, 0)
  assert.equal(result.outputTokens, 42)
  assert.equal(result.cacheRead, 0)
  assert.equal(result.cacheWrite, 0)
})

test('handles SSE with no data lines (only event lines)', () => {
  const stream = 'event: ping\nevent: ping\n'
  assert.equal(parseUsageFromSSE(stream), null)
})

test('handles malformed JSON in data lines gracefully', () => {
  const stream = [
    'data: {not valid json}',
    'event: message_start',
    `data: ${JSON.stringify({
      type: 'message_start',
      message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 10 } },
    })}`,
    '',
  ].join('\n')
  const result = parseUsageFromSSE(stream)
  assert.ok(result)
  assert.equal(result.model, 'claude-sonnet-4-20250514')
  assert.equal(result.inputTokens, 10)
})

// ============================================================
await Promise.all(pending)
console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
