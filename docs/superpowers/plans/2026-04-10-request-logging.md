# Request Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist all proxy request/response data to a `request_logs` table with trace-id, hit account, truncated bodies (keys intact, values truncated), and integrate with existing `usage_records` via trace_id.

**Architecture:** New `request_logs` partitioned table mirrors the existing `usage_records` partitioning strategy. A new `src/request-logger.ts` module handles trace-id generation and async DB writes. The proxy flow in `src/proxy.ts` is augmented to generate a trace-id at entry, insert a log row before forwarding, and update it with response data after completion. The outbound request (rewritten body/headers sent to Claude) is NOT logged. The `usage_records` table gains a `trace_id` column to link usage to the full request log. Response headers `x-ccg-trace-id` are sent back to clients.

**Tech Stack:** PostgreSQL (partitioned tables), existing `pg` pool via `src/db.ts`, `crypto.randomBytes` for trace-id generation.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `migrations/008_request_logs.sql` | Create | DDL for `request_logs` table + add `trace_id` to `usage_records` |
| `src/request-logger.ts` | Create | `generateTraceId()`, `truncateBody()`, `insertRequestLog()`, `updateRequestLog()` |
| `src/proxy.ts` | Modify | Wire trace-id generation, call request-logger at entry and on response |
| `src/metering.ts` | Modify | Accept and pass `traceId` to `recordUsage()` |
| `tests/request-logger.test.ts` | Create | Unit tests for `generateTraceId`, `truncateBody` |

---

### Task 1: Migration — `request_logs` table and `usage_records.trace_id`

**Files:**
- Create: `migrations/008_request_logs.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- 008_request_logs.sql — Request logging with trace-id

BEGIN;

-- Request logs (partitioned by month, same as usage_records)
CREATE TABLE IF NOT EXISTS request_logs (
  id                  BIGSERIAL,
  trace_id            VARCHAR(32) NOT NULL,
  client_id           UUID,
  client_name         VARCHAR(64) NOT NULL,
  oauth_account_id    UUID,
  oauth_account_name  VARCHAR(64),
  method              VARCHAR(8) NOT NULL,
  path                VARCHAR(255) NOT NULL,
  client_ip           VARCHAR(45),
  request_model       VARCHAR(64),
  request_body        JSONB,
  response_status     SMALLINT,
  response_body       JSONB,
  latency_ms          INT,
  error_message       TEXT,
  retry_count         SMALLINT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS idx_request_logs_trace ON request_logs (trace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_client ON request_logs (client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_account ON request_logs (oauth_account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_time ON request_logs (created_at);

-- Create partitions for current and next month
DO $$
DECLARE
  cur_start DATE := date_trunc('month', CURRENT_DATE);
  cur_end   DATE := cur_start + INTERVAL '1 month';
  nxt_start DATE := cur_end;
  nxt_end   DATE := nxt_start + INTERVAL '1 month';
  cur_name  TEXT := 'request_logs_' || to_char(cur_start, 'YYYY_MM');
  nxt_name  TEXT := 'request_logs_' || to_char(nxt_start, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF request_logs FOR VALUES FROM (%L) TO (%L)',
    cur_name, cur_start, cur_end
  );
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF request_logs FOR VALUES FROM (%L) TO (%L)',
    nxt_name, nxt_start, nxt_end
  );
END $$;

-- Add trace_id to usage_records for cross-referencing
ALTER TABLE usage_records ADD COLUMN IF NOT EXISTS trace_id VARCHAR(32);
CREATE INDEX IF NOT EXISTS idx_usage_trace ON usage_records (trace_id);

COMMIT;
```

- [ ] **Step 2: Commit**

```bash
git add migrations/008_request_logs.sql
git commit -m "feat: add request_logs table and trace_id to usage_records"
```

---

### Task 2: `src/request-logger.ts` — trace-id generation and body truncation

**Files:**
- Create: `src/request-logger.ts`
- Create: `tests/request-logger.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/request-logger.test.ts`:

```typescript
import { strict as assert } from 'assert'

// Inline implementations to avoid DB dependency (same pattern as metering.test.ts)

function generateTraceId(): string {
  // Will be imported from src/request-logger.ts after implementation
  throw new Error('not implemented')
}

function truncateBody(raw: Buffer, maxValueLen?: number): any {
  throw new Error('not implemented')
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
  assert.ok(result.messages[0].content.length <= 220) // 200 + suffix
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

test('returns null for non-JSON body', () => {
  const result = truncateBody(Buffer.from('not json at all'), 200)
  assert.equal(result, null)
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

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx tests/request-logger.test.ts`
Expected: FAIL with "not implemented"

