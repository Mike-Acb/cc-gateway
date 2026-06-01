# Admin Request Logs V2 Implementation Plan — `feat/admin-request-logs-v2`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全面重做 `/admin/logs`：列表 + 侧边过滤器 + 详情 Modal。区分"网关拦截 vs 上游响应"，支持按 block_reason / streaming / 时间窗 / 用户 / 账号 / 模型 筛选；cursor 分页；详情展示 headers/body（敏感字段脱敏）。

**Architecture:**
- 后端 `/api/admin/request-logs` 已在 p1-04 扩字段；本分支再加：按 user_email / oauth_account_name 筛选。
- 前端大页 `web/src/pages/admin/AdminRequestLogsPage.tsx`（已有，整页重写）。

**Tech Stack:** React 19 + `@/ui` + Express + PostgreSQL。

---

## 约束

1. cursor 分页（与 p2-09 一致），禁止 OFFSET。
2. 左侧过滤面板可折叠；移动端改为顶部 Drawer。
3. Detail modal 内的敏感 header (`authorization`, `cookie`, `x-api-key`) 必须脱敏，request_body 的 `api_key` / `x-api-key` 字段也要。
4. 禁 emoji、禁渐变色、禁 PR。

---

## 文件结构

**Create:**
- `web/src/pages/admin/_logs/FilterPanel.tsx`
- `web/src/pages/admin/_logs/LogRow.tsx`
- `web/src/pages/admin/_logs/DetailModal.tsx`

**Modify:**
- `server/src/routes/admin.ts` 或 `server/src/routes/request-logs.ts` — 扩 filter 参数
- `web/src/pages/admin/AdminRequestLogsPage.tsx`
- `web/src/router.tsx`

---

## Task 1: 后端扩 filter

- [ ] **Step 1**:

```bash
cd /path/to/cc-gateway
git checkout main && git pull && git checkout -b feat/admin-request-logs-v2
```

- [ ] **Step 2**: 在 list handler 增加 where 条件

```typescript
if (req.query.user_email) {
  args.push(`%${String(req.query.user_email)}%`)
  where.push(`EXISTS (SELECT 1 FROM clients c JOIN users u ON u.id=c.user_id
                      WHERE c.id=rl.client_id AND u.email ILIKE $${args.length})`)
}
if (req.query.account) {
  args.push(`%${String(req.query.account)}%`)
  where.push(`rl.oauth_account_name ILIKE $${args.length}`)
}
if (req.query.streaming === 'true')  where.push(`rl.streaming = true`)
if (req.query.streaming === 'false') where.push(`rl.streaming = false`)
if (req.query.block_source === 'gw') where.push(`rl.block_source = 'gw'`)
if (req.query.block_source === 'up') where.push(`rl.block_source = 'up'`)
if (req.query.block_reason) {
  const reasons = String(req.query.block_reason).split(',').map((s) => s.trim()).filter(Boolean)
  if (reasons.length > 0) {
    args.push(reasons)
    where.push(`rl.block_reason = ANY($${args.length}::text[])`)
  }
}
```

- [ ] **Step 3**: 提交

```bash
git add server/src/routes/
git commit -m "feat(admin-logs): filter by user_email/account/streaming/block_*"
```

---

## Task 2: 前端面板 + 列表 + 详情

- [ ] **Step 1**: FilterPanel

