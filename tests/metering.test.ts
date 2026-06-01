import { strict as assert } from 'assert'

// We test pure logic inline to avoid importing from src/metering.ts
// which depends on db.js and sync.js (requires database connection).

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
console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
