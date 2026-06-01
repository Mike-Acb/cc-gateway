# Admin Audit Log UI Implementation Plan — `feat/admin-audit-log-ui`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/admin/audit` 页：系统审计日志。时间线式表格 + 过滤（actor 邮箱 / action / resource_type / 时间窗）+ 详情 Modal（展示 before/after 的 JSON diff）。

**Architecture:**
- 后端 `/api/admin/audit` 已由 `feat/audit-log-backend` (#1-06) 完成。
- 前端 `web/src/pages/admin/AdminAuditLogPage.tsx`（新）。
- Diff 展示：简单的 before/after 并排 `<pre>`，不做 line-level diff（YAGNI）。

**Tech Stack:** React 19 + `@/ui` + Express。

---

## 约束

1. Action 展示用映射表：`plan.update → 改套餐`、`account.disable → 禁用账号` 等；代码里维护 `AUDIT_ACTION_META` 字典（prototype 已有 15 条）。
2. resource_id 过长时 truncate 到前 8 个字符 + `…` + 后 6 个，悬停显示全值。
3. 禁 emoji、禁渐变色、禁 PR。

---

## 文件结构

**Create:**
- `web/src/pages/admin/AdminAuditLogPage.tsx`
- `web/src/pages/admin/_audit/actionMeta.ts`

**Modify:**
- `web/src/router.tsx`

---

## Task 1: actionMeta + 页面

- [ ] **Step 1**:

```bash
cd /path/to/cc-gateway
git checkout main && git pull && git checkout -b feat/admin-audit-log-ui
```

- [ ] **Step 2**: actionMeta

```typescript
// web/src/pages/admin/_audit/actionMeta.ts
type Meta = { label: string; tone: 'accent' | 'info' | 'ok' | 'warn' | 'err' | 'mute' }

export const AUDIT_ACTION_META: Record<string, Meta> = {
  'plan.create':             { label: '创建套餐', tone: 'accent' },
  'plan.update':             { label: '修改套餐', tone: 'info' },
  'plan.delete':             { label: '删除套餐', tone: 'err' },
  'plan.assign_user':        { label: '分配套餐', tone: 'info' },
  'account.create':          { label: '新增账号', tone: 'accent' },
  'account.update':          { label: '修改账号', tone: 'info' },
  'account.enable':          { label: '启用账号', tone: 'ok' },
  'account.disable':         { label: '禁用账号', tone: 'warn' },
  'account.delete':          { label: '删除账号', tone: 'err' },
  'account.reset_token':     { label: '重置 Token', tone: 'warn' },
  'group.create':            { label: '创建账号组', tone: 'accent' },
  'group.update':            { label: '修改账号组', tone: 'info' },
  'group.delete':            { label: '删除账号组', tone: 'err' },
  'group.assign_account':    { label: '账号换组', tone: 'info' },
  'group.assign_client':     { label: '客户端换组', tone: 'info' },
  'user.register':           { label: '用户注册', tone: 'mute' },
  'user.ban':                { label: '封禁用户', tone: 'err' },
  'user.unban':              { label: '解封用户', tone: 'ok' },
  'user.grant_role':         { label: '提升管理员', tone: 'warn' },
  'user.revoke_role':        { label: '撤销管理员', tone: 'warn' },
  'user.delete':             { label: '删除用户', tone: 'err' },
  'subscription.grant':      { label: '授予订阅', tone: 'ok' },
  'subscription.revoke':     { label: '撤销订阅', tone: 'warn' },
  'subscription.adjust_balance': { label: '调整余额', tone: 'info' },
  'client.create':           { label: '新建 Client', tone: 'accent' },
  'client.update':           { label: '修改 Client', tone: 'info' },
  'client.revoke':           { label: '撤销 Client', tone: 'warn' },
  'client.rotate_key':       { label: '轮换 Key', tone: 'warn' },
  'system.reload':           { label: '重载配置', tone: 'mute' },
  'system.campaign_create':  { label: '新建活动', tone: 'accent' },
  'system.campaign_update':  { label: '修改活动', tone: 'info' },
}

export function actionMeta(action: string): Meta {
  return AUDIT_ACTION_META[action] ?? { label: action, tone: 'mute' }
}
```

- [ ] **Step 3**: 页面

```tsx
// web/src/pages/admin/AdminAuditLogPage.tsx
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { FilterBar, Field, Input, Select, Button, Pill, Modal } from '../../ui'
import { actionMeta, AUDIT_ACTION_META } from './_audit/actionMeta'

type Row = {
  id: number; created_at: string; actor_email: string | null
  action: string; resource_type: string; resource_id: string | null
  before: any; after: any; summary: string | null; ip: string | null
}

function shortId(id: string | null) {
  if (!id) return '-'
  return id.length <= 16 ? id : `${id.slice(0, 8)}…${id.slice(-6)}`
}

export default function AdminAuditLogPage() {
  const [items, setItems] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [filter, setFilter] = useState({ actor: '', action: '', resource_type: '' })
  const [detail, setDetail] = useState<Row | null>(null)

  async function load(reset: boolean) {
    const off = reset ? 0 : offset
    const qs = new URLSearchParams({ limit: '50', offset: String(off) })
    if (filter.actor) qs.set('actor', filter.actor)
    if (filter.action) qs.set('action', filter.action)
    if (filter.resource_type) qs.set('resource_type', filter.resource_type)
    const r = await api(`/admin/audit?${qs}`)
    setItems(reset ? r.items : [...items, ...r.items])
    setTotal(r.total)
    setOffset(off + r.items.length)
  }
  useEffect(() => { load(true) }, [JSON.stringify(filter)])

  return (
    <div className="max-w-[1300px] space-y-6">
      <header>
        <h1 className="text-[26px] font-serif">审计日志</h1>
        <p className="text-[13px] text-[var(--mute)] mt-1">管理员操作全量记录</p>
      </header>

      <FilterBar>
        <Field label="操作人"><Input value={filter.actor} onChange={(e) => setFilter({ ...filter, actor: e.target.value })} placeholder="邮箱包含…" /></Field>
        <Field label="动作">
          <Select value={filter.action} onChange={(e) => setFilter({ ...filter, action: e.target.value })}>
            <option value="">全部</option>
            {Object.keys(AUDIT_ACTION_META).map((a) => (
              <option key={a} value={a}>{AUDIT_ACTION_META[a].label}</option>
            ))}
          </Select>
        </Field>
        <Field label="资源">
          <Select value={filter.resource_type} onChange={(e) => setFilter({ ...filter, resource_type: e.target.value })}>
            <option value="">全部</option>
            <option value="plan">plan</option>
            <option value="user">user</option>
            <option value="oauth_account">oauth_account</option>
            <option value="group">group</option>
            <option value="subscription">subscription</option>
            <option value="client">client</option>
            <option value="campaign">campaign</option>
          </Select>
        </Field>
      </FilterBar>

      <table className="w-full text-[12px]">
        <thead className="text-[11px] uppercase tracking-[0.14em] text-[var(--mute)]">
          <tr className="text-left"><th>时间</th><th>操作人</th><th>动作</th><th>资源</th><th>摘要</th><th /></tr>
        </thead>
        <tbody>
          {items.map((r) => {
            const m = actionMeta(r.action)
            return (
              <tr key={r.id} className="border-b border-[var(--line)]">
                <td className="py-1.5 text-[var(--mute)] tabular-nums">{new Date(r.created_at).toLocaleString()}</td>
                <td>{r.actor_email ?? '-'}</td>
                <td><Pill tone={m.tone}>{m.label}</Pill></td>
                <td><span className="text-[var(--mute)]">{r.resource_type}</span> <span title={r.resource_id ?? ''}>{shortId(r.resource_id)}</span></td>
                <td>{r.summary ?? '-'}</td>
                <td><Button variant="ghost" onClick={() => setDetail(r)}>详情</Button></td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {offset < total && (
        <div className="text-center">
          <Button variant="ghost" onClick={() => load(false)}>加载更多 ({total - offset})</Button>
        </div>
      )}

      {detail && (
        <Modal onClose={() => setDetail(null)} title={`${actionMeta(detail.action).label} · ${detail.resource_type}`}>
          <div className="text-[12px] text-[var(--mute)] mb-3">{detail.actor_email} · {new Date(detail.created_at).toLocaleString()} · IP {detail.ip ?? '-'}</div>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] text-[var(--mute)] mb-1">Before</div>
              <pre className="text-[11px] bg-[var(--surface-2)] p-3 max-h-[50vh] overflow-auto">{JSON.stringify(detail.before ?? null, null, 2)}</pre>
            </div>
            <div>
              <div className="text-[11px] text-[var(--mute)] mb-1">After</div>
              <pre className="text-[11px] bg-[var(--surface-2)] p-3 max-h-[50vh] overflow-auto">{JSON.stringify(detail.after ?? null, null, 2)}</pre>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
```

- [ ] **Step 4**: 路由

```tsx
import AdminAuditLogPage from './pages/admin/AdminAuditLogPage'
<Route path="/admin/audit" element={<AdminAuditLogPage />} />
```

- [ ] **Step 5**: 提交

```bash
git add web/src/pages/admin/AdminAuditLogPage.tsx web/src/pages/admin/_audit web/src/router.tsx
git commit -m "feat(admin-audit): audit log page with action meta + before/after diff"
```

---

## Task 2: 部署 + 合并

- [ ] 部署、访问 `/admin/audit`，过滤一条 `plan.update` 看详情
- [ ] merge

```bash
git fetch origin main && git rebase origin/main
git checkout main && git merge --no-ff feat/admin-audit-log-ui -m "merge: feat/admin-audit-log-ui"
git push origin main
```
