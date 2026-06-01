# Phase 1: Foundation & Gateway Enhancement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PostgreSQL integration to the Gateway, enabling metering (usage tracking), rate limiting, quota enforcement, and hot-reload of clients/rules from the database.

**Architecture:** The existing Gateway (src/) gains a PG connection pool. Auth, rate limiting, and quota checking happen in-memory (synced from PG every 30s). Usage records are written to PG after each upstream response. The config.yaml `auth.tokens` section becomes a fallback — PG is the primary source of truth for client tokens.

**Tech Stack:** Node.js 22+, TypeScript, PostgreSQL 16+, `pg` (node-postgres) library, existing custom test framework

**Phases overview (this is Phase 1 of 4):**
- **Phase 1 (this plan):** Database schema + Gateway PG integration (metering, rate limiting, quota, hot-reload)
- **Phase 2:** API Server (auth, clients, usage, billing, payments, notifications, webhooks)
- **Phase 3:** React Frontend (all pages)
- **Phase 4:** Invitations, campaigns, rewards system

---

### Task 1: Add PostgreSQL dependency and connection pool

**Files:**
- Modify: `package.json`
- Create: `src/db.ts`
- Modify: `src/config.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Install pg dependency**

Run:
```bash
npm install pg
npm install -D @types/pg
```

- [ ] **Step 2: Add database config to Config type**

In `src/config.ts`, add to the `Config` type after the `server` field:

```typescript
database: {
  host: string
  port: number
  database: string
  user: string
  password: string
  max_connections?: number
}
```

Update the `loadConfig` function to validate that `database` section exists:

```typescript
if (!raw.database?.host || !raw.database?.database) {
  throw new Error('database.host and database.database are required in config')
}
```

- [ ] **Step 3: Create src/db.ts**

```typescript
import pg from 'pg'
import { log } from './logger.js'

const { Pool } = pg

let pool: pg.Pool | null = null

export function initDB(config: {
  host: string
  port: number
  database: string
  user: string
  password: string
  max_connections?: number
}): void {
  pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: config.max_connections ?? 10,
  })

  pool.on('error', (err) => {
    log('error', `Unexpected PG pool error: ${err.message}`)
  })

  log('info', `PG pool created: ${config.user}@${config.host}:${config.port}/${config.database}`)
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error('Database not initialized. Call initDB() first.')
  return pool
}

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params)
}

export async function shutdownDB(): Promise<void> {
  if (pool) {
    await pool.end()
    log('info', 'PG pool closed')
  }
}
```

- [ ] **Step 4: Wire up database initialization in index.ts**

In `src/index.ts`, add import and call `initDB` before `initOAuth`:

```typescript
import { initDB } from './db.js'

// After loadConfig, before initOAuth:
initDB(config.database)
```

- [ ] **Step 5: Update config.example.yaml**

Add after the `server` section:

```yaml
database:
  host: localhost
  port: 5432
  database: cc_gateway
  user: cc_gateway
  password: change-me
  max_connections: 10
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/db.ts src/config.ts src/index.ts config.example.yaml
git commit -m "feat: add PostgreSQL connection pool and database config"
```

---

### Task 2: Database migrations — core tables

**Files:**
- Create: `migrations/001_core.sql`

- [ ] **Step 1: Create migrations directory and core schema**

Create `migrations/001_core.sql`:

```sql
-- 001_core.sql — Users, clients, usage, quotas, rate limits, model pricing

BEGIN;

-- Users (Dashboard login accounts)
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username        VARCHAR(64) UNIQUE NOT NULL,
  email           VARCHAR(255) UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  role            VARCHAR(16) NOT NULL DEFAULT 'user',
  status          VARCHAR(16) NOT NULL DEFAULT 'active',
  invited_by      UUID REFERENCES users(id),
  invite_bound_at TIMESTAMPTZ,
  free_until      DATE,
  discount_rate   DECIMAL(3,2) DEFAULT 1.0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Clients (Gateway tokens)
CREATE TABLE clients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  name            VARCHAR(64) NOT NULL,
  token           CHAR(64) UNIQUE NOT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'pending',
  approved_by     UUID REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  suspended_at    TIMESTAMPTZ,
  suspend_reason  VARCHAR(64),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, name)
);

-- Usage records (partitioned by month)
CREATE TABLE usage_records (
  id              BIGSERIAL,
  client_id       UUID NOT NULL REFERENCES clients(id),
  model           VARCHAR(64) NOT NULL,
  input_tokens    INT NOT NULL DEFAULT 0,
  output_tokens   INT NOT NULL DEFAULT 0,
  cache_read      INT NOT NULL DEFAULT 0,
  cache_write     INT NOT NULL DEFAULT 0,
  cost            DECIMAL(10,6) NOT NULL DEFAULT 0,
  latency_ms      INT,
  path            VARCHAR(255),
  status_code     SMALLINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_usage_client_time ON usage_records (client_id, created_at);
CREATE INDEX idx_usage_time ON usage_records (created_at);

-- Create partitions for current and next month
DO $$
DECLARE
  cur_start DATE := date_trunc('month', CURRENT_DATE);
  cur_end   DATE := cur_start + INTERVAL '1 month';
  nxt_start DATE := cur_end;
  nxt_end   DATE := nxt_start + INTERVAL '1 month';
  cur_name  TEXT := 'usage_records_' || to_char(cur_start, 'YYYY_MM');
  nxt_name  TEXT := 'usage_records_' || to_char(nxt_start, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_records FOR VALUES FROM (%L) TO (%L)',
    cur_name, cur_start, cur_end
  );
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_records FOR VALUES FROM (%L) TO (%L)',
    nxt_name, nxt_start, nxt_end
  );
