# User Logs Implementation Plan — `feat/user-logs`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户自己的请求日志列表页（隐藏在 `/clients` 详情或作为独立页均可；这里独立为 `/logs`）：只看本人的 client 产生的日志，带筛选 + Detail Modal。

**Architecture:**
- 后端 `GET /api/me/logs` 按登录用户 `user.id` 过滤，复用 request_logs 新字段。
- `GET /api/me/logs/:id` 返回单条详情（含 sanitized body）。
- 前端 `/logs` 页（路由新增）: `Table` + `FilterBar` + `Modal` 展示。
- 权限：后端必须 JOIN clients 校验 `c.user_id = :user.id` — 不能允许越权查询。

**Tech Stack:** React 19 + `@/ui` + Express + PostgreSQL。

---

## 约束

1. **越权测试必须过** — 传别人的 trace_id 必须返回 404。
2. 敏感 header (`authorization`, `cookie`, `x-api-key`) 在返回给前端前 redact。
3. 分页 `cursor` 模式：基于 `created_at desc + id`，避免 OFFSET 性能问题。
4. 禁 emoji、禁渐变色、禁 PR。

---

## 文件结构

**Create:**
- `server/src/routes/logs-me.ts`
- `web/src/pages/logs/LogsPage.tsx`
- `tests/me-logs.test.ts`

**Modify:**
- `server/src/index.ts` — 挂 `/api/me/logs`
- `web/src/router.tsx` — 添加 `/logs` + 导航
- `web/src/layouts/AppShell.tsx` — USER_NAV 的 `概览` section 下加 `{ label: '请求日志', path: '/logs' }`

---

## Task 1: 切分支 + 后端

- [ ] **Step 1**:

```bash
cd /path/to/cc-gateway
git checkout main && git pull && git checkout -b feat/user-logs
```

- [ ] **Step 2**: 失败测试

```typescript
// tests/me-logs.test.ts
import { strict as assert } from 'assert'
import { query } from '../src/db.js'
import { loadMyLogs, loadMyLogDetail } from '../server/src/routes/logs-me.js'

async function main() {
  // 造两个用户 + 各一个 client + 各一条 log
  const u1 = (await query(`INSERT INTO users(email,role,status) VALUES('a@a','user','active') RETURNING id`)).rows[0].id
  const u2 = (await query(`INSERT INTO users(email,role,status) VALUES('b@b','user','active') RETURNING id`)).rows[0].id
  const c1 = (await query(`INSERT INTO clients(name,api_key_hash,user_id,group_id) SELECT 'c1','h1',$1,id FROM account_groups WHERE is_default=true LIMIT 1 RETURNING id`, [u1])).rows[0].id
  const c2 = (await query(`INSERT INTO clients(name,api_key_hash,user_id,group_id) SELECT 'c2','h2',$1,id FROM account_groups WHERE is_default=true LIMIT 1 RETURNING id`, [u2])).rows[0].id

  const t1 = 'ccg-test-' + Date.now()
  const t2 = 'ccg-test-' + (Date.now() + 1)
  await query(`INSERT INTO request_logs(trace_id,client_id,client_name,method,path,client_ip) VALUES($1,$2,'c1','POST','/v1/messages','1.1.1.1'),($3,$4,'c2','POST','/v1/messages','2.2.2.2')`, [t1, c1, t2, c2])

  const own = await loadMyLogs({ userId: u1, limit: 50 })
  assert.ok(own.items.find((x: any) => x.trace_id === t1))
  assert.ok(!own.items.find((x: any) => x.trace_id === t2), 'u1 should NOT see u2 log')

  const d = await loadMyLogDetail({ userId: u1, traceId: t1 })
  assert.ok(d, 'own detail visible')

  const crossDetail = await loadMyLogDetail({ userId: u1, traceId: t2 })
  assert.equal(crossDetail, null, 'cross-user detail must be null')

  // 清理
  await query(`DELETE FROM request_logs WHERE trace_id IN ($1,$2)`, [t1, t2])
  await query(`DELETE FROM clients WHERE id IN ($1,$2)`, [c1, c2])
  await query(`DELETE FROM users WHERE id IN ($1,$2)`, [u1, u2])

  console.log('OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 3**: 写 loader

```typescript
// server/src/routes/logs-me.ts
import { Router } from 'express'
import { requireUser } from '../middleware/auth'
import { query } from '../db'

const REDACT_HEADERS = new Set(['authorization', 'cookie', 'x-api-key', 'proxy-authorization'])

