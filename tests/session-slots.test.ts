import { strict as assert } from 'assert'
import {
  getOrAssignSession,
  resetSessionTables,
  getSessionTable,
} from '../src/session-slots.js'

// ── Basic allocation ──
{
  resetSessionTables()
  const s1 = getOrAssignSession('acct-1', 'sticky-a', 'alice', 3)
  assert.ok(s1, 'should return a derived session id')
  assert.ok(s1.includes('-'), 'should be UUID-shaped')

  const s1b = getOrAssignSession('acct-1', 'sticky-a', 'alice', 3)
  assert.equal(s1b, s1, 'same stickyKey should return same derived session')

  const s2 = getOrAssignSession('acct-1', 'sticky-b', 'my-macbook', 3)
  assert.notEqual(s2, s1, 'different stickyKey should get different session')

  const table = getSessionTable('acct-1')!
  assert.equal(table.slots.length, 2, 'should have 2 slots allocated')
  console.log('✓ basic allocation')
}

// ── LRU eviction ──
{
  resetSessionTables()
  const s1 = getOrAssignSession('acct-2', 'sticky-a', 'alice', 2)
  getOrAssignSession('acct-2', 'sticky-b', 'bob', 2)

  const table = getSessionTable('acct-2')!
  table.slots[0].lastUsed = Date.now() - 60000

  const s3 = getOrAssignSession('acct-2', 'sticky-c', 'charlie', 2)

  assert.notEqual(s3, s1, 'LRU eviction should mint a fresh derivedId for new stickyKey')
  assert.equal(table.slots[0].reuseCount, 1, 'reuse count should be 1')
  assert.ok(table.slots[0].boundKeys.has('sticky-c'), 'new key should be bound')
  assert.ok(!table.slots[0].boundKeys.has('sticky-a'), 'old key should be removed')
  assert.ok(!table.keyToSlot.has('sticky-a'), 'evicted key should be removed from keyToSlot')
  console.log('✓ LRU eviction')
}

// ── Same client rebind stays stable ──
{
  resetSessionTables()
  const s1 = getOrAssignSession('acct-2b', 'sticky-a', 'alice', 3)
  const s2 = getOrAssignSession('acct-2b', 'sticky-b', 'alice', 3)

  assert.equal(s2, s1, 'same client should keep one stable derived session id on the same account')
  const table = getSessionTable('acct-2b')!
  assert.equal(table.slots.length, 1, 'same client should not fan out into multiple slots')
  assert.ok(table.slots[0].boundKeys.has('sticky-b'), 'latest sticky key should be bound')
  assert.ok(!table.slots[0].boundKeys.has('sticky-a'), 'previous sticky key should be replaced')
  console.log('✓ same client rebind stays stable')
}

// ── maxSessions=0 bypass ──
{
  resetSessionTables()
  const s1 = getOrAssignSession('acct-3', 'sticky-a', 'alice', 0)
  const s2 = getOrAssignSession('acct-3', 'sticky-b', 'bob', 0)
  assert.notEqual(s1, s2, 'maxSessions=0 should not limit')
  const table = getSessionTable('acct-3')
  assert.equal(table, undefined, 'maxSessions=0 should not create session table')
  console.log('✓ maxSessions=0 bypass')
}

// ── Dynamic max reduction ──
{
  resetSessionTables()
  getOrAssignSession('acct-4', 'sticky-a', 'alice', 3)
  getOrAssignSession('acct-4', 'sticky-b', 'bob', 3)
  getOrAssignSession('acct-4', 'sticky-c', 'charlie', 3)

  const table = getSessionTable('acct-4')!
  table.slots[0].lastUsed = Date.now() - 60000
  table.slots[1].lastUsed = Date.now() - 30000

  const s4 = getOrAssignSession('acct-4', 'sticky-d', 'dave', 2)
  assert.equal(table.slots.length, 2, 'should trim to max=2 after eviction')
  console.log('✓ dynamic max reduction')
}

console.log('\nAll session-slots tests passed')
