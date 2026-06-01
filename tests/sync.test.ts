import { strict as assert } from 'assert'
import type {
  SyncedClient,
  SyncedRateLimit,
  SyncedQuotaRule,
  ModelPrice,
} from '../src/sync.js'
import { findModelPrice, getModelPrices } from '../src/sync.js'

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
console.log('\nType-level checks')
// ============================================================

test('SyncedClient type has all required fields', () => {
  const client: SyncedClient = {
    id: 'c-1',
    userId: 'u-1',
    name: 'test-client',
    token: 'tok-abc',
    status: 'active',
    userStatus: 'active',
  }
  assert.equal(client.id, 'c-1')
  assert.equal(client.status, 'active')
})

test('SyncedRateLimit type works with null maxRph', () => {
  const limit: SyncedRateLimit = {
    targetType: 'client',
    targetId: 'c-1',
    maxRpm: 60,
    maxRph: null,
  }
  assert.equal(limit.maxRph, null)
})

test('SyncedQuotaRule type has windowSeconds as number', () => {
  const rule: SyncedQuotaRule = {
    targetType: 'user',
    targetId: 'u-1',
    metric: 'input_tokens',
    windowSeconds: 3600,
    maxValue: 1000000,
    action: 'block',
  }
  assert.equal(rule.windowSeconds, 3600)
})

test('ModelPrice type has all cost fields', () => {
  const price: ModelPrice = {
    modelPattern: 'claude-sonnet-4-20250514',
    inputMtok: 3.0,
    outputMtok: 15.0,
    cacheReadMtok: 0.3,
    cacheWriteMtok: 3.75,
  }
  assert.equal(price.inputMtok, 3.0)
  assert.equal(price.cacheWriteMtok, 3.75)
})

// ============================================================
console.log('\nfindModelPrice logic')
// ============================================================

// To test findModelPrice we need to populate the in-memory state.
// Since the model prices array is module-private, we test via the exported
// function after verifying it returns undefined when empty.

test('findModelPrice returns undefined when no prices loaded', () => {
  const result = findModelPrice('claude-sonnet-4-20250514')
  assert.equal(result, undefined)
})

test('getModelPrices returns empty array initially', () => {
  const prices = getModelPrices()
  assert.ok(Array.isArray(prices))
  assert.equal(prices.length, 0)
})

// ============================================================
console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