- [ ] **Step 3: Implement the pure functions (inline in the test file first, then move)**

Replace the stub functions in `tests/request-logger.test.ts` with real implementations:

```typescript
import { randomBytes } from 'crypto'

function generateTraceId(): string {
  const ts = Date.now().toString(36)       // ~8 chars
  const rand = randomBytes(6).toString('hex') // 12 chars
  return `ccg-${ts}-${rand}`                  // ~24 chars, always < 32
}

function truncateBody(raw: Buffer, maxValueLen = 200): any {
  if (raw.length === 0) return null
  try {
    const obj = JSON.parse(raw.toString('utf-8'))
    return truncateDeep(obj, maxValueLen)
  } catch {
    return null
  }
}

function truncateDeep(val: any, maxStr: number): any {
  if (val === null || val === undefined) return val
  if (typeof val === 'string') {
    return val.length > maxStr ? val.slice(0, maxStr) + `...(${val.length})` : val
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx tests/request-logger.test.ts`
Expected: All PASS

- [ ] **Step 5: Create `src/request-logger.ts` with the real module**

```typescript
import { randomBytes } from 'crypto'
import { query } from './db.js'
import { log } from './logger.js'

/**
 * Generate a unique trace ID for request tracking.
 * Format: ccg-<base36_timestamp>-<12_hex_random>  (always ≤ 32 chars)
 */
export function generateTraceId(): string {
  const ts = Date.now().toString(36)
  const rand = randomBytes(6).toString('hex')
  return `ccg-${ts}-${rand}`
}

/** Recursively truncate string values — keeps all keys intact */
function truncateDeep(val: any, maxStr: number): any {
  if (val === null || val === undefined) return val
  if (typeof val === 'string') {
    return val.length > maxStr ? val.slice(0, maxStr) + `...(${val.length})` : val
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

/** Parse and truncate a JSON body buffer. Returns null if not valid JSON or empty. */
export function truncateBody(raw: Buffer, maxValueLen = 200): any {
  if (raw.length === 0) return null
  try {
    const obj = JSON.parse(raw.toString('utf-8'))
    return truncateDeep(obj, maxValueLen)
  } catch {
    return null
  }
}

export type RequestLogEntry = {
  traceId: string
  clientId: string | null
  clientName: string
  oauthAccountId: string | null
  oauthAccountName: string | null
  method: string
  path: string
  clientIp: string
  requestModel: string | null
  requestBody: any | null
}

/** Insert a request log row at the start of request processing. Returns the trace_id. */
export async function insertRequestLog(entry: RequestLogEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO request_logs
         (trace_id, client_id, client_name, oauth_account_id, oauth_account_name,
          method, path, client_ip, request_model, request_body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        entry.traceId,
        entry.clientId,
        entry.clientName,
        entry.oauthAccountId,
        entry.oauthAccountName,
        entry.method,
        entry.path,
        entry.clientIp,
        entry.requestModel,
        entry.requestBody ? JSON.stringify(entry.requestBody) : null,
      ],
    )
  } catch (err) {
    log('error', `Failed to insert request log: ${err}`)
  }
}

export type ResponseLogUpdate = {
  traceId: string
  responseStatus: number
  responseBody: any | null
  latencyMs: number
  errorMessage: string | null
  retryCount: number
}

/** Update the request log row with response data after upstream responds. */
export async function updateRequestLog(update: ResponseLogUpdate): Promise<void> {
  try {
    await query(
      `UPDATE request_logs
       SET response_status = $2,
           response_body = $3,
           latency_ms = $4,
           error_message = $5,
           retry_count = $6
       WHERE trace_id = $1
         AND created_at >= now() - INTERVAL '5 minutes'`,
      [
        update.traceId,
        update.responseStatus,
        update.responseBody ? JSON.stringify(update.responseBody) : null,
        update.latencyMs,
        update.errorMessage,
        update.retryCount,
      ],
    )
  } catch (err) {
    log('error', `Failed to update request log: ${err}`)
  }
}
```

- [ ] **Step 6: Update tests to use inline copies of the pure functions (no DB import)**

The test file already has inline copies. No change needed — the test pattern matches `metering.test.ts` where pure logic is duplicated in tests to avoid DB dependency.

- [ ] **Step 7: Run tests again**

