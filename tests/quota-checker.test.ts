import { strict as assert } from 'assert'
import type { SyncedQuotaRule } from '../src/sync.js'

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

// ── Inline matching logic (mirrors checkQuota without DB/logger imports) ──

function matchesRule(
  rule: SyncedQuotaRule,
  clientId: string,
  userId?: string,
): boolean {
  return (
    (rule.targetType === 'client' && rule.targetId === clientId) ||
    (rule.targetType === 'user' && !!userId && rule.targetId === userId)
  )
}

// ============================================================
console.log('\nQuota rule matching')
// ============================================================

const clientRule: SyncedQuotaRule = {
  targetType: 'client',
  targetId: 'client-abc',
  metric: 'tokens',
  windowSeconds: 3600,
  maxValue: 100000,
  action: 'reject',
}

const userRule: SyncedQuotaRule = {
  targetType: 'user',
  targetId: 'user-xyz',
  metric: 'cost',
  windowSeconds: 86400,
  maxValue: 50,
  action: 'notify',
}

test('client target matches correct client ID', () => {
  assert.equal(matchesRule(clientRule, 'client-abc', 'user-xyz'), true)
})

test('client target does not match wrong client ID', () => {
  assert.equal(matchesRule(clientRule, 'client-other', 'user-xyz'), false)
})

test('user target matches correct user ID', () => {
  assert.equal(matchesRule(userRule, 'client-abc', 'user-xyz'), true)
})

test('user target does not match wrong user ID', () => {
  assert.equal(matchesRule(userRule, 'client-abc', 'user-other'), false)
})

test('user target does not match when userId is undefined', () => {
  assert.equal(matchesRule(userRule, 'client-abc', undefined), false)
})

test('wrong targetType does not match', () => {
  const rule: SyncedQuotaRule = {
    targetType: 'user',
    targetId: 'client-abc',
    metric: 'requests',
    windowSeconds: 3600,
    maxValue: 100,
    action: 'reject',
  }
  // Even though targetId equals clientId, targetType is 'user' so it should not match
  assert.equal(matchesRule(rule, 'client-abc', undefined), false)
})

// ============================================================
console.log('\nQuota action types')
// ============================================================

test('reject action is correctly identified', () => {
  assert.equal(clientRule.action, 'reject')
})

test('notify action is correctly identified', () => {
  assert.equal(userRule.action, 'notify')
})

// ============================================================
console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
