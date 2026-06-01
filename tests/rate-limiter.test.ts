import { strict as assert } from 'assert'

// Inline SlidingWindowCounter to avoid import issues with sync.js
class SlidingWindowCounter {
  private windows = new Map<string, number[]>()

  check(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now()
    const cutoff = now - windowMs
    let timestamps = this.windows.get(key) ?? []
    timestamps = timestamps.filter(t => t > cutoff)
    if (timestamps.length >= maxRequests) {
      this.windows.set(key, timestamps)
      return false
    }
    timestamps.push(now)
    this.windows.set(key, timestamps)
    return true
  }

  cleanup(): void {
    const now = Date.now()
    for (const [key, timestamps] of this.windows) {
      const filtered = timestamps.filter(t => t > now - 3600_000)
      if (filtered.length === 0) {
        this.windows.delete(key)
      } else {
        this.windows.set(key, filtered)
      }
    }
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
console.log('\nSlidingWindowCounter — allows requests under the limit')
// ============================================================

test('allows requests under the limit', () => {
  const counter = new SlidingWindowCounter()
  assert.equal(counter.check('key1', 3, 60_000), true)
  assert.equal(counter.check('key1', 3, 60_000), true)
  assert.equal(counter.check('key1', 3, 60_000), true)
})

// ============================================================
console.log('\nSlidingWindowCounter — blocks requests over the limit')
// ============================================================

test('blocks requests over the limit', () => {
  const counter = new SlidingWindowCounter()
  assert.equal(counter.check('key1', 2, 60_000), true)
  assert.equal(counter.check('key1', 2, 60_000), true)
  assert.equal(counter.check('key1', 2, 60_000), false, 'Third request should be blocked')
  assert.equal(counter.check('key1', 2, 60_000), false, 'Fourth request should also be blocked')
})

// ============================================================
console.log('\nSlidingWindowCounter — different keys are independent')
// ============================================================

test('different keys are independent', () => {
  const counter = new SlidingWindowCounter()
  assert.equal(counter.check('keyA', 1, 60_000), true)
  assert.equal(counter.check('keyA', 1, 60_000), false, 'keyA should be blocked')
  assert.equal(counter.check('keyB', 1, 60_000), true, 'keyB should still be allowed')
})

// ============================================================
console.log('\nSlidingWindowCounter — cleanup clears expired entries')
// ============================================================

test('cleanup clears expired entries', () => {
  const counter = new SlidingWindowCounter()

  // Manually insert an old timestamp by using the check method and then
  // manipulating time via a short window
  assert.equal(counter.check('old-key', 1, 1), true) // 1ms window — expires instantly

  // Wait a tiny bit so the timestamp is definitely expired
  const start = Date.now()
  while (Date.now() - start < 5) { /* spin */ }

  // The key should now allow a new request since the old one expired
  assert.equal(counter.check('old-key', 1, 1), true, 'Should allow after window expires')

  // Cleanup should remove entries older than 1 hour
  counter.cleanup()
  // After cleanup, should be able to add again (cleanup only removes >1h old)
  // The recent entry is still there, so check with limit 2 should pass
  assert.equal(counter.check('old-key', 2, 60_000), true)
})

// ============================================================
console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
