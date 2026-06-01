import { strict as assert } from 'assert'
import { randomBytes } from 'crypto'

// Inline implementations to avoid DB dependency (same pattern as metering.test.ts)

function generateTraceId(): string {
  const ts = Date.now().toString(36)
  const rand = randomBytes(6).toString('hex')
  return `ccg-${ts}-${rand}`
}

function truncateString(value: string, maxStr: number): string {
  return value.length > maxStr ? value.slice(0, maxStr) + `...(${value.length})` : value
}

function truncateDeep(val: any, maxStr: number): any {
  if (val === null || val === undefined) return val
  if (typeof val === 'string') {
    return truncateString(val, maxStr)
  }
  if (Array.isArray(val)) {
    return val.map(item => truncateDeep(item, maxStr))
  }
  if (typeof val === 'object') {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(val)) {
      out[k] = truncateDeep(v, maxStr)
    }
    return out
  }
  return val
}

function truncateBody(raw: Buffer, maxValueLen = 200): any {
  if (raw.length === 0) return null
  const text = raw.toString('utf-8')
  try {
    const obj = JSON.parse(text)
    return truncateDeep(obj, maxValueLen)
  } catch {
    return { _raw_text: truncateString(text, maxValueLen) }
  }
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
console.log('\ngenerateTraceId')
// ============================================================

test('returns a string starting with "ccg-"', () => {
  const id = generateTraceId()
  assert.ok(id.startsWith('ccg-'))
})

test('is 32 chars or less', () => {
  const id = generateTraceId()
  assert.ok(id.length <= 32, `length was ${id.length}`)
})

test('generates unique ids', () => {
  const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()))
  assert.equal(ids.size, 100)
})

// ============================================================
console.log('\ntruncateBody')
// ============================================================

test('preserves all JSON keys with truncated string values', () => {
  const input = {
    model: 'claude-sonnet-4-20250514',
    messages: [{ role: 'user', content: 'a'.repeat(500) }],
    system: 'short',
  }
  const result = truncateBody(Buffer.from(JSON.stringify(input)), 200)
  assert.equal(result.model, 'claude-sonnet-4-20250514')
  assert.equal(result.system, 'short')
  assert.equal(result.messages[0].role, 'user')
  assert.ok(result.messages[0].content.length <= 220)
  assert.ok(result.messages[0].content.includes('...'))
})

test('handles nested objects', () => {
  const input = { a: { b: { c: 'x'.repeat(300) } } }
  const result = truncateBody(Buffer.from(JSON.stringify(input)), 100)
  assert.ok(result.a.b.c.length <= 120)
  assert.ok(result.a.b.c.includes('...'))
})

test('preserves numbers and booleans', () => {
  const input = { count: 42, enabled: true, name: 'test' }
  const result = truncateBody(Buffer.from(JSON.stringify(input)), 200)
  assert.equal(result.count, 42)
  assert.equal(result.enabled, true)
  assert.equal(result.name, 'test')
})

test('preserves arrays', () => {
  const input = { items: [1, 'short', 'a'.repeat(300)] }
  const result = truncateBody(Buffer.from(JSON.stringify(input)), 100)
  assert.equal(result.items[0], 1)
  assert.equal(result.items[1], 'short')
  assert.ok(result.items[2].includes('...'))
})

test('stores non-JSON body as _raw_text', () => {
  const result = truncateBody(Buffer.from('not json at all'), 200)
  assert.deepEqual(result, { _raw_text: 'not json at all' })
})

test('returns null for empty buffer', () => {
  const result = truncateBody(Buffer.alloc(0), 200)
  assert.equal(result, null)
})

test('preserves null values in JSON', () => {
  const input = { a: null, b: 'test' }
  const result = truncateBody(Buffer.from(JSON.stringify(input)), 200)
  assert.equal(result.a, null)
  assert.equal(result.b, 'test')
})

test('truncates non-JSON raw text', () => {
  const result = truncateBody(Buffer.from('x'.repeat(300)), 100)
  assert.ok(result._raw_text.length <= 120)
  assert.ok(result._raw_text.includes('...'))
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
