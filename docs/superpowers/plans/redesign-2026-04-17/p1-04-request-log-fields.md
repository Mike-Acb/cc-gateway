# Request Log Fields Implementation Plan — `feat/request-log-fields`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `request_logs` 增加 4 列（`first_token_ms`、`streaming`、`block_reason`、`block_source`），在网关侧正确打点，同时扩展 `server/src/routes/request-logs.ts` 暴露给前端。不动任何 UI — UI 由 `feat/admin-request-logs-v2` / `feat/user-logs` 各自消费。

**Architecture:**
- DB migration `014_request_log_fields.sql` 增列 + 索引。
- 网关侧：`src/request-logger.ts` 扩展 `RequestLogEntry` / `ResponseLogUpdate`；`src/plan-guard.ts`、`src/oauth.ts`、`src/proxy-agent.ts` 调用处统一用 block_reason/block_source 标记拦截原因。
- 流式阶段：`src/proxy-agent.ts` 在 SSE 首个 `event: content_block_start` / `event: message_start` 出现时记录 first_token_ms。
- API：`/admin/request-logs` 与 `/request-logs` 返回新字段 + 支持 `block_reason` 筛选。

**Tech Stack:** TypeScript + tsx + PostgreSQL + 已有的 `query()` helper + `assert` 脚本测试。

---

## 约束

1. **Block reason codes 取定**（本分支必须严格遵守）：
   - `rate_limited` — gateway 侧限流（plan 触顶 / 客户端 IP 封禁）
   - `plan_forbidden_model` — 当前 plan 不允许请求该模型
   - `quota_exceeded` — 账户余额/额度不足
   - `auth_missing` — 缺 / 无效 bearer
   - `malformed_block` — 请求体有不完整 thinking/text block（参见 commit 8ee3132）
   - `upstream_5xx` — 上游返 5xx
   - `upstream_429` — 上游返 429
2. **Block source 仅两值**：`gw`（gateway 主动拦截）/ `up`（upstream 响应触发）。
3. 成功请求 `block_reason = NULL` / `block_source = NULL`；UI 可以据此判断"是否被拦截"。
4. **禁止在本分支改任何 UI 文件**（`web/**/*`）。
5. 禁 emoji、禁渐变色、不提 PR。

---

## 文件结构

**Create:**
- `migrations/014_request_log_fields.sql`
- `tests/request-log-fields.test.ts`

**Modify:**
- `src/request-logger.ts` — 扩字段
- `src/plan-guard.ts` — 注入 block_reason
- `src/oauth.ts` — 注入 auth_missing / quota_exceeded
- `src/proxy-agent.ts` — streaming / first_token_ms / upstream_* 标记
- `server/src/routes/request-logs.ts` — SELECT 新字段 + 筛选
- `server/src/routes/admin.ts` 内 `/admin/request-logs`（若在此）— 同上

---

## Task 1: 切分支 + migration

- [ ] **Step 1: 切分支**

```bash
cd /path/to/cc-gateway
git checkout main && git pull
git checkout -b feat/request-log-fields
```

- [ ] **Step 2: 写 migration**

```sql
-- migrations/014_request_log_fields.sql
BEGIN;

ALTER TABLE request_logs
  ADD COLUMN IF NOT EXISTS first_token_ms INT,
  ADD COLUMN IF NOT EXISTS streaming BOOLEAN,
  ADD COLUMN IF NOT EXISTS block_reason VARCHAR(32),
  ADD COLUMN IF NOT EXISTS block_source VARCHAR(4);

CREATE INDEX IF NOT EXISTS idx_request_logs_block_reason
  ON request_logs (block_reason, created_at)
  WHERE block_reason IS NOT NULL;

COMMIT;
```

- [ ] **Step 3: 在本地 DB 跑一遍**

```bash
psql "$DATABASE_URL" -f migrations/014_request_log_fields.sql
```

Expected: 无报错，`\d request_logs` 能看到 4 个新列。

- [ ] **Step 4: 提交**

```bash
git add migrations/014_request_log_fields.sql
git commit -m "feat(logs): add first_token_ms/streaming/block_reason/block_source columns"
```

---

## Task 2: 写失败测试（字段写入与读取）

**Files:**
- Create: `tests/request-log-fields.test.ts`

- [ ] **Step 1: 测试**

