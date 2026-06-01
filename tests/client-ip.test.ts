import { strict as assert } from 'assert'
import { resolveClientIp } from '../src/client-ip.js'

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

console.log('\nresolveClientIp')

test('uses the socket address for direct clients even if they send X-Forwarded-For', () => {
  assert.equal(resolveClientIp('203.0.113.10', {
    'x-forwarded-for': '198.51.100.20',
    'x-real-ip': '198.51.100.21',
  }), '203.0.113.10')
})

test('uses the first X-Forwarded-For hop from a trusted proxy', () => {
  assert.equal(resolveClientIp('172.20.0.5', {
    'x-forwarded-for': '198.51.100.20, 172.20.0.5',
  }), '198.51.100.20')
})

test('falls back to X-Real-IP from a trusted proxy when X-Forwarded-For is absent', () => {
  assert.equal(resolveClientIp('::ffff:172.20.0.5', {
    'x-real-ip': '198.51.100.21',
  }), '198.51.100.21')
})

test('falls back to the socket address when trusted proxy headers are empty', () => {
  assert.equal(resolveClientIp('127.0.0.1', {
    'x-forwarded-for': ' , ',
    'x-real-ip': '',
  }), '127.0.0.1')
})

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`)
  process.exit(1)
}

console.log(`\n${passed} passed`)
