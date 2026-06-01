# Admin Groups UI Implementation Plan — `feat/admin-groups-ui`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/admin/groups` 页：列出账号组、创建/重命名/删除、查看组内 accounts/clients 数量、设默认组。

**Architecture:**
- 后端 API 已由 `feat/account-groups-backend` (#1-05) 完成，本分支只做 UI。
- 前端新页 `web/src/pages/admin/AdminGroupsPage.tsx`。
- 组列表每行显示：name + 描述 + "成员账号" + "绑定客户端" 计数 + is_default badge。
- 切换默认组需要 confirm；不提供"切换"接口 —— 让用户知道要先建新组、后删旧默认（见约束 #3）。

**Tech Stack:** React 19 + `@/ui` + Express。

---

## 约束

1. 本分支不改后端。
2. `account_groups.is_default` 由唯一索引保证只有一个，不在 UI 里暴露"切换默认"按钮（会引起多条 UPDATE 冲突）。若确实需要换默认组：先新建组 → 移数据 → 删旧默认（这是一个手工流程，UI 不做）。
3. 删除组会把其下 clients 兜底到 default（后端 p1-05 的 deleteGroup 已实现），UI 显示 confirm + 影响提示。
4. 禁 emoji、禁渐变色、禁 PR。

---

## 文件结构

**Create:**
- `web/src/pages/admin/AdminGroupsPage.tsx`

**Modify:**
- `server/src/routes/groups.ts` — list 端点增加 counts JOIN（若 p1-05 未带）
- `web/src/router.tsx` — `/admin/groups` 接真实页

---

## Task 1: 切分支 + 后端 counts

- [ ] **Step 1**:

```bash
cd /path/to/cc-gateway
git checkout main && git pull && git checkout -b feat/admin-groups-ui
```

- [ ] **Step 2**: 改 list handler

确认 `server/src/routes/groups.ts` 的 `GET /` 当前 SQL。若不带 counts，改成：

```sql
SELECT g.*,
       (SELECT COUNT(*)::int FROM oauth_accounts WHERE group_id = g.id) AS account_count,
       (SELECT COUNT(*)::int FROM clients WHERE group_id = g.id)        AS client_count
  FROM account_groups g
ORDER BY g.is_default DESC, g.name ASC
```

- [ ] **Step 3**: 提交

```bash
git add server/src/routes/groups.ts
git commit -m "feat(groups): include account/client counts on list"
```

---

## Task 2: 前端页面

- [ ] **Step 1**:

```tsx
// web/src/pages/admin/AdminGroupsPage.tsx
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Button, Field, Input, Table, Pill, Modal } from '../../ui'

type Group = {
  id: string; name: string; description: string | null; is_default: boolean
  account_count: number; client_count: number
}

export default function AdminGroupsPage() {
  const [items, setItems] = useState<Group[]>([])
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Group | null>(null)
  const [form, setForm] = useState({ name: '', description: '' })

  async function load() {
    const r = await api('/admin/groups')
    setItems(r.items ?? r)
  }
  useEffect(() => { load() }, [])

  async function onCreate() {
    await api('/admin/groups', { method: 'POST', body: JSON.stringify(form) })
    setCreating(false); setForm({ name: '', description: '' }); await load()
  }
  async function onSave() {
    if (!editing) return
    await api(`/admin/groups/${editing.id}`, { method: 'PATCH', body: JSON.stringify(form) })
    setEditing(null); await load()
  }
  async function onDelete(g: Group) {
    if (g.is_default) { alert('默认组不能删除'); return }
    const msg = `删除 ${g.name} 会把其下 ${g.client_count} 个 client 回退到 default 组，${g.account_count} 个 account 设为共享池。继续？`
    if (!confirm(msg)) return
    await api(`/admin/groups/${g.id}`, { method: 'DELETE' })
    await load()
  }

  return (
    <div className="max-w-[1040px] space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-[26px] font-serif">账号组</h1>
          <p className="text-[13px] text-[var(--mute)] mt-1">调度隔离单位</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>新建组</Button>
      </header>

      <Table
        columns={[
          { key: 'name', label: '名称', render: (r) => (
            <span className="flex items-center gap-2">{r.name}{r.is_default && <Pill tone="info">默认</Pill>}</span>
          ) },
          { key: 'description', label: '描述', render: (r) => r.description || '-' },
          { key: 'account_count', label: '成员账号' },
          { key: 'client_count', label: '绑定客户端' },
          { key: 'action', label: '', render: (r) => (
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => { setEditing(r); setForm({ name: r.name, description: r.description ?? '' }) }}>编辑</Button>
              {!r.is_default && <Button variant="ghost" onClick={() => onDelete(r)}>删除</Button>}
            </div>
          ) },
        ]}
        rows={items}
        empty="没有分组。"
      />

      {(creating || editing) && (
        <Modal onClose={() => { setCreating(false); setEditing(null) }} title={creating ? '新建组' : `编辑 ${editing?.name}`}>
          <Field label="名称"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="描述"><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => { setCreating(false); setEditing(null) }}>取消</Button>
            <Button variant="primary" disabled={!form.name.trim()} onClick={creating ? onCreate : onSave}>保存</Button>
          </div>
        </Modal>
      )}
    </div>
  )
}
```

- [ ] **Step 2**: 路由

```tsx
import AdminGroupsPage from './pages/admin/AdminGroupsPage'
<Route path="/admin/groups" element={<AdminGroupsPage />} />
```

- [ ] **Step 3**: 提交

```bash
git add web/src/pages/admin/AdminGroupsPage.tsx web/src/router.tsx
git commit -m "feat(admin-groups): groups management UI"
```

---

## Task 3: 部署 + 合并

- [ ] 部署、验证新建/编辑/删除 → DB 检查 audit_logs 里出现 `group.create/update/delete`
- [ ] merge

```bash
git fetch origin main && git rebase origin/main
git checkout main && git merge --no-ff feat/admin-groups-ui -m "merge: feat/admin-groups-ui"
git push origin main
```