```typescript
// tests/request-log-fields.test.ts
import { strict as assert } from 'assert'
import { query } from '../src/db.js'
import { generateTraceId, insertRequestLog, updateRequestLog } from '../src/request-logger.js'

async function main() {
  const traceId = generateTraceId()

  await insertRequestLog({
    traceId,
    clientId: null,
    clientName: 'test-client',
    oauthAccountId: null,
    oauthAccountName: null,
    method: 'POST',
    path: '/v1/messages',
    clientIp: '127.0.0.1',
    requestModel: 'claude-opus-4-7',
    requestBody: null,
    streaming: true,
  } as any)

  await updateRequestLog({
    traceId,
    responseStatus: 200,
    responseBody: null,
    latencyMs: 2000,
    errorMessage: null,
    retryCount: 0,
    firstTokenMs: 350,
  } as any)

  const { rows } = await query(
    `SELECT first_token_ms, streaming, block_reason, block_source
       FROM request_logs WHERE trace_id = $1`,
    [traceId],
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].first_token_ms, 350)
  assert.equal(rows[0].streaming, true)
  assert.equal(rows[0].block_reason, null)
  assert.equal(rows[0].block_source, null)

  // Blocked row
  const blockedTrace = generateTraceId()
  await insertRequestLog({
    traceId: blockedTrace,
    clientId: null,
    clientName: 'test-client',
    oauthAccountId: null,
    oauthAccountName: null,
    method: 'POST',
    path: '/v1/messages',
    clientIp: '127.0.0.1',
    requestModel: 'claude-opus-4-7',
    requestBody: null,
    streaming: false,
    blockReason: 'plan_forbidden_model',
    blockSource: 'gw',
  } as any)

  const blocked = await query(
    `SELECT block_reason, block_source FROM request_logs WHERE trace_id = $1`,
    [blockedTrace],
  )
  assert.equal(blocked.rows[0].block_reason, 'plan_forbidden_model')
  assert.equal(blocked.rows[0].block_source, 'gw')

  console.log('OK')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: 跑，确认失败**

```bash
npx tsx tests/request-log-fields.test.ts
```

Expected: 失败 — `insertRequestLog` 还不接受 `streaming` / `blockReason` / `blockSource`。

---

## Task 3: 扩展 request-logger

**Files:**
- Modify: `src/request-logger.ts`

- [ ] **Step 1: 扩展 `RequestLogEntry` 类型**

在 `src/request-logger.ts` 的 `RequestLogEntry` 类型增加：

```typescript
export type BlockReason =
  | 'rate_limited'
  | 'plan_forbidden_model'
  | 'quota_exceeded'
  | 'auth_missing'
  | 'malformed_block'
  | 'upstream_5xx'
  | 'upstream_429'

export type BlockSource = 'gw' | 'up'