function redactHeaders(h: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!h) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(h)) {
    out[k] = REDACT_HEADERS.has(k.toLowerCase()) ? '***' : v
  }
  return out
}

export async function loadMyLogs(opts: {
  userId: string
  limit?: number
  cursorCreatedAt?: string
  cursorId?: string
  clientId?: string
  blocked?: boolean
  model?: string
}) {
  const limit = Math.min(opts.limit ?? 50, 200)
  const args: unknown[] = [opts.userId]
  let extra = ''
  if (opts.cursorCreatedAt && opts.cursorId) {
    args.push(opts.cursorCreatedAt, opts.cursorId)
    extra += ` AND (rl.created_at, rl.id) < ($${args.length - 1}::timestamptz, $${args.length}::bigint)`
  }
  if (opts.clientId) { args.push(opts.clientId); extra += ` AND rl.client_id = $${args.length}` }
  if (opts.blocked === true) extra += ` AND rl.block_reason IS NOT NULL`
  if (opts.blocked === false) extra += ` AND rl.block_reason IS NULL`
  if (opts.model) { args.push(opts.model); extra += ` AND rl.request_model = $${args.length}` }

  const { rows } = await query(
    `SELECT rl.id::text, rl.trace_id, rl.created_at,
            c.name AS client_name, rl.request_model, rl.response_status,
            rl.latency_ms, rl.first_token_ms, rl.streaming,
            rl.block_reason, rl.block_source
       FROM request_logs rl
       JOIN clients c ON c.id = rl.client_id
      WHERE c.user_id = $1 ${extra}
      ORDER BY rl.created_at DESC, rl.id DESC
      LIMIT ${limit + 1}`,
    args,
  )
  const hasMore = rows.length > limit
  const items = rows.slice(0, limit)
  const cursor = hasMore
    ? { createdAt: items[items.length - 1].created_at, id: items[items.length - 1].id }
    : null
  return { items, cursor }
}

export async function loadMyLogDetail(opts: { userId: string; traceId: string }) {
  const { rows } = await query(
    `SELECT rl.*, c.name AS client_name
       FROM request_logs rl
       JOIN clients c ON c.id = rl.client_id
      WHERE c.user_id = $1 AND rl.trace_id = $2
      LIMIT 1`,
    [opts.userId, opts.traceId],
  )
  if (rows.length === 0) return null
  const r = rows[0]
  return {
    ...r,
    request_headers_in: redactHeaders(r.request_headers_in),
    request_headers_out: redactHeaders(r.request_headers_out),
    response_headers: redactHeaders(r.response_headers),
  }
}

const router = Router()
router.get('/logs', requireUser, async (req, res) => {
  const userId = (req as any).user.id
  res.json(await loadMyLogs({
    userId,
    limit: Number(req.query.limit) || 50,
    cursorCreatedAt: req.query.cursor_at ? String(req.query.cursor_at) : undefined,
    cursorId: req.query.cursor_id ? String(req.query.cursor_id) : undefined,
    clientId: req.query.client_id ? String(req.query.client_id) : undefined,
    blocked: req.query.blocked === 'true' ? true : req.query.blocked === 'false' ? false : undefined,
    model: req.query.model ? String(req.query.model) : undefined,
  }))
})
router.get('/logs/:traceId', requireUser, async (req, res) => {
  const userId = (req as any).user.id
  const d = await loadMyLogDetail({ userId, traceId: req.params.traceId })
  if (!d) return res.status(404).json({ error: 'not found' })
  res.json(d)
})
export default router
```

挂到 `server/src/index.ts`：

```typescript
import logsMeRouter from './routes/logs-me'
app.use('/api/me', logsMeRouter)
```

- [ ] **Step 4**: 测试通过

```bash
npx tsx tests/me-logs.test.ts
```

- [ ] **Step 5**: 提交

```bash
git add server/src/routes/logs-me.ts server/src/index.ts tests/me-logs.test.ts
git commit -m "feat(user-logs): /api/me/logs with cross-user isolation + redacted detail"
```

---

## Task 2: 前端页面 + 导航

**Files:**
- Create: `web/src/pages/logs/LogsPage.tsx`
- Modify: `web/src/router.tsx`, `web/src/layouts/AppShell.tsx`

- [ ] **Step 1**: 写页面

```tsx
// web/src/pages/logs/LogsPage.tsx
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { FilterBar, Field, Select, Checkbox, Button, Table, Pill, Modal } from '../../ui'

