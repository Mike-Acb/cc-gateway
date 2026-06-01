# Admin Users & Clients Implementation Plan — `feat/admin-users-clients`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/admin/users` 页：用户列表 + 每个用户的 clients 折叠展开。支持 ban/unban、角色切换、为用户新增 client、把 client 改到某个 group。

**Architecture:**
- 后端 `/api/admin/users?expand=clients` 返回用户 + 每用户 clients 子数组。
- 前端 `web/src/pages/admin/AdminUsersPage.tsx`（替换现有 stub/旧实现）。
- 所有写操作必须已被 audit（p1-06 已埋点）—— 本分支验证。

**Tech Stack:** React 19 + `@/ui` + Express。

---

## 约束

1. 普通用户 (role='user') 不能被改为 admin，**除非**当前登录者是 admin 且带二次确认。
2. 禁止一次性返回全部用户 → 分页 limit=50。
3. 用户被 ban 后，他名下所有 client 立刻失效（现有逻辑：API 层校验 user.status）—— 本分支不改，只验证。
4. 禁 emoji、禁渐变色、禁 PR。

---

## 文件结构

**Create:**
- `web/src/pages/admin/_users/UserRow.tsx`

**Modify:**
- `server/src/routes/admin.ts` — /users 扩 expand 参数 + 加 POST/PATCH handlers
- `web/src/pages/admin/AdminPages.tsx`（已有）— 从中拆出 UsersPage 到单独文件
- `web/src/pages/admin/AdminUsersPage.tsx`（新或替换）
- `web/src/router.tsx`

---

## Task 1: 后端 expand 参数

- [ ] **Step 1**:

```bash
cd /path/to/cc-gateway
git checkout main && git pull && git checkout -b feat/admin-users-clients
```

- [ ] **Step 2**: 修改 `/admin/users`

```typescript
router.get('/users', requireAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const offset = Number(req.query.offset) || 0
  const q = String(req.query.q || '').trim()
  const expand = String(req.query.expand || '')

  const args: unknown[] = []
  let where = ''
  if (q) { args.push(`%${q}%`); where = `WHERE (email ILIKE $${args.length} OR username ILIKE $${args.length})` }

  const { rows: users } = await query(
    `SELECT id, email, username, role, status, created_at FROM users ${where}
     ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    args,
  )
  if (expand === 'clients' && users.length > 0) {
    const ids = users.map((u: any) => u.id)
    const { rows: clients } = await query(
      `SELECT c.id, c.name, c.user_id, c.group_id, g.name AS group_name, c.revoked_at
         FROM clients c LEFT JOIN account_groups g ON g.id = c.group_id
        WHERE c.user_id = ANY($1::uuid[])
        ORDER BY c.created_at DESC`,
      [ids],
    )
    const byUser: Record<string, any[]> = {}
    for (const c of clients) (byUser[c.user_id] ??= []).push(c)
    for (const u of users) (u as any).clients = byUser[u.id] ?? []
  }
  res.json({ items: users, limit, offset })
})
```

- [ ] **Step 3**: 加 ban/unban/grant-role 端点

```typescript
router.post('/users/:id/ban',    requireAdmin, async (req, res) => {
  await query(`UPDATE users SET status='banned' WHERE id=$1`, [req.params.id])
  await audit(req, { action: 'user.ban', resource_type: 'user', resource_id: req.params.id })
  res.json({ ok: true })
})
router.post('/users/:id/unban',  requireAdmin, async (req, res) => {
  await query(`UPDATE users SET status='active' WHERE id=$1`, [req.params.id])
  await audit(req, { action: 'user.unban', resource_type: 'user', resource_id: req.params.id })
  res.json({ ok: true })
})
router.post('/users/:id/role',   requireAdmin, async (req, res) => {
  const { role } = req.body ?? {}
  if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'invalid role' })
  await query(`UPDATE users SET role=$1 WHERE id=$2`, [role, req.params.id])
  await audit(req, {
    action: role === 'admin' ? 'user.grant_role' : 'user.revoke_role',
    resource_type: 'user', resource_id: req.params.id, after: { role },
  })
  res.json({ ok: true })
})
```

（`audit` 来自 p1-06。）

- [ ] **Step 4**: 提交

```bash
git add server/src/routes/admin.ts
git commit -m "feat(admin-users): expand=clients + ban/unban/role endpoints"
```

---

## Task 2: 前端页面

- [ ] **Step 1**: UserRow 子组件

```tsx
// web/src/pages/admin/_users/UserRow.tsx
import { useState } from 'react'
import { api } from '../../../api/client'
import { Pill, Button, Select } from '../../../ui'