export type RequestLogEntry = {
  // ...existing fields...
  streaming?: boolean | null
  blockReason?: BlockReason | null
  blockSource?: BlockSource | null
}
```

- [ ] **Step 2: `insertRequestLog` 写入新列**

改 `INSERT` 为：

```typescript
await query(
  `INSERT INTO request_logs
     (trace_id, client_id, client_name, oauth_account_id, oauth_account_name,
      method, path, client_ip, request_model, request_body,
      request_headers_in, request_headers_out, request_body_out,
      streaming, block_reason, block_source)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
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
    entry.requestBody,
    entry.requestHeadersIn ?? null,
    entry.requestHeadersOut ?? null,
    entry.requestBodyOut ?? null,
    entry.streaming ?? null,
    entry.blockReason ?? null,
    entry.blockSource ?? null,
  ],
)
```

- [ ] **Step 3: 扩展 `ResponseLogUpdate`**

```typescript
export type ResponseLogUpdate = {
  // ...existing fields...
  firstTokenMs?: number | null
  blockReason?: BlockReason | null
  blockSource?: BlockSource | null
}
```

- [ ] **Step 4: `updateRequestLog` 写入新列（COALESCE 模式保持不动已有值）**

```typescript
SET response_status = $2,
    response_body = $3,
    latency_ms = $4,
    error_message = $5,
    retry_count = $6,
    oauth_account_id = COALESCE($7, oauth_account_id),
    oauth_account_name = COALESCE($8, oauth_account_name),
    response_headers = COALESCE($9, response_headers),
    request_headers_out = COALESCE($10, request_headers_out),
    request_body_out = COALESCE($11, request_body_out),
    first_token_ms = COALESCE($12, first_token_ms),
    block_reason = COALESCE($13, block_reason),
    block_source = COALESCE($14, block_source)
```

记得把 `update.firstTokenMs ?? null`、`update.blockReason ?? null`、`update.blockSource ?? null` 加到参数数组末尾。

- [ ] **Step 5: 跑测试通过**

```bash
npx tsx tests/request-log-fields.test.ts
```

Expected: `OK`

- [ ] **Step 6: 提交**

```bash
git add src/request-logger.ts tests/request-log-fields.test.ts
git commit -m "feat(logs): extend request-logger with streaming/first_token/block fields"
```

---

## Task 4: plan-guard 注入 block_reason

**Files:**
- Modify: `src/plan-guard.ts`

- [ ] **Step 1: 定位拦截点**

Run: `Grep` pattern `return.*403|throw.*PlanForbidden|denyResponse|PLAN_FORBIDDEN` in `src/plan-guard.ts`
Expected: 看到当前拦截处的返回结构。

- [ ] **Step 2: 让 plan-guard 每次拒绝时返回结构化原因**

把被拦截分支的 return 统一改成：

```typescript
return {
  allowed: false,
  reason: 'plan_forbidden_model' as const, // 或 'rate_limited' / 'quota_exceeded'
  status: 403,
  body: { error: { type: 'plan_forbidden', message: '...' } },
}
```

然后在调用处（通常是 `src/proxy-agent.ts` 或 `src/index.ts` 的请求入口）把返回的 `reason` 传给 `updateRequestLog`：

```typescript
await updateRequestLog({
  traceId,
  responseStatus: result.status,
  responseBody: result.body,
  latencyMs: Date.now() - startedAt,
  errorMessage: null,
  retryCount: 0,
  blockReason: result.reason,
  blockSource: 'gw',
})
```

- [ ] **Step 3: 人工手测**

```bash
# 用一个超出 plan 的模型名触发 plan-guard
curl -s -X POST https://gwbk.example.com/v1/messages \
  -H "authorization: Bearer $TEST_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-5-0","messages":[{"role":"user","content":"hi"}],"max_tokens":10}' \
  | head -c 300
```

```bash
psql "$DATABASE_URL" -c "SELECT block_reason, block_source FROM request_logs ORDER BY created_at DESC LIMIT 1"
```

Expected: `block_reason = 'plan_forbidden_model'`, `block_source = 'gw'`.

- [ ] **Step 4: 提交**

```bash
git add src/plan-guard.ts src/index.ts src/proxy-agent.ts
git commit -m "feat(logs): plan-guard emits structured block_reason"
```

---

## Task 5: oauth 注入 auth_missing / quota_exceeded

**Files:**
- Modify: `src/oauth.ts`

- [ ] **Step 1: 定位缺 auth 与 quota 不足的返回点**

Run: `Grep` pattern `401|403|missing.*auth|insufficient.*balance|quota` in `src/oauth.ts`

- [ ] **Step 2: 让两个分支返回 `reason`**

- 缺 bearer / token 失败 → `blockReason: 'auth_missing'`
- quota/余额不足 → `blockReason: 'quota_exceeded'`
- IP/客户端限流（若在此文件中）→ `blockReason: 'rate_limited'`
- `blockSource: 'gw'`

- [ ] **Step 3: 提交**

```bash
git add src/oauth.ts
git commit -m "feat(logs): oauth emits auth_missing/quota_exceeded/rate_limited reasons"
```

---

## Task 6: proxy-agent 处理流式标记与 upstream block

**Files:**
- Modify: `src/proxy-agent.ts`

- [ ] **Step 1: 入口判流式**

在把请求转发给上游之前，判断：

```typescript
const streaming = req.body?.stream === true
await insertRequestLog({ /* ...existing fields..., */ streaming })
```

- [ ] **Step 2: 记录 first_token_ms**

在 SSE 流里监听第一个 `event: message_start`（或第一个可见 token 字节）：

```typescript
let firstTokenMs: number | null = null
const startedAt = Date.now()
upstreamRes.on('data', (chunk) => {
  if (firstTokenMs === null) {
    const text = chunk.toString('utf-8')
    if (text.includes('event: message_start') || text.includes('event: content_block_delta')) {
      firstTokenMs = Date.now() - startedAt
    }
  }
  // forward to client...
})
```

在请求结束时把 `firstTokenMs` 传给 `updateRequestLog`。

- [ ] **Step 3: 处理 upstream 4xx/5xx**

当 upstream 返回 5xx：`blockReason: 'upstream_5xx'`, `blockSource: 'up'`
当 upstream 返回 429：`blockReason: 'upstream_429'`, `blockSource: 'up'`
当 upstream 返回 2xx：两字段均不设置（COALESCE 会保持 NULL）

- [ ] **Step 4: malformed_block（已有拦截点）**

定位 commit 8ee3132 的那段校验逻辑，让它拒绝时也调用：

```typescript
await updateRequestLog({
  traceId,
  responseStatus: 400,
  responseBody: errorBody,
  latencyMs: Date.now() - startedAt,
  errorMessage: 'malformed thinking/text block',
  retryCount: 0,
  blockReason: 'malformed_block',
  blockSource: 'gw',
})
```

- [ ] **Step 5: 手测流式**

```bash
curl -sN -X POST https://gwbk.example.com/v1/messages \
  -H "authorization: Bearer $TEST_KEY" \
  -d '{"model":"claude-haiku-4-5-20251001","stream":true,"max_tokens":64,"messages":[{"role":"user","content":"count 1 to 3"}]}'
```

```bash
psql "$DATABASE_URL" -c "SELECT streaming, first_token_ms, response_status, block_reason FROM request_logs ORDER BY created_at DESC LIMIT 1"
```

Expected: `streaming=t`, `first_token_ms` 合理（200-3000ms），`block_reason=NULL`。

- [ ] **Step 6: 提交**

```bash
git add src/proxy-agent.ts
git commit -m "feat(logs): track streaming/first_token_ms and upstream block reasons"
```

---

## Task 7: API 暴露新字段

**Files:**
- Modify: `server/src/routes/request-logs.ts`
- Modify: `server/src/routes/admin.ts`（如 admin 版本日志路由在 admin.ts 中）

- [ ] **Step 1: SELECT 加新字段**

找到 `SELECT` 请求日志的所有 SQL，把 4 个新列加进来：

```sql
SELECT
  id, trace_id, client_name, oauth_account_name, method, path, client_ip,
  request_model, response_status, latency_ms, error_message, retry_count,
  created_at,
  first_token_ms, streaming, block_reason, block_source
FROM request_logs
WHERE ...
```

- [ ] **Step 2: 支持筛选**

查询参数：
- `?block_reason=plan_forbidden_model,rate_limited`（逗号分隔多选）
- `?blocked=true` 等价于 `block_reason IS NOT NULL`
- `?streaming=true|false`

把筛选条件加到 WHERE 子句（用参数化 query，禁止字符串拼接）。

- [ ] **Step 3: 手测**

```bash
curl -s "https://gwbk.example.com/api/admin/request-logs?blocked=true&limit=5" \
  -H "cookie: access_token=$ADMIN_COOKIE" | jq '.items[0] | {block_reason, block_source, streaming, first_token_ms}'
```

Expected: 返回带这四个字段。

- [ ] **Step 4: 提交**

```bash
git add server/src/routes/request-logs.ts server/src/routes/admin.ts
git commit -m "feat(logs): expose new fields + blocked filter in request-logs API"
```

---

## Task 8: 部署到 gwbk 验证

- [ ] **Step 1: 部署**

```bash
./scripts/deploy-gwbk.sh
```

- [ ] **Step 2: 生产数据验证**

```bash
psql "$DATABASE_URL" -c "
SELECT block_reason, COUNT(*)
FROM request_logs
WHERE created_at > now() - INTERVAL '10 minutes'
GROUP BY block_reason
ORDER BY 2 DESC"
```

Expected: 有若干成功 (NULL) + 若干被拦截，分布合理。

- [ ] **Step 3: 对 `first_token_ms` 做分布检查**

```bash
psql "$DATABASE_URL" -c "
SELECT
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY first_token_ms) AS p50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY first_token_ms) AS p95
FROM request_logs
WHERE streaming = true AND created_at > now() - INTERVAL '30 minutes'"
```

Expected: p50 200-800ms，p95 < 5000ms。

---

## Task 9: 合并回 main

- [ ] **Step 1: rebase + merge**

```bash
git fetch origin main && git rebase origin/main
git checkout main && git merge --no-ff feat/request-log-fields -m "merge: feat/request-log-fields"
git push origin main
```

- [ ] **Step 2: 通知：`feat/user-logs` / `feat/admin-request-logs-v2` 可以从 main 起。**
