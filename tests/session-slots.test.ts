import { strict as assert } from 'assert'
import {
  getOrAssignSession,
  resetSessionTables,
  getSessionTable,
  setSessionSlotRedisForTest,
  hydrateFromRows,
} from '../src/session-slots.js'

class FakeRedis {
  store = new Map<string, string>()
  locks = new Set<string>()

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null
  }

  async set(key: string, value: string, ...args: any[]): Promise<'OK' | null> {
    if (args.includes('NX')) {
      if (this.locks.has(key)) return null
      this.locks.add(key)
    }
    this.store.set(key, value)
    return 'OK'
  }

  async del(key: string): Promise<number> {
    const hadValue = this.store.delete(key)
    const hadLock = this.locks.delete(key)
    return hadValue || hadLock ? 1 : 0
  }
}

// ── Basic allocation ──
{
  resetSessionTables()
  setSessionSlotRedisForTest(null)
  const s1 = await getOrAssignSession('acct-1', 'sticky-a', 'alice', 3)
  assert.ok(s1, 'should return a derived session id')
  assert.ok(s1.includes('-'), 'should be UUID-shaped')

  const s1b = await getOrAssignSession('acct-1', 'sticky-a', 'alice', 3)
  assert.equal(s1b, s1, 'same stickyKey should return same derived session')

  const s2 = await getOrAssignSession('acct-1', 'sticky-b', 'my-macbook', 3)
  assert.notEqual(s2, s1, 'different stickyKey should get different session')

  const table = getSessionTable('acct-1')!
  assert.equal(table.slots.length, 2, 'should have 2 slots allocated')
  console.log('✓ basic allocation')
}

// ── LRU eviction ──
{
  resetSessionTables()
  setSessionSlotRedisForTest(null)
  const s1 = await getOrAssignSession('acct-2', 'sticky-a', 'alice', 2)
  await getOrAssignSession('acct-2', 'sticky-b', 'bob', 2)

  const table = getSessionTable('acct-2')!
  table.slots[0].lastUsed = Date.now() - 60000

  const s3 = await getOrAssignSession('acct-2', 'sticky-c', 'charlie', 2)

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
  setSessionSlotRedisForTest(null)
  const s1 = await getOrAssignSession('acct-2b', 'sticky-a', 'alice', 3)
  const s2 = await getOrAssignSession('acct-2b', 'sticky-b', 'alice', 3)

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
  setSessionSlotRedisForTest(null)
  const s1 = await getOrAssignSession('acct-3', 'sticky-a', 'alice', 0)
  const s2 = await getOrAssignSession('acct-3', 'sticky-b', 'bob', 0)
  assert.notEqual(s1, s2, 'maxSessions=0 should not limit')
  const table = getSessionTable('acct-3')
  assert.equal(table, undefined, 'maxSessions=0 should not create session table')
  console.log('✓ maxSessions=0 bypass')
}

// ── Dynamic max reduction ──
{
  resetSessionTables()
  setSessionSlotRedisForTest(null)
  await getOrAssignSession('acct-4', 'sticky-a', 'alice', 3)
  await getOrAssignSession('acct-4', 'sticky-b', 'bob', 3)
  await getOrAssignSession('acct-4', 'sticky-c', 'charlie', 3)

  const table = getSessionTable('acct-4')!
  table.slots[0].lastUsed = Date.now() - 60000
  table.slots[1].lastUsed = Date.now() - 30000

  const s4 = await getOrAssignSession('acct-4', 'sticky-d', 'dave', 2)
  assert.equal(table.slots.length, 2, 'should trim to max=2 after eviction')
  console.log('✓ dynamic max reduction')
}

// ── Redis-backed shared allocation ──
{
  resetSessionTables()
  const redis = new FakeRedis()
  setSessionSlotRedisForTest(redis as any)

  const s1 = await getOrAssignSession('acct-r', 'sticky-a', 'alice', 2)
  const s2 = await getOrAssignSession('acct-r', 'sticky-b', 'bob', 2)
  const s3 = await getOrAssignSession('acct-r', 'sticky-c', 'charlie', 2)

  assert.ok(s1 && s2 && s3, 'redis-backed allocation should return ids')
  assert.equal(getSessionTable('acct-r'), undefined, 'redis-backed allocation should not use local memory table')
  assert.ok(redis.store.has('session_slots:gw:acct-r'), 'redis-backed allocation should persist shared table')
  const stored = JSON.parse(redis.store.get('session_slots:gw:acct-r')!)
  assert.equal(stored.slots.length, 2, 'redis-backed LRU should keep maxSessions slots')
  assert.ok(!stored.slots.some((slot: any) => slot.boundKeys.includes('sticky-a')), 'oldest redis slot should be evicted')
  assert.ok(stored.slots.some((slot: any) => slot.boundKeys.includes('sticky-c')), 'new redis sticky key should be bound')
  setSessionSlotRedisForTest(null)
  console.log('✓ redis-backed shared allocation')
}

// ── Redis seeding from hydrated PG rows ──
{
  resetSessionTables()
  hydrateFromRows([{
    account_id: 'acct-h',
    sticky_key: 'sticky-a',
    client_name: 'alice',
    derived_id: 'seeded-session-id',
    last_used: Date.now(),
    reuse_count: 0,
    created_at: Date.now(),
  }])
  const redis = new FakeRedis()
  setSessionSlotRedisForTest(redis as any)

  const s1 = await getOrAssignSession('acct-h', 'sticky-a', 'alice', 2)

  assert.equal(s1, 'seeded-session-id', 'redis allocation should seed from hydrated memory when redis table is empty')
  assert.ok(redis.store.has('session_slots:gw:acct-h'), 'seeded hydrated table should be persisted to redis')
  setSessionSlotRedisForTest(null)
  resetSessionTables()
  console.log('✓ redis seeds from hydrated rows')
}

console.log('\nAll session-slots tests passed')