export default function UserRow({ user, groups, onChange }: { user: any; groups: any[]; onChange: () => void }) {
  const [open, setOpen] = useState(false)
  async function ban()  { if (confirm(`封禁 ${user.email}？`))  { await api(`/admin/users/${user.id}/ban`,  { method: 'POST' }); onChange() } }
  async function unban(){ await api(`/admin/users/${user.id}/unban`, { method: 'POST' }); onChange() }
  async function role(r: string) {
    if (r === 'admin' && !confirm(`将 ${user.email} 提升为管理员？`)) return
    await api(`/admin/users/${user.id}/role`, { method: 'POST', body: JSON.stringify({ role: r }) })
    onChange()
  }
  async function setClientGroup(clientId: string, groupId: string) {
    await api(`/admin/groups/clients/${clientId}`, { method: 'POST', body: JSON.stringify({ groupId }) })
    onChange()
  }

  return (
    <>
      <tr className="border-b border-[var(--line)]">
        <td className="py-2">{user.email}</td>
        <td>{user.username}</td>
        <td><Pill tone={user.role === 'admin' ? 'accent' : 'info'}>{user.role}</Pill></td>
        <td><Pill tone={user.status === 'active' ? 'ok' : 'warn'}>{user.status}</Pill></td>
        <td>{user.clients?.length ?? 0}</td>
        <td className="flex gap-2 py-2">
          <Button variant="ghost" onClick={() => setOpen((o) => !o)}>{open ? '收起' : '展开'}</Button>
          {user.status === 'active' ? <Button variant="ghost" onClick={ban}>封禁</Button> : <Button variant="ghost" onClick={unban}>解封</Button>}
          {user.role === 'user'
            ? <Button variant="ghost" onClick={() => role('admin')}>提升为管理员</Button>
            : <Button variant="ghost" onClick={() => role('user')}>撤销管理员</Button>}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} className="bg-[var(--surface-2)] py-3 px-4">
            {user.clients?.length > 0 ? (
              <ul className="space-y-2 text-[13px]">
                {user.clients.map((c: any) => (
                  <li key={c.id} className="flex items-center gap-3">
                    <span>{c.name}</span>
                    <Pill tone={c.revoked_at ? 'err' : 'ok'}>{c.revoked_at ? '已撤销' : '启用'}</Pill>
                    <Select value={c.group_id} onChange={(e) => setClientGroup(c.id, e.target.value)}>
                      {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </Select>
                  </li>
                ))}
              </ul>
            ) : <div className="text-[12px] text-[var(--mute)]">该用户没有 client。</div>}
          </td>
        </tr>
      )}
    </>
  )
}
```

- [ ] **Step 2**: 主页

```tsx
// web/src/pages/admin/AdminUsersPage.tsx
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { FilterBar, Field, Input } from '../../ui'
import UserRow from './_users/UserRow'

export default function AdminUsersPage() {
  const [items, setItems] = useState<any[]>([])
  const [groups, setGroups] = useState<any[]>([])
  const [q, setQ] = useState('')

  async function load() {
    const qs = new URLSearchParams({ expand: 'clients' })
    if (q) qs.set('q', q)
    const [u, g] = await Promise.all([api(`/admin/users?${qs}`), api('/admin/groups')])
    setItems(u.items ?? u)
    setGroups(g.items ?? g)
  }
  useEffect(() => { load() }, [q])

  return (
    <div className="max-w-[1200px] space-y-6">
      <header>
        <h1 className="text-[26px] font-serif">用户与客户端</h1>
        <p className="text-[13px] text-[var(--mute)] mt-1">管理账号状态与 client 分组</p>
      </header>

      <FilterBar>
        <Field label="搜索"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="邮箱或用户名…" /></Field>
      </FilterBar>

      <table className="w-full text-[13px]">
        <thead className="text-[11px] text-[var(--mute)] uppercase tracking-[0.14em]">
          <tr className="text-left">
            <th className="pb-2">邮箱</th><th>用户名</th><th>角色</th><th>状态</th><th>Clients</th><th />
          </tr>
        </thead>
        <tbody>
          {items.map((u) => <UserRow key={u.id} user={u} groups={groups} onChange={load} />)}
        </tbody>
      </table>

      {items.length === 0 && <div className="text-[13px] text-[var(--mute)]">没有用户。</div>}
    </div>
  )
}
```

- [ ] **Step 3**: 路由

```tsx
import AdminUsersPage from './pages/admin/AdminUsersPage'
<Route path="/admin/users" element={<AdminUsersPage />} />
```

- [ ] **Step 4**: 提交

```bash
git add web/src/pages/admin/AdminUsersPage.tsx web/src/pages/admin/_users web/src/router.tsx
git commit -m "feat(admin-users): users page with expandable clients + role/ban actions"
```

---

## Task 3: 部署 + 合并

- [ ] 部署、ban/unban/改 group 各来一次 → audit 表出现对应记录
- [ ] merge

```bash
git fetch origin main && git rebase origin/main
git checkout main && git merge --no-ff feat/admin-users-clients -m "merge: feat/admin-users-clients"
git push origin main
```