Run: `npx tsx tests/request-logger.test.ts`
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add src/request-logger.ts tests/request-logger.test.ts
git commit -m "feat: add request-logger module with trace-id and body truncation"
```

---

### Task 3: Wire trace-id and request logging into `src/proxy.ts`

**Files:**
- Modify: `src/proxy.ts` (lines 1-11 imports, ~333 handleRequest entry, ~455 client log, ~619 accountId, ~659 forwardToUpstream call, ~744 forwardToUpstream signature, ~800 promise body, ~945 response header write, ~954-1012 metering section, ~1014-1030 non-metered section, ~1038-1050 error handler)
- Modify: `src/metering.ts` (line 27-43 recordUsage signature)

- [ ] **Step 1: Add imports to `src/proxy.ts`**

At the top of `src/proxy.ts`, add to the existing imports:

```typescript
import { generateTraceId, truncateBody, insertRequestLog, updateRequestLog } from './request-logger.js'
```

- [ ] **Step 2: Generate trace-id in `handleRequest` and set response header**

In `handleRequest`, right after line 331 (`const clientIp = ...`), add:

```typescript
const traceId = generateTraceId()
res.setHeader('x-ccg-trace-id', traceId)
```

Update the info log on line 333 to include traceId:

```typescript
log('info', `← ${method} ${path} from ${clientIp} [${traceId}]`)
```

- [ ] **Step 3: Insert request log after authentication + account selection, before forwarding**

After the account selection block completes (after `onRequestStart` at line ~653) and before `forwardToUpstream` is called (line ~659), insert:

```typescript
// Log request to database
const requestBodyTruncated = truncateBody(body)
insertRequestLog({
  traceId,
  clientId: authResult.clientId ?? null,
  clientName,
  oauthAccountId: accountId,
  oauthAccountName: selectedAccount?.account.name ?? null,
  method,
  path,
  clientIp,
  requestModel,
  requestBody: requestBodyTruncated,
}).catch(() => {})
```

- [ ] **Step 4: Pass `traceId` to `forwardToUpstream`**

Add `traceId: string` parameter to the `forwardToUpstream` function signature (after `bodyUserId`). Update the call at line ~659:

```typescript
await forwardToUpstream(
  req, res, config, upstream, method, path, body, oauthToken,
  authResult, clientName, accountId, maxRetries, selectedAccount,
  planSubscriptionId, planType, requestModel, 0, bodyUserId, traceId,
)
```

Also update the recursive retry call inside `forwardToUpstream` (line ~926) to pass `traceId`:

```typescript
await forwardToUpstream(
  req, res, config, upstream, method, path, rawBody, newSelection.account.accessToken,
  authResult, clientName, newAccountId, maxRetries, newSelection,
  planSubscriptionId, planType, requestModel, retryCount + 1, bodyUserId, traceId,
)
```

- [ ] **Step 5: Update response logging in the metered path (SSE/JSON)**

In the `proxyRes.on('end')` handler inside the `shouldMeter` block (around line 954), after `res.end()` and after `responseText` is computed, add the updateRequestLog call:

```typescript
// Update request log with response data
const responseBodyTruncated = truncateBody(Buffer.from(responseText))
updateRequestLog({
  traceId,
  responseStatus: status,
  responseBody: responseBodyTruncated,
  latencyMs: latencyMs,
  errorMessage: status >= 400 ? (upstream429Reason ?? extractUpstreamFailureReason(status, responseText)) : null,
  retryCount,
}).catch(() => {})
```

- [ ] **Step 6: Update response logging in the non-metered path**

In the `proxyRes.on('end')` handler in the non-metered else branch (around line 1017), add:

```typescript
updateRequestLog({
  traceId,
  responseStatus: status,
  responseBody: null,
  latencyMs: Date.now() - requestStart,
  errorMessage: status >= 400 ? `upstream_status_${status}` : null,
  retryCount,
}).catch(() => {})
```

- [ ] **Step 7: Update error handler response logging**

In the `proxyReq.on('error')` handler (around line 1038), add:

```typescript
updateRequestLog({
  traceId,
  responseStatus: 502,
  responseBody: null,
  latencyMs: Date.now() - requestStart,
  errorMessage: `upstream_error:${err.message}`,
  retryCount,
}).catch(() => {})
```

- [ ] **Step 8: Also log early-exit error responses that happen before forwarding**

For early exits in `handleRequest` that return error responses after authentication (status 403, 429, 400, 503, 428), add request logging. After the `requestBodyTruncated` and `insertRequestLog` are placed before forwarding, we need to handle cases where the request never reaches `forwardToUpstream`.

Move the `traceId` generation and `res.setHeader` to right after method/path/clientIp extraction (before auth), so trace-id is always present. Then for early exits that happen AFTER auth succeeds (plan guard block at ~436, quota block at ~448, unsupported model at ~489, fast mode at ~499, pool unavailable at ~598, no token at ~612), add request log insert + immediate update:

```typescript
// Example for plan guard block (line ~436):
insertRequestLog({
  traceId,
  clientId: authResult.clientId ?? null,
  clientName,
  oauthAccountId: null,
  oauthAccountName: null,
  method, path, clientIp,
  requestModel: null,
  requestBody: null,
}).catch(() => {})
updateRequestLog({
  traceId,
  responseStatus: 403,
  responseBody: { error: planResult.reason },
  latencyMs: Date.now() - Date.now(), // near-zero
  errorMessage: planResult.reason,
  retryCount: 0,
}).catch(() => {})
```

However, to keep the code clean, create a helper in `handleRequest` scope:

```typescript
const logEarlyExit = (status: number, errorBody: any, errorMsg: string) => {
  insertRequestLog({
    traceId,
    clientId: authResult.clientId ?? null,
    clientName,
    oauthAccountId: null,
    oauthAccountName: null,
    method, path, clientIp,
    requestModel,
    requestBody: null,
  }).catch(() => {})
  updateRequestLog({
    traceId,
    responseStatus: status,
    responseBody: errorBody,
    latencyMs: 0,
    errorMessage: errorMsg,
    retryCount: 0,
  }).catch(() => {})
}
```

Place this helper after auth succeeds and call it at each early-exit point.

- [ ] **Step 9: Commit**

```bash
git add src/proxy.ts
git commit -m "feat: wire trace-id and request logging into proxy flow"
```

---

### Task 4: Add `traceId` to `usage_records` via `recordUsage`

**Files:**
- Modify: `src/metering.ts` (line 27 `recordUsage` signature, line 37-43 query)
- Modify: `src/proxy.ts` (lines ~975, ~979 where `recordUsage` is called)

- [ ] **Step 1: Update `recordUsage` signature in `src/metering.ts`**

Change the function signature to accept `traceId`:

```typescript
export async function recordUsage(
  clientId: string,
  usage: UsageData,
  path: string,
  statusCode: number,
  latencyMs: number,
  oauthAccountId?: string,
  traceId?: string,
): Promise<void> {
```

- [ ] **Step 2: Update the INSERT query to include `trace_id`**

```typescript
await query(
  `INSERT INTO usage_records
     (client_id, model, input_tokens, output_tokens, cache_read, cache_write,
      cost, latency_ms, path, status_code, oauth_account_id, trace_id)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
  [clientId, usage.model, usage.inputTokens, usage.outputTokens,
   usage.cacheRead, usage.cacheWrite, cost, latencyMs, path, statusCode,
   oauthAccountId ?? null, traceId ?? null],
)
```

- [ ] **Step 3: Pass `traceId` in `proxy.ts` `recordUsage` calls**

In the metering section of `forwardToUpstream`, update both `recordUsage` calls:

```typescript
// Line ~975 (direct clientId path):
recordUsage(cid, usage, path, status, latencyMs, accountId ?? undefined, traceId).catch(() => {})

// Line ~979 (resolved clientId path):
recordUsage(resolvedId, usage, path, status, latencyMs, accountId ?? undefined, traceId).catch(() => {})
```

- [ ] **Step 4: Commit**

```bash
git add src/metering.ts src/proxy.ts
git commit -m "feat: pass trace_id to usage_records for cross-referencing"
```

---

### Task 5: Add test to `package.json` and verify

**Files:**
- Modify: `package.json` (line 14, test script)

- [ ] **Step 1: Update `package.json` test script**

Add the new test to the existing test chain:

```json
"test": "tsx tests/rewriter.test.ts && tsx tests/sync.test.ts && tsx tests/metering.test.ts && tsx tests/rate-limiter.test.ts && tsx tests/quota-checker.test.ts && tsx tests/request-logger.test.ts"
```

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: All test suites PASS

- [ ] **Step 3: Build check**

Run: `npm run build`
Expected: No TypeScript errors

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: add request-logger tests to test script"
```

---

### Task 6: Run the migration on the database

- [ ] **Step 1: Apply the migration**

```bash
psql -U cc_gateway -d cc_gateway -f migrations/008_request_logs.sql
```

Expected: `BEGIN`, `CREATE TABLE`, `CREATE INDEX` (×4), `DO`, `ALTER TABLE`, `CREATE INDEX`, `COMMIT`

- [ ] **Step 2: Verify table exists**

```bash
psql -U cc_gateway -d cc_gateway -c "\d request_logs"
```

Expected: Shows the table schema with all columns

- [ ] **Step 3: Verify `usage_records.trace_id` exists**

```bash
psql -U cc_gateway -d cc_gateway -c "\d usage_records"
```

Expected: Shows `trace_id` column of type `varchar(32)`