type Log = {
  id: string; trace_id: string; created_at: string; client_name: string
  request_model: string | null; response_status: number | null
  latency_ms: number | null; first_token_ms: number | null
  streaming: boolean | null; block_reason: string | null; block_source: string | null
}

export default function LogsPage() {
  const [items, setItems] = useState<Log[]>([])
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [clientId, setClientId] = useState('')
  const [blockedOnly, setBlockedOnly] = useState(false)
  const [clients, setClients] = useState<{ id: string; name: string }[]>([])
  const [detail, setDetail] = useState<Log & Record<string, unknown> | null>(null)

  useEffect(() => { api('/me/clients').then((r) => setClients(r.items ?? r ?? [])) }, [])

  async function load(reset: boolean) {
    setLoading(true)
    const qs = new URLSearchParams()
    qs.set('limit', '50')
    if (clientId) qs.set('client_id', clientId)
    if (blockedOnly) qs.set('blocked', 'true')
    if (!reset && cursor) { qs.set('cursor_at', cursor.createdAt); qs.set('cursor_id', cursor.id) }
    const r = await api(`/me/logs?${qs}`)
    setItems(reset ? r.items : [...items, ...r.items])
    setCursor(r.cursor)
    setLoading(false)
  }

  useEffect(() => { load(true) }, [clientId, blockedOnly])

  return (
    <div className="max-w-[1200px] space-y-6">
      <header>
        <h1 className="text-[26px] font-serif">请求日志</h1>
        <p className="text-[13px] text-[var(--mute)] mt-1">仅显示你自己客户端的请求</p>
      </header>

      <FilterBar>
        <Field label="客户端">
          <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">全部</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Checkbox checked={blockedOnly} onChange={(e) => setBlockedOnly(e.target.checked)}>仅看被拦截</Checkbox>
      </FilterBar>

      <Table
        columns={[
          { key: 'created_at', label: '时间', render: (r) => new Date(r.created_at).toLocaleString() },
          { key: 'client_name', label: '客户端' },
          { key: 'request_model', label: '模型', render: (r) => r.request_model ?? '-' },
          { key: 'response_status', label: '状态', render: (r) => r.block_reason
              ? <Pill tone="warn">{r.block_reason}</Pill>
              : <Pill tone={r.response_status && r.response_status < 300 ? 'ok' : 'err'}>{r.response_status}</Pill> },
          { key: 'latency_ms', label: '延迟', render: (r) => r.latency_ms ? `${r.latency_ms} ms` : '-' },
          { key: 'first_token_ms', label: '首 token', render: (r) => r.first_token_ms ? `${r.first_token_ms} ms` : '-' },
          { key: 'streaming', label: '流式', render: (r) => r.streaming ? '是' : '否' },
          { key: 'action', label: '', render: (r) => (
            <Button variant="ghost" onClick={() => api(`/me/logs/${r.trace_id}`).then(setDetail)}>详情</Button>
          )},
        ]}
        rows={items}
        empty="没有日志。"
      />

      {cursor && (
        <div className="text-center">
          <Button variant="ghost" disabled={loading} onClick={() => load(false)}>
            {loading ? '加载中…' : '加载更多'}
          </Button>
        </div>
      )}

      {detail && (
        <Modal onClose={() => setDetail(null)} title={`trace ${detail.trace_id}`}>
          <pre className="text-[12px] bg-[var(--surface-2)] p-3 overflow-auto max-h-[60vh]">
            {JSON.stringify(detail, null, 2)}
          </pre>
        </Modal>
      )}
    </div>
  )
}
```

- [ ] **Step 2**: 路由

```tsx
import LogsPage from './pages/logs/LogsPage'
<Route path="/logs" element={<LogsPage />} />
```

- [ ] **Step 3**: 在 `AppShell.tsx` 的 `USER_NAV` 的"概览"区增加一项：

```tsx
{ label: '请求日志', path: '/logs' },
```

- [ ] **Step 4**: 提交

```bash
git add web/src/pages/logs/LogsPage.tsx web/src/router.tsx web/src/layouts/AppShell.tsx
git commit -m "feat(user-logs): logs page with filter + load-more + detail modal"
```

---

## Task 3: 部署 + 合并

- [ ] 部署 → 访问 `/logs` → 验证"只能看到自己的"、切换筛选、点详情
- [ ] 用另一个账号登录，确认看不到别人的 trace_id
- [ ] 合并回 main

```bash
git fetch origin main && git rebase origin/main
git checkout main && git merge --no-ff feat/user-logs -m "merge: feat/user-logs"
git push origin main
```