```tsx
// web/src/pages/admin/_logs/FilterPanel.tsx
import { Field, Input, Select, Checkbox, Button } from '../../../ui'

const REASONS = ['rate_limited','plan_forbidden_model','quota_exceeded','auth_missing','malformed_block','upstream_5xx','upstream_429']

export default function FilterPanel({ value, onChange, onReset }: { value: any; onChange: (v: any) => void; onReset: () => void }) {
  return (
    <aside className="w-[240px] shrink-0 space-y-3 text-[13px]">
      <h3 className="text-[11px] uppercase tracking-[0.14em] text-[var(--mute)]">过滤</h3>
      <Field label="用户邮箱"><Input value={value.user_email} onChange={(e) => onChange({ ...value, user_email: e.target.value })} /></Field>
      <Field label="OAuth 账号"><Input value={value.account} onChange={(e) => onChange({ ...value, account: e.target.value })} /></Field>
      <Field label="模型">
        <Select value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })}>
          <option value="">全部</option>
          <option value="claude-opus-4-7">Opus 4.7</option>
          <option value="claude-sonnet-4-6">Sonnet 4.6</option>
          <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
        </Select>
      </Field>
      <Field label="来源">
        <Select value={value.block_source} onChange={(e) => onChange({ ...value, block_source: e.target.value })}>
          <option value="">全部</option>
          <option value="gw">网关拦截</option>
          <option value="up">上游响应</option>
        </Select>
      </Field>
      <Field label="拦截原因">
        <div className="space-y-1">
          {REASONS.map((r) => {
            const on = value.block_reason.split(',').filter(Boolean).includes(r)
            return (
              <label key={r} className="flex items-center gap-2 text-[12px]">
                <input type="checkbox" checked={on} onChange={() => {
                  const cur = value.block_reason.split(',').filter(Boolean)
                  const next = on ? cur.filter((x: string) => x !== r) : [...cur, r]
                  onChange({ ...value, block_reason: next.join(',') })
                }} />
                {r}
              </label>
            )
          })}
        </div>
      </Field>
      <Checkbox checked={value.streaming === 'true'} onChange={(e) => onChange({ ...value, streaming: e.target.checked ? 'true' : '' })}>仅流式</Checkbox>
      <Checkbox checked={value.streaming === 'false'} onChange={(e) => onChange({ ...value, streaming: e.target.checked ? 'false' : '' })}>仅非流式</Checkbox>
      <Button variant="ghost" onClick={onReset}>重置</Button>
    </aside>
  )
}
```

- [ ] **Step 2**: LogRow（简单封装状态 Pill）

```tsx
// web/src/pages/admin/_logs/LogRow.tsx
import { Pill, Button } from '../../../ui'

export default function LogRow({ log, onOpen }: { log: any; onOpen: (trace: string) => void }) {
  const blocked = !!log.block_reason
  return (
    <tr className="border-b border-[var(--line)] text-[12px]">
      <td className="py-1.5 text-[var(--mute)] tabular-nums">{new Date(log.created_at).toLocaleString()}</td>
      <td>{log.client_name}</td>
      <td className="text-[var(--mute)]">{log.oauth_account_name ?? '-'}</td>
      <td>{log.request_model ?? '-'}</td>
      <td>
        {blocked
          ? <Pill tone="warn">{log.block_reason}</Pill>
          : <Pill tone={log.response_status < 300 ? 'ok' : 'err'}>{log.response_status}</Pill>}
      </td>
      <td className="text-[var(--mute)]">{log.block_source === 'gw' ? '网关' : log.block_source === 'up' ? '上游' : '-'}</td>
      <td className="tabular-nums">{log.latency_ms ? `${log.latency_ms} ms` : '-'}</td>
      <td className="tabular-nums">{log.first_token_ms ? `${log.first_token_ms} ms` : '-'}</td>
      <td>{log.streaming ? '是' : '否'}</td>
      <td><Button variant="ghost" onClick={() => onOpen(log.trace_id)}>详情</Button></td>
    </tr>
  )
}
```

- [ ] **Step 3**: DetailModal

```tsx
// web/src/pages/admin/_logs/DetailModal.tsx
import { useEffect, useState } from 'react'
import { api } from '../../../api/client'
import { Modal, Pill } from '../../../ui'

const REDACT = new Set(['authorization','cookie','x-api-key','proxy-authorization','x-anthropic-auth'])

function redact(h: any): any {
  if (!h || typeof h !== 'object') return h
  const out: any = Array.isArray(h) ? [] : {}
  for (const [k, v] of Object.entries(h)) {
    out[k] = REDACT.has(k.toLowerCase()) || /api_key/i.test(k) ? '***' : (typeof v === 'object' ? redact(v) : v)
  }
  return out
}

export default function DetailModal({ traceId, onClose }: { traceId: string; onClose: () => void }) {
  const [data, setData] = useState<any>(null)
  useEffect(() => { api(`/admin/request-logs/${traceId}`).then(setData) }, [traceId])
  if (!data) return <Modal onClose={onClose} title={`trace ${traceId}`}>Loading…</Modal>
  return (
    <Modal onClose={onClose} title={`trace ${traceId}`}>
      <div className="flex flex-wrap gap-2 mb-3">
        <Pill tone={data.block_reason ? 'warn' : data.response_status < 300 ? 'ok' : 'err'}>
          {data.block_reason ?? data.response_status}
        </Pill>
        {data.streaming && <Pill tone="info">流式</Pill>}
        {data.first_token_ms && <Pill tone="mute">首 token {data.first_token_ms} ms</Pill>}
      </div>
      <pre className="text-[11px] bg-[var(--surface-2)] p-3 max-h-[60vh] overflow-auto rounded">
{JSON.stringify({
  request_headers_in:   redact(data.request_headers_in),
  request_headers_out:  redact(data.request_headers_out),
  request_body:         redact(data.request_body),
  request_body_out:     redact(data.request_body_out),
  response_headers:     redact(data.response_headers),
  response_body:        data.response_body,
  error_message:        data.error_message,
}, null, 2)}
      </pre>
    </Modal>
  )
}
```

