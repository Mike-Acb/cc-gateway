# User Clients Implementation Plan — `feat/user-clients`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/clients` 页：列出当前用户的 clients、显示 group、创建/重命名/撤销/轮换 key、一次性展示新 key 值。

**Architecture:**
- 前端 `web/src/pages/clients/ClientsPage.tsx`（已有；需要重写以适配 ui kit + 新字段 group_id）。
- 后端已有 `server/src/routes/clients.ts`；本分支只加小变更：返回 group_id + 在 client detail 里带 group name。
- 不实现用户"改 group"功能 —— group 是 admin 操作（见 `feat/admin-groups-ui`）。用户只读 group 名。

**Tech Stack:** React 19 + `@/ui` + Express。

---

## 约束

1. **API key 只有刚生成时展示一次** — 前端需有明显提示"请立即保存，不会再显示"。
2. 哈希存储，不能读出明文。
3. 撤销 = 软删除 `revoked_at`，不物理 DELETE（与现有 schema 一致）。
4. 禁 emoji、禁渐变色、禁 PR。

---

## 文件结构

**Modify:**
- `web/src/pages/clients/ClientsPage.tsx`（现存；整页重写）
- `server/src/routes/clients.ts`（小改：返回 group name）
- `web/src/router.tsx` — 已有，无需改

---

## Task 1: 切分支 + 后端补 group 字段

- [ ] **Step 1**:

```bash
cd /path/to/cc-gateway
git checkout main && git pull && git checkout -b feat/user-clients
```

- [ ] **Step 2**: 改 `/api/me/clients` 列表 SQL，JOIN account_groups 拿 name

找到 `server/src/routes/clients.ts` 中的 list endpoint，改 SQL：

```sql
SELECT c.id, c.name, c.created_at, c.revoked_at,
       c.group_id, g.name AS group_name
FROM clients c
JOIN account_groups g ON g.id = c.group_id
WHERE c.user_id = $1
ORDER BY c.created_at DESC
```

- [ ] **Step 3**: 提交

```bash
git add server/src/routes/clients.ts
git commit -m "feat(clients): surface group_name on /api/me/clients list"
```

---

## Task 2: 页面重写

**Files:** Modify `web/src/pages/clients/ClientsPage.tsx`

- [ ] **Step 1**: 先 Read 现有文件，了解 api 客户端用法与 api('/me/clients') 形状

Run: `Read` the existing `web/src/pages/clients/ClientsPage.tsx`

- [ ] **Step 2**: 重写页面

```tsx
// web/src/pages/clients/ClientsPage.tsx
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Button, Field, Input, Table, Pill, Modal } from '../../ui'

type Client = {
  id: string
  name: string
  created_at: string
  revoked_at: string | null
  group_id: string
  group_name: string
}

export default function ClientsPage() {
  const [items, setItems] = useState<Client[]>([])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [freshKey, setFreshKey] = useState<{ name: string; key: string } | null>(null)

  async function load() {
    const r = await api('/me/clients')
    setItems(r.items ?? r ?? [])
  }
  useEffect(() => { load() }, [])

  async function onCreate() {
    const r = await api('/me/clients', { method: 'POST', body: JSON.stringify({ name }) })
    setFreshKey({ name: r.name ?? name, key: r.apiKey ?? r.api_key })
    setName('')
    setCreating(false)
    await load()
  }
  async function onRotate(id: string) {
    if (!confirm('轮换 key 会使旧 key 立即失效。继续？')) return
    const r = await api(`/me/clients/${id}/rotate`, { method: 'POST' })
    setFreshKey({ name: r.name, key: r.apiKey ?? r.api_key })
    await load()
  }
  async function onRevoke(id: string) {
    if (!confirm('撤销后该 client 无法再发送请求。继续？')) return
    await api(`/me/clients/${id}`, { method: 'DELETE' })
    await load()
  }

  return (
    <div className="max-w-[1040px] space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-[26px] font-serif">客户端</h1>
          <p className="text-[13px] text-[var(--mute)] mt-1">管理 API 凭证</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>新建 client</Button>
      </header>

      <Table
        columns={[
          { key: 'name', label: '名称' },
          { key: 'group_name', label: '调度组', render: (r) => <Pill tone="info">{r.group_name}</Pill> },
          { key: 'created_at', label: '创建时间', render: (r) => new Date(r.created_at).toLocaleDateString() },
          { key: 'status', label: '状态', render: (r) => r.revoked_at
              ? <Pill tone="err">已撤销</Pill>
              : <Pill tone="ok">启用</Pill> },
          { key: 'action', label: '', render: (r) => !r.revoked_at && (
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => onRotate(r.id)}>轮换 key</Button>
              <Button variant="ghost" onClick={() => onRevoke(r.id)}>撤销</Button>
            </div>
          )},
        ]}
        rows={items}
        empty="还没有 client。"
      />

      {creating && (
        <Modal onClose={() => setCreating(false)} title="新建 client">
          <Field label="名称"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：本地开发" /></Field>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>取消</Button>
            <Button variant="primary" disabled={!name.trim()} onClick={onCreate}>创建</Button>
          </div>
        </Modal>
      )}

      {freshKey && (
        <Modal onClose={() => setFreshKey(null)} title="请立即保存">
          <p className="text-[13px] text-[var(--warn)] mb-3">
            这是 <b>{freshKey.name}</b> 的 API key。关闭后将无法再次查看。
          </p>
          <pre className="text-[12px] bg-[var(--surface-2)] p-3 rounded-[6px] select-all break-all">{freshKey.key}</pre>
          <div className="mt-4 flex justify-end">
            <Button variant="primary" onClick={() => setFreshKey(null)}>我已保存</Button>
          </div>
        </Modal>
      )}
    </div>
  )
}
```

- [ ] **Step 3**: 提交

```bash
git add web/src/pages/clients/ClientsPage.tsx
git commit -m "feat(user-clients): rewrite clients page using ui kit + group badge"
```

---

## Task 3: 路由 + 部署 + 合并

- [ ] **Step 1**: 在 `router.tsx` 确认 `/clients` 已挂真实页（之前是 PageStub），改为：

```tsx
import ClientsPage from './pages/clients/ClientsPage'
<Route path="/clients" element={<ClientsPage />} />
```

- [ ] **Step 2**: `./scripts/deploy-gwbk.sh`
- [ ] **Step 3**: 人工验证：
  - 列表显示调度组 Pill
  - 创建 client → 弹出一次性 key
  - 轮换 key → 弹出新 key，旧 key 立即失效（curl 测试）
  - 撤销 → 状态变 Pill.err
- [ ] **Step 4**: 合并

```bash
git fetch origin main && git rebase origin/main
git checkout main && git merge --no-ff feat/user-clients -m "merge: feat/user-clients"
git push origin main
```