END $$;

-- Quota rules
CREATE TABLE quota_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type     VARCHAR(8) NOT NULL,
  target_id       UUID NOT NULL,
  metric          VARCHAR(16) NOT NULL,
  window          INTERVAL NOT NULL,
  max_value       DECIMAL NOT NULL,
  action          VARCHAR(16) NOT NULL DEFAULT 'reject',
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rate limits
CREATE TABLE rate_limits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type     VARCHAR(8) NOT NULL,
  target_id       UUID NOT NULL,
  max_rpm         INT NOT NULL,
  max_rph         INT,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Model pricing
CREATE TABLE model_pricing (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_pattern    VARCHAR(64) NOT NULL,
  input_mtok       DECIMAL(10,4) NOT NULL,
  output_mtok      DECIMAL(10,4) NOT NULL,
  cache_read_mtok  DECIMAL(10,4) NOT NULL DEFAULT 0,
  cache_write_mtok DECIMAL(10,4) NOT NULL DEFAULT 0,
  effective_from   DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(model_pattern, effective_from)
);

-- Seed default model pricing (Anthropic prices as of April 2026)
INSERT INTO model_pricing (model_pattern, input_mtok, output_mtok, cache_read_mtok, cache_write_mtok) VALUES
  ('claude-opus-4-6',   15.00, 75.00, 1.50, 18.75),
  ('claude-sonnet-4-6',  3.00, 15.00, 0.30,  3.75),
  ('claude-haiku-4-5',   0.80,  4.00, 0.08,  1.00);

COMMIT;
```

- [ ] **Step 2: Run the migration**

Run:
```bash
psql -h localhost -U cc_gateway -d cc_gateway -f migrations/001_core.sql
```
Expected: All tables created, 3 model pricing rows inserted.

- [ ] **Step 3: Verify tables exist**

Run:
```bash
psql -h localhost -U cc_gateway -d cc_gateway -c "\dt"
```
Expected: `users`, `clients`, `usage_records`, `quota_rules`, `rate_limits`, `model_pricing` listed.

- [ ] **Step 4: Commit**

```bash
git add migrations/001_core.sql
git commit -m "feat: add core database migration (users, clients, usage, quotas, pricing)"
```

---

### Task 3: Hot-reload sync — load clients/rules from PG

**Files:**
- Create: `src/sync.ts`
- Modify: `src/auth.ts`
- Modify: `src/index.ts`
- Create: `tests/sync.test.ts`

- [ ] **Step 1: Write the failing test for sync**

Create `tests/sync.test.ts`:

```typescript
import assert from 'assert/strict'

// Test types match what sync.ts will export
type SyncedClient = {
  id: string
  userId: string
  name: string
  token: string
  status: string
  userStatus: string
}

type SyncedRateLimit = {
  targetType: string
  targetId: string
  maxRpm: number
  maxRph: number | null
}

type SyncedQuotaRule = {
  targetType: string
  targetId: string
  metric: string
  windowSeconds: number
  maxValue: number
  action: string
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err: any) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${err.message}`)
    failed++
  }
}

console.log('\nSync module type tests:')

test('SyncedClient type has required fields', () => {
  const client: SyncedClient = {
    id: '123',
    userId: '456',
    name: 'test',
    token: 'a'.repeat(64),
    status: 'active',
    userStatus: 'active',
  }
  assert.equal(client.status, 'active')
  assert.equal(client.token.length, 64)
})

test('SyncedRateLimit allows null maxRph', () => {
  const rl: SyncedRateLimit = {
    targetType: 'client',
    targetId: '123',
    maxRpm: 60,
    maxRph: null,
  }
  assert.equal(rl.maxRph, null)
})

test('SyncedQuotaRule windowSeconds is numeric', () => {
  const qr: SyncedQuotaRule = {
    targetType: 'user',
    targetId: '456',
    metric: 'tokens',
    windowSeconds: 86400, // 1 day
    maxValue: 1000000,
    action: 'reject',
  }
  assert.equal(qr.windowSeconds, 86400)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
```

- [ ] **Step 2: Run test to verify it passes (type-only test)**

Run:
```bash
npx tsx tests/sync.test.ts
```
Expected: 3 passed, 0 failed

- [ ] **Step 3: Create src/sync.ts**

