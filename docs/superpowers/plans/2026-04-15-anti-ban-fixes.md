# Anti-Ban Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 5 issues that caused OAuth account bans: OS/arch fingerprint leaking, version lock losing state on restart, fake version fallback, missing 401/403 circuit breaker, and unlimited session count per account.

**Architecture:** Fixes 2-5 are small targeted changes to existing files. Fix 1 (session slots) introduces a new module `src/session-slots.ts` that manages per-account slot allocation with LRU reuse, persisted to Redis + DB, with a new API endpoint and frontend section.

**Tech Stack:** TypeScript, PostgreSQL, Redis (ioredis), React (frontend)

**Spec:** `docs/superpowers/specs/2026-04-15-session-slots-design.md`

---

### Task 1: Fix OS/arch passthrough in rewriteHeaders

**Files:**
- Modify: `src/rewriter.ts:486-489` (x-stainless-os/arch branches)
- Modify: `src/rewriter.ts:99-109` (hydrateVersionLocks field list)
- Test: `tests/rewriter.test.ts`

- [ ] **Step 1: Write failing test — OS lock**

Add to `tests/rewriter.test.ts`:

```typescript
// ── OS/arch lock tests ──

{
  // First request sets the OS lock
  const h1 = rewriteHeaders(
    { 'x-stainless-os': 'Linux', 'x-stainless-arch': 'x64', 'user-agent': 'claude-cli/2.1.94 (external, cli)', 'content-type': 'application/json' },
    config,
    { ...opts, derivedSessionId: 'test-session' },
  )
  assert.equal(h1['x-stainless-os'], 'Linux', 'first request OS should pass through')
  assert.equal(h1['x-stainless-arch'], 'x64', 'first request arch should pass through')

  // Second request with different OS should be locked to the first
  const h2 = rewriteHeaders(
    { 'x-stainless-os': 'MacOS', 'x-stainless-arch': 'arm64', 'user-agent': 'claude-cli/2.1.94 (external, cli)', 'content-type': 'application/json' },
    config,
    { ...opts, derivedSessionId: 'test-session' },
  )
  assert.equal(h2['x-stainless-os'], 'Linux', 'second request OS should be locked to first')
  assert.equal(h2['x-stainless-arch'], 'x64', 'second request arch should be locked to first')
  console.log('✓ OS/arch lock')
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx tests/rewriter.test.ts`
Expected: FAIL — `h2['x-stainless-os']` is `'MacOS'` not `'Linux'`

- [ ] **Step 3: Implement OS/arch lock**

In `src/rewriter.ts`, replace the two passthrough branches:

```typescript
    } else if (lower === 'x-stainless-os') {
      // Lock OS to first client per account — prevents MacOS/Linux oscillation
      const acctId = view.account_uuid || '_default'
      out[key] = lockVersionFromFirstClient(acctId, 'os', v)
    } else if (lower === 'x-stainless-arch') {
      const acctId = view.account_uuid || '_default'
      out[key] = lockVersionFromFirstClient(acctId, 'arch', v)
    }
```

- [ ] **Step 4: Extend hydrateVersionLocks field list**

In `src/rewriter.ts`, update `hydrateVersionLocks`:

```typescript
export async function hydrateVersionLocks(accountUuids: string[]): Promise<void> {
  const redis = await getRedisForLock()
  if (!redis) return
  for (const uuid of accountUuids) {
    for (const field of ['ua', 'node', 'pkg', 'os', 'arch']) {
      const key = `vlock:${uuid}:${field}`
      const val = await redis.get(key)
      if (val) versionCache.set(key, val)
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx tests/rewriter.test.ts`
Expected: PASS — all tests including new OS/arch lock test

- [ ] **Step 6: Commit**

```bash
git add src/rewriter.ts tests/rewriter.test.ts
git commit -m "fix: lock x-stainless-os and x-stainless-arch per account to prevent fingerprint oscillation"
```

---

### Task 2: Fix version lock hydrate on startup

**Files:**
- Modify: `src/account-pool.ts:1029-1069` (startAccountPool)
- Modify: `src/index.ts` (no changes needed — startAccountPool already called)

- [ ] **Step 1: Add hydrateVersionLocks call to startAccountPool**

In `src/account-pool.ts`, add import at top:

```typescript
import { hydrateVersionLocks } from './rewriter.js'
```

In `startAccountPool()`, after `await syncAccounts()` (line ~1033) and before the `if (accounts.length === 0)` check, add:

```typescript
  await syncAccounts()

  // Hydrate version locks from Redis so OS/arch/UA stay consistent across PM2 restarts
  const accountUuids = accounts
    .map(a => a.canonicalIdentity?.account_uuid)
    .filter((u): u is string => !!u)
  if (accountUuids.length > 0) {
    await hydrateVersionLocks(accountUuids)
    log('info', `account-pool: hydrated version locks for ${accountUuids.length} accounts`)
  }

  if (accounts.length === 0) {
```

- [ ] **Step 2: Verify Redis is configured on server**