- [ ] **Step 4**: 主页

```tsx
// web/src/pages/admin/AdminRequestLogsPage.tsx
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Button } from '../../ui'
import FilterPanel from './_logs/FilterPanel'
import LogRow from './_logs/LogRow'
import DetailModal from './_logs/DetailModal'

const EMPTY = { user_email: '', account: '', model: '', block_source: '', block_reason: '', streaming: '' }

export default function AdminRequestLogsPage() {
  const [filter, setFilter] = useState(EMPTY)
  const [items, setItems] = useState<any[]>([])
  const [cursor, setCursor] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [opened, setOpened] = useState<string | null>(null)

  async function load(reset: boolean) {
    setLoading(true)
    const qs = new URLSearchParams()
    qs.set('limit', '50')
    for (const [k, v] of Object.entries(filter)) if (v) qs.set(k, String(v))
    if (!reset && cursor) { qs.set('cursor_at', cursor.createdAt); qs.set('cursor_id', cursor.id) }
    const r = await api(`/admin/request-logs?${qs}`)
    setItems(reset ? r.items : [...items, ...r.items])
    setCursor(r.cursor)
    setLoading(false)
  }
  useEffect(() => { load(true) }, [JSON.stringify(filter)])

  return (
    <div className="max-w-[1400px]">
      <header className="mb-6">
        <h1 className="text-[26px] font-serif">请求日志</h1>
        <p className="text-[13px] text-[var(--mute)] mt-1">区分网关拦截与上游响应</p>
      </header>

      <div className="flex gap-6">
        <FilterPanel value={filter} onChange={setFilter} onReset={() => setFilter(EMPTY)} />

        <div className="flex-1 overflow-auto">
          <table className="w-full text-left text-[12px]">
            <thead className="text-[11px] uppercase tracking-[0.14em] text-[var(--mute)]">
              <tr>
                <th>时间</th><th>客户端</th><th>账号</th><th>模型</th>
                <th>状态</th><th>来源</th><th>延迟</th><th>首 token</th><th>流式</th><th />
              </tr>
            </thead>
            <tbody>
              {items.map((log) => <LogRow key={log.id} log={log} onOpen={setOpened} />)}
            </tbody>
          </table>
          {cursor && (
            <div className="text-center mt-4">
              <Button variant="ghost" disabled={loading} onClick={() => load(false)}>
                {loading ? '加载中…' : '加载更多'}
              </Button>
            </div>
          )}
        </div>
      </div>

      {opened && <DetailModal traceId={opened} onClose={() => setOpened(null)} />}
    </div>
  )
}
```

- [ ] **Step 5**: 路由

```tsx
import AdminRequestLogsPage from './pages/admin/AdminRequestLogsPage'
<Route path="/admin/logs" element={<AdminRequestLogsPage />} />
```

- [ ] **Step 6**: 提交

```bash
git add web/src/pages/admin/AdminRequestLogsPage.tsx web/src/pages/admin/_logs web/src/router.tsx
git commit -m "feat(admin-logs): v2 page with filter panel + cursor pagination + redacted detail"
```

---

## Task 3: 部署 + 合并

- [ ] 部署，触发几个拦截 + 成功 + 上游 5xx，验证 UI 区分
- [ ] 打开详情看 headers 脱敏 OK
- [ ] merge

```bash
git fetch origin main && git rebase origin/main
git checkout main && git merge --no-ff feat/admin-request-logs-v2 -m "merge: feat/admin-request-logs-v2"
git push origin main
```