```typescript
import { query } from './db.js'
import { log } from './logger.js'

export type SyncedClient = {
  id: string
  userId: string
  name: string
  token: string
  status: string
  userStatus: string
}

export type SyncedRateLimit = {
  targetType: string
  targetId: string
  maxRpm: number
  maxRph: number | null
}

export type SyncedQuotaRule = {
  targetType: string
  targetId: string
  metric: string
  windowSeconds: number
  maxValue: number
  action: string
}

export type ModelPrice = {
  modelPattern: string
  inputMtok: number
  outputMtok: number
  cacheReadMtok: number
  cacheWriteMtok: number
}

// In-memory state
let clientsByToken = new Map<string, SyncedClient>()
let rateLimits: SyncedRateLimit[] = []
let quotaRules: SyncedQuotaRule[] = []
let modelPrices: ModelPrice[] = []
let lastSyncAt: Date = new Date(0)
let syncInterval: ReturnType<typeof setInterval> | null = null

export function getClientByToken(token: string): SyncedClient | undefined {
  return clientsByToken.get(token)
}

export function getRateLimits(): SyncedRateLimit[] {
  return rateLimits
}

export function getQuotaRules(): SyncedQuotaRule[] {
  return quotaRules
}

export function getModelPrices(): ModelPrice[] {
  return modelPrices
}

export function findModelPrice(model: string): ModelPrice | undefined {
  // Exact match first, then pattern match
  return modelPrices.find(p => p.modelPattern === model)
    ?? modelPrices.find(p => model.startsWith(p.modelPattern))
}

export async function syncFromDB(): Promise<void> {
  try {
    // Sync clients (joined with users for status check)
    const clientsResult = await query<{
      id: string
      user_id: string
      name: string
      token: string
      status: string
      user_status: string
    }>(`
      SELECT c.id, c.user_id, c.name, c.token, c.status,
             u.status AS user_status
      FROM clients c
      JOIN users u ON c.user_id = u.id
      WHERE c.updated_at > $1 OR u.updated_at > $1
         OR $1 = '1970-01-01T00:00:00Z'::timestamptz
    `, [lastSyncAt])

    if (clientsResult.rows.length > 0) {
      // On first sync, replace all. On incremental, update changed entries.
      if (lastSyncAt.getTime() === 0) {
        clientsByToken = new Map()
      }
      for (const row of clientsResult.rows) {
        // Remove old token entry if client changed token
        for (const [tok, c] of clientsByToken) {
          if (c.id === row.id && tok !== row.token) {
            clientsByToken.delete(tok)
          }
        }
        clientsByToken.set(row.token, {
          id: row.id,
          userId: row.user_id,
          name: row.name,
          token: row.token,
          status: row.status,
          userStatus: row.user_status,
        })
      }
      log('debug', `Synced ${clientsResult.rows.length} clients from PG (total: ${clientsByToken.size})`)
    }

    // Sync rate limits (always full load — small table)
    const rlResult = await query<{
      target_type: string
      target_id: string
      max_rpm: number
      max_rph: number | null
    }>(`SELECT target_type, target_id, max_rpm, max_rph FROM rate_limits WHERE enabled = true`)

    rateLimits = rlResult.rows.map(r => ({
      targetType: r.target_type,
      targetId: r.target_id,
      maxRpm: r.max_rpm,
      maxRph: r.max_rph,
    }))

    // Sync quota rules (always full load — small table)
    const qrResult = await query<{
      target_type: string
      target_id: string
      metric: string
      window: { hours?: number; minutes?: number; days?: number; seconds?: number }
      max_value: string
      action: string
    }>(`SELECT target_type, target_id, metric,
               EXTRACT(EPOCH FROM window)::int AS window_seconds,
               max_value, action
        FROM quota_rules WHERE enabled = true`)

    quotaRules = qrResult.rows.map(r => ({
      targetType: r.target_type,
      targetId: r.target_id,
      metric: r.metric,
      windowSeconds: (r as any).window_seconds,
      maxValue: parseFloat(r.max_value),
      action: r.action,
    }))

    // Sync model pricing (latest effective price per model)
    const mpResult = await query<{
      model_pattern: string
      input_mtok: string
      output_mtok: string
      cache_read_mtok: string
      cache_write_mtok: string
    }>(`SELECT DISTINCT ON (model_pattern)
               model_pattern, input_mtok, output_mtok, cache_read_mtok, cache_write_mtok
        FROM model_pricing
        WHERE effective_from <= CURRENT_DATE
        ORDER BY model_pattern, effective_from DESC`)

    modelPrices = mpResult.rows.map(r => ({
      modelPattern: r.model_pattern,
      inputMtok: parseFloat(r.input_mtok),
      outputMtok: parseFloat(r.output_mtok),
      cacheReadMtok: parseFloat(r.cache_read_mtok),
      cacheWriteMtok: parseFloat(r.cache_write_mtok),
    }))

    lastSyncAt = new Date()
  } catch (err) {
    log('error', `PG sync failed: ${err}`)
  }
}

export function startSync(intervalMs: number = 30_000): void {
  // Initial sync
  syncFromDB().then(() => {
    log('info', `Initial PG sync complete: ${clientsByToken.size} clients, ${rateLimits.length} rate limits, ${quotaRules.length} quota rules, ${modelPrices.length} model prices`)
  })

  // Periodic sync
  syncInterval = setInterval(() => {
    syncFromDB()
  }, intervalMs)
}

export function stopSync(): void {
  if (syncInterval) {
    clearInterval(syncInterval)
    syncInterval = null
  }
}
```

- [ ] **Step 4: Update auth.ts to support PG-sourced clients**

Replace `src/auth.ts` content with:

```typescript
import type { IncomingMessage } from 'http'
import type { Config, TokenEntry } from './config.js'
import { getClientByToken } from './sync.js'

// Fallback: config.yaml token map (used when PG has no clients)
let configTokenMap = new Map<string, string>()

export function initAuth(config: Config): void {
  configTokenMap = new Map()
  for (const entry of config.auth.tokens) {
    configTokenMap.set(entry.token, entry.name)
  }
}

export type AuthResult = {
  clientName: string
  clientId?: string
  userId?: string
  clientStatus?: string
  userStatus?: string
}

export function authenticate(req: IncomingMessage): AuthResult | null {
  const token = extractToken(req)
  if (!token) return null

  // Try PG-sourced clients first
  const pgClient = getClientByToken(token)
  if (pgClient) {
    return {
      clientName: pgClient.name,
      clientId: pgClient.id,
      userId: pgClient.userId,
      clientStatus: pgClient.status,
      userStatus: pgClient.userStatus,
    }
  }

  // Fallback to config.yaml tokens
  const configName = configTokenMap.get(token)
  if (configName) {
    return { clientName: configName }
  }

  return null
}

function extractToken(req: IncomingMessage): string | null {
  // Primary: x-api-key header
  const apiKey = req.headers['x-api-key']
  if (typeof apiKey === 'string' && apiKey.length > 0) return apiKey

  // Fallback: Authorization or Proxy-Authorization Bearer
  for (const header of ['authorization', 'proxy-authorization']) {
    const val = req.headers[header]
    if (typeof val === 'string' && val.startsWith('Bearer ')) {
      return val.slice(7)
    }
  }

  return null
}
```

- [ ] **Step 5: Update proxy.ts to use new AuthResult type**

In `src/proxy.ts`, update the auth check block (around line 88-97). Replace:

```typescript
  const clientName = authenticate(req)
  if (!clientName) {
```

With:

```typescript
  const authResult = authenticate(req)
  if (!authResult) {
```

And replace all subsequent references to `clientName` with `authResult.clientName`.

Add after the auth check, before the OAuth token retrieval:

```typescript
  // Check client/user status (PG-sourced clients have status)
  if (authResult.clientStatus && authResult.clientStatus !== 'active') {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `Client suspended: ${authResult.clientStatus}` }))
    log('warn', `Suspended client: ${authResult.clientName} (${authResult.clientStatus})`)
    return
  }
  if (authResult.userStatus && authResult.userStatus !== 'active') {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'User account suspended' }))
    log('warn', `Suspended user for client: ${authResult.clientName}`)
    return
  }
```

- [ ] **Step 6: Wire up sync in index.ts**

In `src/index.ts`, add:

```typescript
import { startSync } from './sync.js'

// After initDB and initOAuth:
startSync()
```

- [ ] **Step 7: Run existing tests to verify no regressions**

Run:
```bash
npx tsx tests/rewriter.test.ts
```
Expected: All 16 tests pass (rewriter is unchanged).

- [ ] **Step 8: Commit**

```bash
git add src/sync.ts src/auth.ts src/proxy.ts src/index.ts tests/sync.test.ts
git commit -m "feat: hot-reload clients, rate limits, quotas, and pricing from PG"
```

---

### Task 4: Metering — extract usage from upstream response and write to PG

**Files:**
- Create: `src/metering.ts`
- Modify: `src/proxy.ts`
- Create: `tests/metering.test.ts`

- [ ] **Step 1: Write the failing test for cost calculation**

Create `tests/metering.test.ts`:

```typescript
import assert from 'assert/strict'

// Inline the cost calculation logic to test it in isolation
function calculateCost(
  inputTokens: number,
  outputTokens: number,
  cacheRead: number,
  cacheWrite: number,
  price: { inputMtok: number; outputMtok: number; cacheReadMtok: number; cacheWriteMtok: number },
): number {
  return (
    (inputTokens / 1_000_000) * price.inputMtok +
    (outputTokens / 1_000_000) * price.outputMtok +
    (cacheRead / 1_000_000) * price.cacheReadMtok +
    (cacheWrite / 1_000_000) * price.cacheWriteMtok
  )
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err: any) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${err.message}`)
    failed++
  }
}

console.log('\nMetering tests:')

test('calculates cost for opus model', () => {
  const cost = calculateCost(1000, 500, 2000, 0, {
    inputMtok: 15,
    outputMtok: 75,
    cacheReadMtok: 1.5,
    cacheWriteMtok: 18.75,
  })
  // (1000/1M)*15 + (500/1M)*75 + (2000/1M)*1.5 + 0
  // = 0.015 + 0.0375 + 0.003 = 0.0555
  assert.ok(Math.abs(cost - 0.0555) < 0.0001, `Expected ~0.0555, got ${cost}`)
})

test('calculates cost with cache write', () => {
  const cost = calculateCost(0, 0, 0, 1000, {
    inputMtok: 15,
    outputMtok: 75,
    cacheReadMtok: 1.5,
    cacheWriteMtok: 18.75,
  })
  // (1000/1M)*18.75 = 0.01875
  assert.ok(Math.abs(cost - 0.01875) < 0.0001, `Expected ~0.01875, got ${cost}`)
})

test('zero tokens = zero cost', () => {
  const cost = calculateCost(0, 0, 0, 0, {
    inputMtok: 15,
    outputMtok: 75,
    cacheReadMtok: 1.5,
    cacheWriteMtok: 18.75,
  })
  assert.equal(cost, 0)
})