```bash
ssh root@1.2.3.4 "cat /home/ubuntu/gw/config.yaml | grep -A 3 'redis:'"
```

Expected: redis config with host/port. If missing, add `redis: { host: '127.0.0.1', port: 6379 }` to server config.

- [ ] **Step 3: Commit**

```bash
git add src/account-pool.ts
git commit -m "fix: hydrate version locks from Redis on startup to survive PM2 restarts"
```

---

### Task 3: Fix fake version fallback

**Files:**
- Modify: `src/identity-rewrite.ts:112-115` (versionFromUserAgent)
- Modify: `src/config.ts` (add env to Config type, expose getConfig)
- Modify: `src/index.ts` (store config reference)
- Modify: `config.yaml` (update env.version)
- Test: `tests/rewriter.test.ts`

- [ ] **Step 1: Add config singleton accessor**

The config is loaded in `index.ts` but not exported as a singleton. Add to `src/config.ts`:

```typescript
let _config: Config | null = null

export function setConfig(config: Config): void {
  _config = config
}

export function getConfig(): Config | null {
  return _config
}
```

Add `env` to the Config type (it exists in config.yaml but isn't typed):

```typescript
export type Config = {
  // ... existing fields ...
  env?: {
    version?: string
    [key: string]: any
  }
}
```

- [ ] **Step 2: Store config in index.ts**

In `src/index.ts`, after `const config = loadConfig(configPath)`, add:

```typescript
import { loadConfig, getUpstreamAuthMode, setConfig } from './config.js'
// ...
const config = loadConfig(configPath)
setConfig(config)
```

- [ ] **Step 3: Write failing test — version fallback**

Add to `tests/rewriter.test.ts`:

```typescript
// ── Version fallback test ──
import { setConfig } from '../src/config.js'

{
  // Set config with env.version
  setConfig({ ...config, env: { version: '2.1.94' } } as any)

  // Import and test versionFromUserAgent via rewriteBody behavior
  // A request with no billing header + no matching UA should use config version, not 2.1.888
  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    system: [{ type: 'text', text: 'You are Claude.' }],
    messages: [{ role: 'user', content: 'hi' }],
    metadata: { user_id: '{"device_id":"abc","account_uuid":"test-uuid","session_id":"s1"}' },
    max_tokens: 1024,
  })
  const result = rewriteBody(Buffer.from(body), '/v1/messages', config, opts)
  const parsed = JSON.parse(result.toString())
  const billingBlock = parsed.system?.find((s: any) => typeof s === 'object' && s.text?.includes('cc_version='))
  assert.ok(billingBlock, 'should have billing header block')
  assert.ok(!billingBlock.text.includes('2.1.888'), 'should NOT contain fake version 2.1.888')
  console.log('✓ version fallback uses config, not 2.1.888')
}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx tsx tests/rewriter.test.ts`
Expected: FAIL — billing header contains `2.1.888`

- [ ] **Step 5: Fix versionFromUserAgent fallback**

In `src/identity-rewrite.ts`, replace:

```typescript
import { getConfig } from './config.js'

function versionFromUserAgent(userAgent: string): string {
  const match = userAgent.match(/claude-(?:cli|code)\/([^\s]+)/i)
  return match?.[1] ?? getConfig()?.env?.version ?? '2.1.94'
}
```

- [ ] **Step 6: Update config.yaml env.version**

In `config.yaml`, change:

```yaml
env:
  version: 2.1.94
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx tsx tests/rewriter.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/index.ts src/identity-rewrite.ts config.yaml tests/rewriter.test.ts
git commit -m "fix: replace fake 2.1.888 version fallback with config.env.version"
```

---

### Task 4: Add 401/403 circuit breaker

**Files:**
- Modify: `src/proxy.ts` (upstream response handler, around line 940-1043)
- Modify: `src/account-pool.ts` (add disableAccount function)

- [ ] **Step 1: Add disableAccount to account-pool**

In `src/account-pool.ts`, add:

```typescript
/**
 * Immediately disable an account (e.g., after 401/403 ban).
 * Updates DB + removes from in-memory pool.
 * Recovery: admin manually re-enables via dashboard.
 */
export async function disableAccount(accountId: string, reason: string): Promise<void> {
  try {
    await query(
      `UPDATE oauth_accounts SET status = 'disabled', last_error = $2, updated_at = now() WHERE id = $1`,
      [accountId, reason]
    )
    // Remove from in-memory pool immediately
    accounts = accounts.filter(a => a.id !== accountId)
    log('warn', `account-pool: disabled account ${accountId}: ${reason}`)
  } catch (err) {
    log('error', `account-pool: failed to disable account ${accountId}: ${err}`)
  }
}
```

- [ ] **Step 2: Add circuit breaker in proxy upstream handler**

In `src/proxy.ts`, in the `forwardToUpstream` function, in the `proxyRes` handler block where `status` is checked, add a new check **before** the existing 429/503 retry block (around line 990):

```typescript
        // ── Circuit breaker: 401/403 OAuth ban ──
        if ((status === 401 || status === 403) && accountId && selectedAccount) {
          // Collect response body to check error message
          const banCheckChunks: Buffer[] = []
          proxyRes.on('data', (chunk: Buffer) => banCheckChunks.push(chunk))
          proxyRes.on('end', async () => {
            const banBody = decodeResponseBody(
              proxyRes.headers as Record<string, string | string[] | undefined>,
              banCheckChunks,
            )
            const isBan = banBody.includes('OAuth authentication is currently not supported')
              || banBody.includes('not allowed for this organization')

            if (isBan) {
              log('error', `Circuit breaker: account "${selectedAccount!.account.name}" (${accountId}) banned by Anthropic: ${banBody.slice(0, 200)}`)
              await disableAccount(accountId, `Anthropic ${status}: ${banBody.slice(0, 200)}`)

              if (accountId) {
                await onRequestEnd(accountId, 0, 0, false, `ban_${status}`)
              }
            }

            // Always forward the error to client
            if (!res.headersSent) {
              res.writeHead(status, { ...proxyRes.headers })
              res.end(Buffer.concat(banCheckChunks))
            }
            resolveRequest()
          })
          return
        }
```

- [ ] **Step 3: Add import for disableAccount**

At the top of `src/proxy.ts`, add `disableAccount` to the import from `account-pool.js`:

```typescript
import { ..., disableAccount } from './account-pool.js'
```

- [ ] **Step 4: Commit**

```bash
git add src/proxy.ts src/account-pool.ts
git commit -m "fix: circuit breaker disables account immediately on 401/403 OAuth ban"
```

---

### Task 5: DB migration for session slots

**Files:**
- Create: `migrations/010_session_slots.sql`

- [ ] **Step 1: Write migration**

Create `migrations/010_session_slots.sql`:

```sql
-- Session slot management: limits outbound session_id count per OAuth account

CREATE TABLE session_slots (
  id                 BIGSERIAL PRIMARY KEY,
  account_id         UUID NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,
  slot_index         SMALLINT NOT NULL,
  derived_session_id VARCHAR(36) NOT NULL,
  bound_keys         TEXT[] NOT NULL DEFAULT '{}',
  reuse_count        INT NOT NULL DEFAULT 0,
  last_used_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, slot_index)
);
CREATE INDEX idx_session_slots_account ON session_slots(account_id);

CREATE TABLE session_slot_history (
  id                 BIGSERIAL PRIMARY KEY,
  account_id         UUID NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,
  slot_index         SMALLINT NOT NULL,
  action             VARCHAR(16) NOT NULL,
  client_name        VARCHAR(64),
  evicted_client     VARCHAR(64),
  idle_duration_ms   BIGINT,
  reuse_number       INT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_slot_history_account ON session_slot_history(account_id, created_at DESC);

-- Change default max_sessions from 0 (unlimited) to 3
ALTER TABLE oauth_accounts ALTER COLUMN max_sessions SET DEFAULT 3;
UPDATE oauth_accounts SET max_sessions = 3 WHERE max_sessions = 0;
```

- [ ] **Step 2: Run migration on server**

```bash
ssh root@1.2.3.4 "PGPASSWORD=change-me-password psql -h 127.0.0.1 -U cc_gateway -d cc_gateway -f /home/ubuntu/gw/migrations/010_session_slots.sql"
```

Expected: CREATE TABLE, CREATE INDEX, ALTER TABLE, UPDATE

- [ ] **Step 3: Commit**

```bash
git add migrations/010_session_slots.sql
git commit -m "feat: add session_slots and session_slot_history tables"
```

---

### Task 6: Session slot core module

**Files:**
- Create: `src/session-slots.ts`
- Test: `tests/session-slots.test.ts`

- [ ] **Step 1: Write failing test — slot allocation**

Create `tests/session-slots.test.ts`:

```typescript
import { strict as assert } from 'assert'
import {
  getOrAssignSession,
  resetSessionTables,
  getSessionTable,
} from '../src/session-slots.js'

// Reset state before each logical test group
resetSessionTables()

// ── Basic allocation ──
{
  resetSessionTables()
  const s1 = getOrAssignSession('acct-1', 'sticky-a', 'alice', 3)
  assert.ok(s1, 'should return a derived session id')
  assert.ok(s1.includes('-'), 'should be UUID-shaped')

  // Same stickyKey returns same session
  const s1b = getOrAssignSession('acct-1', 'sticky-a', 'alice', 3)
  assert.equal(s1b, s1, 'same stickyKey should return same derived session')

  // Different stickyKey gets different slot
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
  const s2 = getOrAssignSession('acct-2', 'sticky-b', 'bob', 2)

  // Both slots full, new key triggers LRU
  // Manually age slot 0 so it's the LRU candidate
  const table = getSessionTable('acct-2')!
  table.slots[0].lastUsed = Date.now() - 60000

  const s3 = getOrAssignSession('acct-2', 'sticky-c', 'charlie', 2)

  // s3 should reuse s1's derivedId (slot 0 was LRU)
  assert.equal(s3, s1, 'LRU eviction should reuse oldest slot derivedId')
  assert.equal(table.slots[0].reuseCount, 1, 'reuse count should be 1')
  assert.ok(table.slots[0].boundKeys.has('sticky-c'), 'new key should be bound')
  assert.ok(!table.slots[0].boundKeys.has('sticky-a'), 'old key should be removed')

  // Old stickyKey should no longer map
  assert.ok(!table.keyToSlot.has('sticky-a'), 'evicted key should be removed from keyToSlot')
  console.log('✓ LRU eviction')
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

  // Now reduce max to 2 — next new key should evict LRU
  const table = getSessionTable('acct-4')!
  table.slots[0].lastUsed = Date.now() - 60000
  table.slots[1].lastUsed = Date.now() - 30000

  const s4 = getOrAssignSession('acct-4', 'sticky-d', 'dave', 2)
  assert.equal(table.slots.length, 2, 'should trim to max=2 after eviction')
  console.log('✓ dynamic max reduction')
}

console.log('\nAll session-slots tests passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx tests/session-slots.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement session-slots module**

Create `src/session-slots.ts`:

```typescript
import { createHash } from 'crypto'
import { log } from './logger.js'

// ── Types ──

export type SessionSlot = {
  derivedId: string
  lastUsed: number
  boundKeys: Set<string>
  boundClients: Map<string, string>  // stickyKey -> clientName
  reuseCount: number
  createdAt: number
}

export type AccountSessionTable = {
  slots: SessionSlot[]
  keyToSlot: Map<string, number>
}

export type SlotEvent = {
  accountId: string
  slotIndex: number
  action: 'created' | 'bound' | 'evicted'
  clientName: string
  evictedClient?: string
  idleDurationMs?: number
  reuseNumber?: number
}

// ── State ──

const sessionTables = new Map<string, AccountSessionTable>()
const slotEventListeners: ((event: SlotEvent) => void)[] = []

// ── Public API ──

export function onSlotEvent(listener: (event: SlotEvent) => void): void {
  slotEventListeners.push(listener)
}

function emitSlotEvent(event: SlotEvent): void {
  for (const listener of slotEventListeners) {
    try { listener(event) } catch {}
  }
}

/**
 * Derive a stable UUID-shaped session id from account + stickyKey.
 * Pure function, same inputs always produce the same output.
 */
function deriveSessionId(accountId: string, stickyKey: string): string {
  const hex = createHash('sha256').update(`${accountId}:${stickyKey}`).digest('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    '4' + hex.slice(13, 16),
    ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-')
}

/**
 * Get or assign a session slot for the given account + stickyKey.
 *
 * - maxSessions=0: bypass slot management, use deriveSessionId directly
 * - Hit existing mapping: return cached derivedId
 * - Free slot available: allocate new slot
 * - All slots full: LRU evict oldest, reuse its derivedId
 */
export function getOrAssignSession(
  accountId: string,
  stickyKey: string,
  clientName: string,
  maxSessions: number,
): string {
  // Bypass: unlimited sessions
  if (maxSessions === 0) {
    return deriveSessionId(accountId, stickyKey)
  }

  let table = sessionTables.get(accountId)
  if (!table) {
    table = { slots: [], keyToSlot: new Map() }
    sessionTables.set(accountId, table)
  }

  // 1. Existing mapping — cache hit
  const existingSlot = table.keyToSlot.get(stickyKey)
  if (existingSlot !== undefined && existingSlot < table.slots.length) {
    const slot = table.slots[existingSlot]
    slot.lastUsed = Date.now()
    slot.boundClients.set(stickyKey, clientName)
    return slot.derivedId
  }

  // 2. Free slot available
  if (table.slots.length < maxSessions) {
    const derived = deriveSessionId(accountId, stickyKey)
    const slotIndex = table.slots.length
    const slot: SessionSlot = {
      derivedId: derived,
      lastUsed: Date.now(),
      boundKeys: new Set([stickyKey]),
      boundClients: new Map([[stickyKey, clientName]]),
      reuseCount: 0,
      createdAt: Date.now(),
    }
    table.slots.push(slot)
    table.keyToSlot.set(stickyKey, slotIndex)

    emitSlotEvent({
      accountId, slotIndex, action: 'created', clientName,
    })
    log('info', `session-slots: account=${accountId} slot=${slotIndex} created for client="${clientName}"`)
    return derived
  }

  // 3. Dynamic max reduction — trim excess slots first
  while (table.slots.length > maxSessions) {
    const removed = trimLruSlot(table, accountId)
    if (!removed) break
  }

  // 4. LRU eviction
  let lruIdx = 0
  let lruTime = Infinity
  for (let i = 0; i < table.slots.length; i++) {
    if (table.slots[i].lastUsed < lruTime) {
      lruTime = table.slots[i].lastUsed
      lruIdx = i
    }
  }

  const slot = table.slots[lruIdx]
  const idleDurationMs = Date.now() - slot.lastUsed

  // Find evicted client name (most recent user of this slot)
  let evictedClient = 'unknown'
  for (const [, name] of slot.boundClients) {
    evictedClient = name
  }

  // Clear old bindings
  for (const oldKey of slot.boundKeys) {
    table.keyToSlot.delete(oldKey)
  }

  // Emit eviction event
  emitSlotEvent({
    accountId, slotIndex: lruIdx, action: 'evicted',
    clientName: evictedClient, idleDurationMs, reuseNumber: slot.reuseCount,
  })

  // Rebind slot — keep derivedId
  slot.boundKeys.clear()
  slot.boundKeys.add(stickyKey)
  slot.boundClients.clear()
  slot.boundClients.set(stickyKey, clientName)
  slot.reuseCount++
  slot.lastUsed = Date.now()

  table.keyToSlot.set(stickyKey, lruIdx)

  // Emit bind event
  emitSlotEvent({
    accountId, slotIndex: lruIdx, action: 'bound',
    clientName, evictedClient, idleDurationMs, reuseNumber: slot.reuseCount,
  })

  log('info', `session-slots: account=${accountId} slot=${lruIdx} LRU reuse #${slot.reuseCount}: "${clientName}" replaced "${evictedClient}" (idle ${Math.round(idleDurationMs / 1000)}s)`)
  return slot.derivedId
}

function trimLruSlot(table: AccountSessionTable, accountId: string): boolean {
  if (table.slots.length === 0) return false
  let lruIdx = 0
  let lruTime = Infinity
  for (let i = 0; i < table.slots.length; i++) {
    if (table.slots[i].lastUsed < lruTime) {
      lruTime = table.slots[i].lastUsed
      lruIdx = i
    }
  }
  const removed = table.slots[lruIdx]
  for (const oldKey of removed.boundKeys) {
    table.keyToSlot.delete(oldKey)
  }
  table.slots.splice(lruIdx, 1)
  // Re-index keyToSlot after splice
  table.keyToSlot.clear()
  for (let i = 0; i < table.slots.length; i++) {
    for (const key of table.slots[i].boundKeys) {
      table.keyToSlot.set(key, i)
    }
  }
  return true
}

// ── Accessors ──

export function getSessionTable(accountId: string): AccountSessionTable | undefined {
  return sessionTables.get(accountId)
}

export function getAllSessionTables(): Map<string, AccountSessionTable> {
  return sessionTables
}

export function resetSessionTables(): void {
  sessionTables.clear()
}

// ── Hydrate from DB rows ──

export function hydrateFromRows(rows: Array<{
  account_id: string
  slot_index: number
  derived_session_id: string
  bound_keys: string[]
  reuse_count: number
  last_used_at: Date
  created_at: Date
}>): void {
  sessionTables.clear()
  for (const row of rows) {
    let table = sessionTables.get(row.account_id)
    if (!table) {
      table = { slots: [], keyToSlot: new Map() }
      sessionTables.set(row.account_id, table)
    }

    // Ensure slots array is large enough
    while (table.slots.length <= row.slot_index) {
      table.slots.push({
        derivedId: '',
        lastUsed: 0,
        boundKeys: new Set(),
        boundClients: new Map(),
        reuseCount: 0,
        createdAt: 0,
      })
    }

    const slot = table.slots[row.slot_index]
    slot.derivedId = row.derived_session_id
    slot.lastUsed = new Date(row.last_used_at).getTime()
    slot.boundKeys = new Set(row.bound_keys)
    slot.reuseCount = row.reuse_count
    slot.createdAt = new Date(row.created_at).getTime()

    for (const key of row.bound_keys) {
      table.keyToSlot.set(key, row.slot_index)
    }
  }
  log('info', `session-slots: hydrated ${sessionTables.size} accounts from DB`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx tests/session-slots.test.ts`
Expected: PASS — all 4 test groups

- [ ] **Step 5: Commit**

```bash
git add src/session-slots.ts tests/session-slots.test.ts
git commit -m "feat: add session-slots module with LRU eviction and slot management"
```

---

### Task 7: Wire session slots into proxy + persistence

**Files:**
- Modify: `src/proxy.ts:711-712, 747, 858-859` (replace deriveSessionId calls)
- Modify: `src/account-pool.ts` (hydrate on startup, persist on events)

- [ ] **Step 1: Replace deriveSessionId calls in proxy.ts**

In `src/proxy.ts`, add import:

```typescript
import { getOrAssignSession } from './session-slots.js'
```

Replace the 3 `deriveSessionId` call sites:

**Site 1** (~line 712, in `applyRewrite` pool branch):
```typescript
      rewriteOpts = {
        profile,
        derivedSessionId: getOrAssignSession(
          account.account.id, stickyKey,
          authResult?.clientName ?? 'unknown',
          account.account.maxSessions,
        ),
      }
```

**Site 2** (~line 747, in `applyRewrite` single-token branch):
```typescript
      rewriteOpts = {
        profile,
        derivedSessionId: getOrAssignSession('single-token', stickyKey, 'single-token', 0),
      }
```

**Site 3** (~line 858-859, in event emitter context):
```typescript
      const derivedSessId = stickyKey
        ? getOrAssignSession(
            selectedAccount.account.id, stickyKey,
            authResult?.clientName ?? clientName,
            selectedAccount.account.maxSessions,
          )
        : ''
```

Remove the `deriveSessionId` import from `identity-rewrite.js` if no longer used in proxy.ts. Keep `extractStickyId` and `buildEffectiveProfile`.

- [ ] **Step 2: Add persistence layer in account-pool.ts**

In `src/account-pool.ts`, add imports and persistence wiring:

```typescript
import { onSlotEvent, hydrateFromRows, type SlotEvent } from './session-slots.js'
```

Add to `startAccountPool()`, after the hydrate version locks block:

```typescript
  // Hydrate session slots from DB
  try {
    const slotRows = await query(
      `SELECT * FROM session_slots WHERE last_used_at > now() - INTERVAL '24 hours' ORDER BY account_id, slot_index`
    )
    if (slotRows.rows.length > 0) {
      hydrateFromRows(slotRows.rows)
      log('info', `account-pool: hydrated ${slotRows.rows.length} session slots from DB`)
    }
  } catch (err) {
    log('debug', `account-pool: session_slots hydrate skipped: ${err}`)
  }

  // Persist slot events to DB (async, fire-and-forget)
  onSlotEvent(async (event: SlotEvent) => {
    try {
      if (event.action === 'created') {
        await query(
          `INSERT INTO session_slots (account_id, slot_index, derived_session_id, bound_keys, reuse_count)
           VALUES ($1, $2, (SELECT derived_session_id FROM session_slots WHERE account_id=$1 AND slot_index=$2 UNION ALL SELECT $3 LIMIT 1), ARRAY[$4], 0)
           ON CONFLICT (account_id, slot_index) DO UPDATE SET bound_keys = ARRAY[$4], last_used_at = now()`,
          [event.accountId, event.slotIndex,
           // Need derivedId — get from the module
           '', event.clientName]
        )
      }
      // Always write history
      await query(
        `INSERT INTO session_slot_history (account_id, slot_index, action, client_name, evicted_client, idle_duration_ms, reuse_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [event.accountId, event.slotIndex, event.action, event.clientName,
         event.evictedClient ?? null, event.idleDurationMs ?? null, event.reuseNumber ?? null]
      )
    } catch (err) {
      log('debug', `session-slots: DB persist failed: ${err}`)
    }
  })
```

Refine the slot `created` persistence — the event listener needs access to the derivedId. Update `SlotEvent` type in `session-slots.ts` to include it:

In `src/session-slots.ts`, add `derivedSessionId` to `SlotEvent`:

```typescript
export type SlotEvent = {
  accountId: string
  slotIndex: number
  action: 'created' | 'bound' | 'evicted'
  clientName: string
  evictedClient?: string
  idleDurationMs?: number
  reuseNumber?: number
  derivedSessionId?: string
}
```

And in the `emitSlotEvent` calls for 'created' and 'bound', add `derivedSessionId: slot.derivedId` or `derived`.

Then fix the persistence query in account-pool:

```typescript
  onSlotEvent(async (event: SlotEvent) => {
    try {
      if (event.action === 'created' || event.action === 'bound') {
        await query(
          `INSERT INTO session_slots (account_id, slot_index, derived_session_id, bound_keys, reuse_count, last_used_at)
           VALUES ($1, $2, $3, ARRAY[$4], $5, now())
           ON CONFLICT (account_id, slot_index) DO UPDATE
           SET bound_keys = ARRAY[$4], reuse_count = $5, last_used_at = now()`,
          [event.accountId, event.slotIndex, event.derivedSessionId ?? '',
           event.clientName, event.reuseNumber ?? 0]
        )
      }
      await query(
        `INSERT INTO session_slot_history (account_id, slot_index, action, client_name, evicted_client, idle_duration_ms, reuse_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [event.accountId, event.slotIndex, event.action, event.clientName,
         event.evictedClient ?? null, event.idleDurationMs ?? null, event.reuseNumber ?? null]
      )
    } catch (err) {
      log('debug', `session-slots: DB persist failed: ${err}`)
    }
  })
```

- [ ] **Step 3: Add cleanup timer**

In `startAccountPool()`, add a cleanup interval:

```typescript
  // Clean up expired session slots every hour
  setInterval(async () => {
    try {
      await query(`DELETE FROM session_slots WHERE last_used_at < now() - INTERVAL '24 hours'`)
      await query(`DELETE FROM session_slot_history WHERE created_at < now() - INTERVAL '7 days'`)
    } catch {}
  }, 3600_000)
```

- [ ] **Step 4: Commit**

```bash
git add src/proxy.ts src/account-pool.ts src/session-slots.ts
git commit -m "feat: wire session slots into proxy flow with DB persistence"
```

---

### Task 8: Session slots API endpoint

**Files:**
- Modify: `server/src/routes/oauth-accounts.ts`

- [ ] **Step 1: Add GET /:id/session-slots endpoint**

In `server/src/routes/oauth-accounts.ts`, add the new route (alongside existing session/refresh routes):

```typescript
// GET /api/admin/oauth-accounts/:id/session-slots
router.get('/:id/session-slots', authMiddleware, adminMiddleware, async (req, res) => {
  const { id } = req.params
  try {
    // Get account max_sessions
    const acctResult = await pool.query(
      'SELECT max_sessions FROM oauth_accounts WHERE id = $1', [id]
    )
    if (acctResult.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }
    const maxSessions = acctResult.rows[0].max_sessions

    // Get current slots
    const slotsResult = await pool.query(
      `SELECT slot_index, derived_session_id, bound_keys, reuse_count, last_used_at, created_at
       FROM session_slots WHERE account_id = $1 ORDER BY slot_index`,
      [id]
    )

    // Get recent history (last 50 events)
    const historyResult = await pool.query(
      `SELECT slot_index, action, client_name, evicted_client, idle_duration_ms, reuse_number, created_at
       FROM session_slot_history WHERE account_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [id]
    )

    const slots = slotsResult.rows.map((r: any) => ({
      slot_index: r.slot_index,
      derived_session_id: r.derived_session_id,
      bound_clients: r.bound_keys || [],
      reuse_count: r.reuse_count,
      last_used_at: r.last_used_at,
      created_at: r.created_at,
      status: (Date.now() - new Date(r.last_used_at).getTime()) < 300_000 ? 'active' : 'idle',
    }))

    res.json({
      max_sessions: maxSessions,
      slots,
      history: historyResult.rows,
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
```

- [ ] **Step 2: Add session_slots to account stats in GET /api/admin/oauth-accounts**

In the existing GET `/` handler that fetches account stats, add slot count:

```typescript
    // After existing Redis stats fetching, add:
    let slotUsed = 0
    try {
      const slotCount = await pool.query(
        `SELECT COUNT(*)::int AS n FROM session_slots WHERE account_id = $1 AND last_used_at > now() - INTERVAL '24 hours'`,
        [account.id]
      )
      slotUsed = slotCount.rows[0]?.n ?? 0
    } catch {}

    // Add to stats object:
    stats.session_slots = { used: slotUsed, max: account.max_sessions }
```

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/oauth-accounts.ts
git commit -m "feat: add session-slots API endpoint and stats"
```

---

### Task 9: Frontend — Session Slots section in account detail

**Files:**
- Modify: `web/src/pages/admin/AdminAccountsPage.tsx`

- [ ] **Step 1: Add session slots data fetching**

Add a state and fetch function for slot data when a slot detail is expanded:

```typescript
const [slotData, setSlotData] = useState<Record<string, any>>({})
const [expandedSlot, setExpandedSlot] = useState<Record<string, number | null>>({})

const fetchSlotData = async (accountId: string) => {
  try {
    const res = await api.get(`/admin/oauth-accounts/${accountId}/session-slots`)
    setSlotData(prev => ({ ...prev, [accountId]: res.data }))
  } catch {}
}
```

- [ ] **Step 2: Add SessionSlots component**

```tsx
function SessionSlotsSection({ account, stats }: { account: OAuthAccount; stats: AccountStats }) {
  const [data, setData] = useState<any>(null)
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)

  useEffect(() => {
    api.get(`/admin/oauth-accounts/${account.id}/session-slots`)
      .then(res => setData(res.data))
      .catch(() => {})
  }, [account.id])

  const used = stats?.session_slots?.used ?? 0
  const max = stats?.session_slots?.max ?? account.max_sessions ?? 3

  return (
    <div style={{ padding: '16px 0', borderTop: '1px solid #e2e2ea' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6b6b80' }}>
          Session Slots
        </span>
        <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#9b9bae' }}>
          <span style={{ color: '#1a1a2e' }}>{used}</span> / {max}
        </span>
      </div>

      {/* Usage bar */}
      <div style={{ display: 'flex', gap: 3, height: 4, marginBottom: 14, borderRadius: 2, overflow: 'hidden' }}>
        {Array.from({ length: max }, (_, i) => {
          const slot = data?.slots?.[i]
          const color = !slot ? '#e2e2ea'
            : (Date.now() - new Date(slot.last_used_at).getTime() < 300_000) ? '#16a34a' : '#d97706'
          return <div key={i} style={{ flex: 1, background: color, borderRadius: 2 }} />
        })}
      </div>

      {/* Slot rows */}
      {data?.slots?.map((slot: any) => (
        <div key={slot.slot_index}
          style={{
            background: '#f8f8fa', borderRadius: 7, padding: '10px 12px', marginBottom: 6,
            border: expandedIdx === slot.slot_index ? '1px solid #d0d0dc' : '1px solid transparent',
            cursor: 'pointer',
          }}
          onClick={() => setExpandedIdx(expandedIdx === slot.slot_index ? null : slot.slot_index)}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#9b9bae', border: '1px solid #e2e2ea', borderRadius: 4, width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {slot.slot_index}
            </span>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: slot.status === 'active' ? '#16a34a' : '#d97706'
            }} />
            <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#6b6b80', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {slot.derived_session_id}
            </span>
            <span style={{ fontFamily: 'monospace', fontSize: 11, color: slot.status === 'active' ? '#16a34a' : '#9b9bae' }}>
              {formatRelativeTime(slot.last_used_at)}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, paddingLeft: 28 }}>
            {slot.bound_clients?.map((c: string) => (
              <span key={c} style={{
                fontFamily: 'monospace', fontSize: 10, padding: '2px 6px', borderRadius: 3,
                color: slot.status === 'active' ? '#16a34a' : '#d97706',
                background: slot.status === 'active' ? '#f0fdf4' : '#fffbeb',
                border: `1px solid ${slot.status === 'active' ? '#bbf7d0' : '#fde68a'}`,
              }}>{c}</span>
            ))}
            {slot.reuse_count > 0 && (
              <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#9b9bae', marginLeft: 'auto' }}>
                ×{slot.reuse_count}
              </span>
            )}
          </div>

          {/* Expanded: history timeline */}
          {expandedIdx === slot.slot_index && data?.history && (
            <div style={{ marginTop: 10, marginLeft: 28, borderLeft: '2px solid #e2e2ea', paddingLeft: 12 }}>
              <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#9b9bae', marginBottom: 6 }}>
                Reuse History
              </div>
              {data.history
                .filter((h: any) => h.slot_index === slot.slot_index)
                .slice(0, 10)
                .map((h: any, i: number) => (
                  <div key={i} style={{ fontSize: 11, padding: '4px 0', borderTop: i > 0 ? '1px solid #f0f0f5' : 'none', display: 'flex', gap: 8 }}>
                    <span style={{ flex: 1 }}>
                      <span style={{ color: h.action === 'evicted' ? '#dc2626' : '#16a34a', fontWeight: 600 }}>
                        {h.action === 'created' ? 'Created' : h.action === 'bound' ? 'Bound' : 'Evicted'}
                      </span>
                      {' '}<span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{h.client_name}</span>
                      {h.evicted_client && (
                        <> · <span style={{ color: '#dc2626' }}>Evicted</span> <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{h.evicted_client}</span></>
                      )}
                    </span>
                    <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#9b9bae', flexShrink: 0 }}>
                      {new Date(h.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
            </div>
          )}
        </div>
      ))}

      {/* Empty slots */}
      {data && Array.from({ length: Math.max(0, max - (data.slots?.length ?? 0)) }, (_, i) => (
        <div key={`empty-${i}`} style={{
          background: '#f8f8fa', borderRadius: 7, padding: '10px 12px', marginBottom: 6,
          border: '1px dashed #e2e2ea', opacity: 0.5,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#9b9bae', border: '1px solid #e2e2ea', borderRadius: 4, width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {(data.slots?.length ?? 0) + i}
            </span>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#9ca3af' }} />
            <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#9b9bae', fontStyle: 'italic' }}>— unallocated —</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return `${Math.floor(diff / 86400_000)}d ago`
}
```

- [ ] **Step 3: Insert SessionSlotsSection into AccountDetailCard**

Find the detail card component. Insert `<SessionSlotsSection>` after the real-time status block (concurrent/RPM/TPM section), before the footer:

```tsx
<SessionSlotsSection account={account} stats={account.stats} />
```

- [ ] **Step 4: Build and verify frontend**

```bash
cd web && npm run build
```

Expected: Build succeeds with no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/admin/AdminAccountsPage.tsx
git commit -m "feat: add Session Slots section to account detail card"
```

---

### Task 10: Add session-slots test to test script + final verification

**Files:**
- Modify: `package.json` (test script)

- [ ] **Step 1: Add session-slots test to package.json**

In `package.json`, append to the test script:

```json
"test": "tsx tests/rewriter.test.ts && tsx tests/sync.test.ts && tsx tests/metering.test.ts && tsx tests/rate-limiter.test.ts && tsx tests/quota-checker.test.ts && tsx tests/request-logger.test.ts && tsx tests/session-slots.test.ts"
```

- [ ] **Step 2: Run all tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add session-slots test to test suite"
```

- [ ] **Step 4: Deploy and verify**

```bash
rsync -avz --exclude='config.yaml' --exclude='fullchain.pem' --exclude='privkey.pem' \
  --exclude='node_modules/' --exclude='dist/' --exclude='.superpowers/' \
  --exclude='server/node_modules/' --exclude='server/dist/' \
  --exclude='web/node_modules/' --exclude='web/dist/' \
  --exclude='/clients/' --exclude='.DS_Store' --exclude='.claude/' \
  -e "ssh -o StrictHostKeyChecking=no" \
  ./ root@1.2.3.4:/home/ubuntu/gw/

ssh root@1.2.3.4 "cd /home/ubuntu/gw && npm install && cd server && npm install && cd ../web && npm install && npm run build"
ssh root@1.2.3.4 "cp -r /home/ubuntu/gw/web/dist/* /opt/1panel/www/gw.example.com/"
ssh root@1.2.3.4 "cd /home/ubuntu/gw && pm2 restart ecosystem.config.cjs"
```

Verify on dashboard: account detail cards show Session Slots section.