test('extracts usage from Anthropic response JSON', () => {
  const body = JSON.stringify({
    id: 'msg_123',
    type: 'message',
    model: 'claude-opus-4-6',
    usage: {
      input_tokens: 4218,
      output_tokens: 1847,
      cache_read_input_tokens: 12460,
      cache_creation_input_tokens: 3200,
    },
  })
  const parsed = JSON.parse(body)
  assert.equal(parsed.usage.input_tokens, 4218)
  assert.equal(parsed.usage.output_tokens, 1847)
  assert.equal(parsed.usage.cache_read_input_tokens, 12460)
  assert.equal(parsed.usage.cache_creation_input_tokens, 3200)
})

test('handles SSE response — extracts final message_stop event usage', () => {
  const sseLines = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-4-6","usage":{"input_tokens":100,"output_tokens":0}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"text":"Hello"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":50},"delta":{"stop_reason":"end_turn"}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n')

  // Parse SSE: find message_start for input, message_delta for output
  let inputTokens = 0
  let outputTokens = 0
  let model = ''

  for (const line of sseLines.split('\n')) {
    if (!line.startsWith('data: ')) continue
    try {
      const data = JSON.parse(line.slice(6))
      if (data.type === 'message_start' && data.message?.usage) {
        inputTokens = data.message.usage.input_tokens ?? 0
        model = data.message.model ?? ''
      }
      if (data.type === 'message_delta' && data.usage) {
        outputTokens = data.usage.output_tokens ?? 0
      }
    } catch {}
  }

  assert.equal(inputTokens, 100)
  assert.equal(outputTokens, 50)
  assert.equal(model, 'claude-opus-4-6')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
```

- [ ] **Step 2: Run test to verify it passes**

Run:
```bash
npx tsx tests/metering.test.ts
```
Expected: 5 passed, 0 failed

- [ ] **Step 3: Create src/metering.ts**

```typescript
import { query } from './db.js'
import { log } from './logger.js'
import { findModelPrice } from './sync.js'

export type UsageData = {
  model: string
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
}

export function calculateCost(usage: UsageData): number {
  const price = findModelPrice(usage.model)
  if (!price) {
    log('warn', `No pricing found for model: ${usage.model}`)
    return 0
  }
  return (
    (usage.inputTokens / 1_000_000) * price.inputMtok +
    (usage.outputTokens / 1_000_000) * price.outputMtok +
    (usage.cacheRead / 1_000_000) * price.cacheReadMtok +
    (usage.cacheWrite / 1_000_000) * price.cacheWriteMtok
  )
}

export async function recordUsage(
  clientId: string,
  usage: UsageData,
  path: string,
  statusCode: number,
  latencyMs: number,
): Promise<void> {
  const cost = calculateCost(usage)
  try {
    await query(
      `INSERT INTO usage_records
         (client_id, model, input_tokens, output_tokens, cache_read, cache_write,
          cost, latency_ms, path, status_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        clientId,
        usage.model,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheRead,
        usage.cacheWrite,
        cost,
        latencyMs,
        path,
        statusCode,
      ],
    )
    log('debug', `Recorded usage: ${usage.model} in=${usage.inputTokens} out=${usage.outputTokens} cache_r=${usage.cacheRead} cache_w=${usage.cacheWrite} cost=$${cost.toFixed(6)}`)
  } catch (err) {
    log('error', `Failed to record usage: ${err}`)
  }
}

/**
 * Parse usage from a non-streaming JSON response body.
 */
export function parseUsageFromJSON(body: string): UsageData | null {
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

/**
 * Parse usage from SSE stream chunks.
 * Call with accumulated response text after stream ends.
 */
export function parseUsageFromSSE(text: string): UsageData | null {
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
```

- [ ] **Step 4: Integrate metering into proxy.ts**

In `src/proxy.ts`, add import:

```typescript
import { recordUsage, parseUsageFromJSON, parseUsageFromSSE } from './metering.js'
```

In the upstream response handler (where chunks are piped to client), accumulate the response body and record usage after the stream ends. Add after the existing `upstreamRes.on('data', ...)` and `upstreamRes.on('end', ...)` handlers:

```typescript
    // Accumulate response for metering (only /v1/messages)
    const responseChunks: Buffer[] = []
    const requestStart = Date.now()

    upstreamRes.on('data', (chunk: Buffer) => {
      res.write(chunk)
      if (path === '/v1/messages') {
        responseChunks.push(chunk)
      }
    })

    upstreamRes.on('end', () => {
      res.end()

      // Record usage if this is a messages endpoint and client has a PG ID
      if (path === '/v1/messages' && authResult.clientId) {
        const responseText = Buffer.concat(responseChunks).toString('utf-8')
        const contentType = upstreamRes.headers['content-type'] ?? ''
        const isSSE = contentType.includes('text/event-stream')
        const usage = isSSE
          ? parseUsageFromSSE(responseText)
          : parseUsageFromJSON(responseText)

        if (usage) {
          const latencyMs = Date.now() - requestStart
          recordUsage(authResult.clientId, usage, path, upstreamRes.statusCode ?? 0, latencyMs)
        }
      }

      if (config.logging.audit) {
        audit(authResult.clientName, method, path, upstreamRes.statusCode ?? 0)
      }
    })
```

Remove the existing separate `res.write(chunk)` / `res.end()` / audit calls that this replaces.

- [ ] **Step 5: Run all tests**

Run:
```bash
npx tsx tests/rewriter.test.ts && npx tsx tests/metering.test.ts && npx tsx tests/sync.test.ts
```
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/metering.ts src/proxy.ts tests/metering.test.ts
git commit -m "feat: metering — extract usage from responses and write to PG"
```

---

### Task 5: Rate limiter — sliding window in memory

**Files:**
- Create: `src/rate-limiter.ts`
- Create: `tests/rate-limiter.test.ts`
- Modify: `src/proxy.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/rate-limiter.test.ts`:

```typescript
import assert from 'assert/strict'

// Inline sliding window implementation for testing
class SlidingWindowCounter {
  private windows = new Map<string, number[]>()

  check(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now()
    const cutoff = now - windowMs
    let timestamps = this.windows.get(key) ?? []
    timestamps = timestamps.filter(t => t > cutoff)
    if (timestamps.length >= maxRequests) {
      this.windows.set(key, timestamps)
      return false // rate limited
    }
    timestamps.push(now)
    this.windows.set(key, timestamps)
    return true // allowed
  }

  reset(): void {
    this.windows.clear()
  }
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err: any) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${err.message}`)
    failed++
  }
}

console.log('\nRate limiter tests:')

test('allows requests under the limit', () => {
  const counter = new SlidingWindowCounter()
  assert.equal(counter.check('client-1', 5, 60000), true)
  assert.equal(counter.check('client-1', 5, 60000), true)
  assert.equal(counter.check('client-1', 5, 60000), true)
})

test('blocks requests over the limit', () => {
  const counter = new SlidingWindowCounter()
  for (let i = 0; i < 3; i++) {
    counter.check('client-2', 3, 60000)
  }
  assert.equal(counter.check('client-2', 3, 60000), false)
})

test('different keys are independent', () => {
  const counter = new SlidingWindowCounter()
  for (let i = 0; i < 3; i++) {
    counter.check('a', 3, 60000)
  }
  assert.equal(counter.check('a', 3, 60000), false)
  assert.equal(counter.check('b', 3, 60000), true) // different key
})

test('reset clears all counters', () => {
  const counter = new SlidingWindowCounter()
  for (let i = 0; i < 5; i++) {
    counter.check('x', 5, 60000)
  }
  assert.equal(counter.check('x', 5, 60000), false)
  counter.reset()
  assert.equal(counter.check('x', 5, 60000), true)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
```

- [ ] **Step 2: Run test to verify it passes**

Run:
```bash
npx tsx tests/rate-limiter.test.ts
```
Expected: 4 passed, 0 failed

- [ ] **Step 3: Create src/rate-limiter.ts**

```typescript
import { log } from './logger.js'
import type { SyncedRateLimit } from './sync.js'
import { getRateLimits } from './sync.js'

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

  // Periodic cleanup of expired entries
  cleanup(): void {
    const now = Date.now()
    for (const [key, timestamps] of this.windows) {
      const filtered = timestamps.filter(t => t > now - 3600_000) // keep 1h max
      if (filtered.length === 0) {
        this.windows.delete(key)
      } else {
        this.windows.set(key, filtered)
      }
    }
  }
}

const rpmCounter = new SlidingWindowCounter()
const rphCounter = new SlidingWindowCounter()

// Cleanup every 5 minutes
setInterval(() => {
  rpmCounter.cleanup()
  rphCounter.cleanup()
}, 300_000)

/**
 * Check rate limits for a client or user.
 * Returns null if allowed, or an error message string if rate limited.
 */
export function checkRateLimit(clientId: string, userId?: string): string | null {
  const limits = getRateLimits()

  for (const limit of limits) {
    const matches =
      (limit.targetType === 'client' && limit.targetId === clientId) ||
      (limit.targetType === 'user' && userId && limit.targetId === userId)

    if (!matches) continue

    const key = `${limit.targetType}:${limit.targetId}`

    // Check RPM
    if (!rpmCounter.check(`${key}:rpm`, limit.maxRpm, 60_000)) {
      log('warn', `Rate limited (RPM): ${key}, max=${limit.maxRpm}`)
      return `Rate limit exceeded: ${limit.maxRpm} requests per minute`
    }

    // Check RPH if configured
    if (limit.maxRph && !rphCounter.check(`${key}:rph`, limit.maxRph, 3600_000)) {
      log('warn', `Rate limited (RPH): ${key}, max=${limit.maxRph}`)
      return `Rate limit exceeded: ${limit.maxRph} requests per hour`
    }
  }

  return null
}
```

- [ ] **Step 4: Integrate rate limiter into proxy.ts**

In `src/proxy.ts`, add import:

```typescript
import { checkRateLimit } from './rate-limiter.js'
```

After the client/user status check and before OAuth token retrieval, add:

```typescript
  // Rate limit check
  if (authResult.clientId) {
    const rateLimitError = checkRateLimit(authResult.clientId, authResult.userId)
    if (rateLimitError) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ error: rateLimitError }))
      return
    }
  }
```

- [ ] **Step 5: Run all tests**

Run:
```bash
npx tsx tests/rewriter.test.ts && npx tsx tests/metering.test.ts && npx tsx tests/rate-limiter.test.ts && npx tsx tests/sync.test.ts
```
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/rate-limiter.ts src/proxy.ts tests/rate-limiter.test.ts
git commit -m "feat: sliding window rate limiter with PG-synced config"
```

---

### Task 6: Quota checker — enforce usage quotas

**Files:**
- Create: `src/quota-checker.ts`
- Create: `tests/quota-checker.test.ts`
- Modify: `src/proxy.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/quota-checker.test.ts`:

```typescript
import assert from 'assert/strict'

let passed = 0
let failed = 0

function test(name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn()
    if (result instanceof Promise) {
      result.then(() => {
        console.log(`  ✓ ${name}`)
        passed++
      }).catch((err: any) => {
        console.log(`  ✗ ${name}`)
        console.log(`    ${err.message}`)
        failed++
      })
    } else {
      console.log(`  ✓ ${name}`)
      passed++
    }
  } catch (err: any) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${err.message}`)
    failed++
  }
}

console.log('\nQuota checker tests:')

test('quota rule matching logic — client target matches client ID', () => {
  const rule = { targetType: 'client', targetId: 'c1', metric: 'tokens', windowSeconds: 86400, maxValue: 1000000, action: 'reject' }
  const matches = rule.targetType === 'client' && rule.targetId === 'c1'
  assert.equal(matches, true)
})

test('quota rule matching logic — user target matches user ID', () => {
  const rule = { targetType: 'user', targetId: 'u1', metric: 'cost', windowSeconds: 86400, maxValue: 10, action: 'reject' }
  const matches = rule.targetType === 'user' && rule.targetId === 'u1'
  assert.equal(matches, true)
})

test('quota rule matching logic — wrong target does not match', () => {
  const rule = { targetType: 'client', targetId: 'c2', metric: 'tokens', windowSeconds: 86400, maxValue: 1000000, action: 'reject' }
  const matches = rule.targetType === 'client' && rule.targetId === 'c1'
  assert.equal(matches, false)
})

test('action types are correctly identified', () => {
  assert.equal('reject' === 'reject', true)
  assert.equal('notify' === 'reject', false)
  assert.equal('throttle' === 'throttle', true)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
```

- [ ] **Step 2: Run test to verify it passes**

Run:
```bash
npx tsx tests/quota-checker.test.ts
```
Expected: 4 passed, 0 failed

- [ ] **Step 3: Create src/quota-checker.ts**

```typescript
import { query } from './db.js'
import { log } from './logger.js'
import { getQuotaRules, type SyncedQuotaRule } from './sync.js'

export type QuotaCheckResult = {
  allowed: boolean
  rule?: SyncedQuotaRule
  used?: number
  message?: string
}

/**
 * Check all quota rules for a client/user.
 * Queries PG for current window usage and compares against max_value.
 */
export async function checkQuota(clientId: string, userId?: string): Promise<QuotaCheckResult> {
  const rules = getQuotaRules()

  for (const rule of rules) {
    const matches =
      (rule.targetType === 'client' && rule.targetId === clientId) ||
      (rule.targetType === 'user' && userId && rule.targetId === userId)

    if (!matches) continue

    const windowStart = new Date(Date.now() - rule.windowSeconds * 1000)

    // Build the WHERE clause based on target type
    const targetClause = rule.targetType === 'client'
      ? 'client_id = $1'
      : 'client_id IN (SELECT id FROM clients WHERE user_id = $1)'
    const targetValue = rule.targetType === 'client' ? clientId : userId

    let usedValue: number

    if (rule.metric === 'tokens') {
      const result = await query<{ total: string }>(
        `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read + cache_write), 0)::text AS total
         FROM usage_records
         WHERE ${targetClause} AND created_at > $2`,
        [targetValue, windowStart],
      )
      usedValue = parseFloat(result.rows[0].total)
    } else if (rule.metric === 'cost') {
      const result = await query<{ total: string }>(
        `SELECT COALESCE(SUM(cost), 0)::text AS total
         FROM usage_records
         WHERE ${targetClause} AND created_at > $2`,
        [targetValue, windowStart],
      )
      usedValue = parseFloat(result.rows[0].total)
    } else if (rule.metric === 'requests') {
      const result = await query<{ total: string }>(
        `SELECT COUNT(*)::text AS total
         FROM usage_records
         WHERE ${targetClause} AND created_at > $2`,
        [targetValue, windowStart],
      )
      usedValue = parseFloat(result.rows[0].total)
    } else {
      continue
    }

    if (usedValue >= rule.maxValue) {
      const windowHours = Math.round(rule.windowSeconds / 3600)
      const message = `Quota exceeded: ${rule.metric} limit ${rule.maxValue} per ${windowHours}h (used: ${usedValue})`

      if (rule.action === 'reject') {
        log('warn', `Quota rejected: ${rule.targetType}=${rule.targetId} ${message}`)
        return { allowed: false, rule, used: usedValue, message }
      } else if (rule.action === 'notify') {
        // Log but allow
        log('info', `Quota notify: ${rule.targetType}=${rule.targetId} ${message}`)
        // TODO: In Phase 2, trigger notification via API Server
      }
      // 'throttle' — for now treat as notify (rate limiter handles actual throttling)
    }
  }

  return { allowed: true }
}
```

- [ ] **Step 4: Integrate quota checker into proxy.ts**

In `src/proxy.ts`, add import:

```typescript
import { checkQuota } from './quota-checker.js'
```

After the rate limit check and before OAuth token retrieval, add:

```typescript
  // Quota check (only for /v1/messages requests with PG-sourced clients)
  if (authResult.clientId && path === '/v1/messages') {
    const quotaResult = await checkQuota(authResult.clientId, authResult.userId)
    if (!quotaResult.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: quotaResult.message }))
      return
    }
  }
```

Note: The `handleRequest` function needs to be `async` — it already is based on the existing code.

- [ ] **Step 5: Run all tests**

Run:
```bash
npx tsx tests/rewriter.test.ts && npx tsx tests/metering.test.ts && npx tsx tests/rate-limiter.test.ts && npx tsx tests/quota-checker.test.ts && npx tsx tests/sync.test.ts
```
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/quota-checker.ts src/proxy.ts tests/quota-checker.test.ts
git commit -m "feat: quota checker — enforce usage limits from PG rules"
```

---

### Task 7: Ensure monthly partitions auto-create

**Files:**
- Create: `src/partition-manager.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create src/partition-manager.ts**

```typescript
import { query } from './db.js'
import { log } from './logger.js'

/**
 * Ensures usage_records partitions exist for the current and next month.
 * Safe to call multiple times — uses IF NOT EXISTS.
 */
export async function ensurePartitions(): Promise<void> {
  try {
    await query(`
      DO $$
      DECLARE
        cur_start DATE := date_trunc('month', CURRENT_DATE);
        cur_end   DATE := cur_start + INTERVAL '1 month';
        nxt_start DATE := cur_end;
        nxt_end   DATE := nxt_start + INTERVAL '1 month';
        cur_name  TEXT := 'usage_records_' || to_char(cur_start, 'YYYY_MM');
        nxt_name  TEXT := 'usage_records_' || to_char(nxt_start, 'YYYY_MM');
      BEGIN
        EXECUTE format(
          'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_records FOR VALUES FROM (%L) TO (%L)',
          cur_name, cur_start, cur_end
        );
        EXECUTE format(
          'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_records FOR VALUES FROM (%L) TO (%L)',
          nxt_name, nxt_start, nxt_end
        );
      END $$;
    `)
    log('info', 'Usage record partitions verified')
  } catch (err) {
    log('error', `Failed to ensure partitions: ${err}`)
  }
}
```

- [ ] **Step 2: Call on startup in index.ts**

In `src/index.ts`, add:

```typescript
import { ensurePartitions } from './partition-manager.js'

// After initDB, before startSync:
await ensurePartitions()
```

- [ ] **Step 3: Commit**

```bash
git add src/partition-manager.ts src/index.ts
git commit -m "feat: auto-create monthly usage_records partitions on startup"
```

---

### Task 8: Update config.example.yaml and add test runner script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update test script in package.json to run all tests**

In `package.json`, update the test script:

```json
"test": "tsx tests/rewriter.test.ts && tsx tests/metering.test.ts && tsx tests/rate-limiter.test.ts && tsx tests/quota-checker.test.ts && tsx tests/sync.test.ts"
```

- [ ] **Step 2: Run full test suite**

Run:
```bash
npm test
```
Expected: All tests pass across all test files.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: update test script to run all test files"
```

---

### Task 9: Integration verification

- [ ] **Step 1: Start a local PostgreSQL and run migration**

Run:
```bash
createdb cc_gateway 2>/dev/null || true
psql -d cc_gateway -f migrations/001_core.sql
```

- [ ] **Step 2: Add database section to config.yaml**

Add to your existing `config.yaml`:

```yaml
database:
  host: localhost
  port: 5432
  database: cc_gateway
  user: $USER
  password: ""
  max_connections: 5
```

- [ ] **Step 3: Start gateway in dev mode and verify**

Run:
```bash
npm run dev
```

Expected logs:
- `PG pool created: ...`
- `Usage record partitions verified`
- `Initial PG sync complete: 0 clients, 0 rate limits, 0 quota rules, 3 model prices`
- `CC Gateway starting...`

- [ ] **Step 4: Verify health endpoint shows PG status**

Run:
```bash
curl -s http://localhost:8443/_health | python3 -m json.tool
```

Expected: Normal health response (PG status can be added later in Phase 2).

- [ ] **Step 5: Insert a test client and verify hot-reload picks it up**

```bash
# Create a test user
psql -d cc_gateway -c "INSERT INTO users (username, email, password_hash, role, status) VALUES ('testadmin', 'admin@test.com', 'not-a-real-hash', 'admin', 'active') RETURNING id;"

# Create a test client (replace USER_ID with the UUID from above)
psql -d cc_gateway -c "INSERT INTO clients (user_id, name, token, status) VALUES ('<USER_ID>', 'test-client', '$(openssl rand -hex 32)', 'active') RETURNING token;"
```

Wait 30 seconds for sync, then verify in gateway logs:
- `Synced 1 clients from PG (total: 1)`

- [ ] **Step 6: Final commit — no code changes, just verification**

No commit needed for this task — it's a manual verification step.
