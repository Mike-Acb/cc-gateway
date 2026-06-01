# Admin System Implementation Plan — `feat/admin-system`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/admin/system` 页：系统信息卡片（版本、commit、部署时间）+ 出站代理（outbound-proxies）管理（列表/增删改）+ Webhooks（已有）+ "重载配置"按钮（触发 gateway 的 reload）。

**Architecture:**
- 后端已有 `server/src/routes/outbound-proxies.ts` 与 `server/src/routes/webhooks.ts`；本分支只合页，小改：加 `GET /admin/system/info` 返回 `{ version, commit, deployedAt, deployment }`。
- 前端新 `AdminSystemPage.tsx`，三段式：System Info / Outbound Proxies / Webhooks。

**Tech Stack:** React 19 + `@/ui` + Express。

---

## 约束

1. "重载配置"按钮触发后必须有 loading + 成功/失败反馈；实际实现可为空 no-op endpoint `/admin/system/reload` 留给将来；本期只要 audit 一条 `system.reload`。
2. outbound_proxies 的 password 字段返回前要脱敏（`***`）。
3. 禁 emoji、禁渐变色、禁 PR。

---

## 文件结构

**Create:**
- `web/src/pages/admin/AdminSystemPage.tsx`（替换现有）
- `web/src/pages/admin/_system/ProxyTable.tsx`
- `web/src/pages/admin/_system/WebhooksTable.tsx`

**Modify:**
- `server/src/routes/admin.ts` — 新 GET /system/info、POST /system/reload
- `web/src/router.tsx`

---

## Task 1: 后端 info/reload

- [ ] **Step 1**:

```bash
cd /path/to/cc-gateway
git checkout main && git pull && git checkout -b feat/admin-system
```

- [ ] **Step 2**:

```typescript
router.get('/system/info', requireAdmin, async (_req, res) => {
  res.json({
    version: process.env.APP_VERSION ?? 'dev',
    commit:  process.env.GIT_COMMIT ?? 'unknown',
    deployedAt: process.env.DEPLOYED_AT ?? null,
    deployment: process.env.DEPLOYMENT ?? 'gw',
    nodeVersion: process.version,
    uptimeSec: Math.round(process.uptime()),
  })
})

router.post('/system/reload', requireAdmin, async (req, res) => {
  await audit(req, { action: 'system.reload', resource_type: 'system' })
  res.json({ ok: true, note: 'config reloaded (no-op)' })
})
```

`APP_VERSION` / `GIT_COMMIT` / `DEPLOYED_AT` 由 `scripts/deploy-gwbk.sh` 写入 `.env.gwbk` 或直接 export（deploy 脚本会在发布时填入 git rev-parse HEAD）。若该脚本尚未支持，顺手补一下：

```bash
# scripts/deploy-gwbk.sh 末尾附近，启动 pm2 前插入
export APP_VERSION="$(git describe --always --dirty)"
export GIT_COMMIT="$(git rev-parse HEAD)"
export DEPLOYED_AT="$(date -Iseconds)"
```

- [ ] **Step 3**: 提交

```bash
git add server/src/routes/admin.ts scripts/deploy-gwbk.sh
git commit -m "feat(admin-system): /system/info + reload endpoint"
```

---

## Task 2: 前端合页

- [ ] **Step 1**: ProxyTable

```tsx
// web/src/pages/admin/_system/ProxyTable.tsx
import { useEffect, useState } from 'react'
import { api } from '../../../api/client'
import { Button, Field, Input, Select, Table, Pill, Modal } from '../../../ui'

export default function ProxyTable() {
  const [items, setItems] = useState<any[]>([])
  const [editing, setEditing] = useState<any | null>(null)
  const [form, setForm] = useState<any>({ name: '', kind: 'http', host: '', port: 1080, username: '', password: '' })

  async function load() { setItems((await api('/admin/outbound-proxies')).items ?? []) }
  useEffect(() => { load() }, [])

  async function save() {
    if (editing?.id) await api(`/admin/outbound-proxies/${editing.id}`, { method: 'PATCH', body: JSON.stringify(form) })
    else             await api('/admin/outbound-proxies', { method: 'POST', body: JSON.stringify(form) })
    setEditing(null); await load()
  }
  async function remove(id: string) {
    if (!confirm('删除代理？')) return
    await api(`/admin/outbound-proxies/${id}`, { method: 'DELETE' })
    await load()
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end"><Button variant="primary" onClick={() => { setEditing({}); setForm({ name: '', kind: 'http', host: '', port: 1080, username: '', password: '' }) }}>新建代理</Button></div>
      <Table
        columns={[
          { key: 'name', label: '名称' },
          { key: 'kind', label: '类型', render: (r) => <Pill tone="info">{r.kind}</Pill> },
          { key: 'endpoint', label: '目标', render: (r) => `${r.host}:${r.port}` },
          { key: 'status', label: '状态', render: (r) => <Pill tone={r.enabled ? 'ok' : 'mute'}>{r.enabled ? '启用' : '禁用'}</Pill> },
          { key: 'action', label: '', render: (r) => (
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => { setEditing(r); setForm({ ...r, password: '' }) }}>编辑</Button>
              <Button variant="ghost" onClick={() => remove(r.id)}>删除</Button>
            </div>
          ) },
        ]}
        rows={items}
        empty="暂无出站代理。"
      />

      {editing !== null && (
        <Modal onClose={() => setEditing(null)} title={editing?.id ? `编辑 ${editing.name}` : '新建代理'}>
          <div className="space-y-3">
            <Field label="名称"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="类型">
              <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option value="http">HTTP</option>
                <option value="socks5">SOCKS5</option>
              </Select>
            </Field>
            <Field label="Host"><Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} /></Field>
            <Field label="Port"><Input type="number" value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} /></Field>
            <Field label="用户名"><Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></Field>
            <Field label="密码（留空保留）"><Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(null)}>取消</Button>
            <Button variant="primary" onClick={save}>保存</Button>
          </div>
        </Modal>
      )}
    </div>
  )
}
```

- [ ] **Step 2**: WebhooksTable（简化：直接读现有 `/admin/webhooks` 端点）

```tsx
// web/src/pages/admin/_system/WebhooksTable.tsx
import { useEffect, useState } from 'react'
import { api } from '../../../api/client'
import { Table, Pill } from '../../../ui'

export default function WebhooksTable() {
  const [items, setItems] = useState<any[]>([])
  useEffect(() => { api('/admin/webhooks').then((r) => setItems(r.items ?? r)) }, [])
  return (
    <Table
      columns={[
        { key: 'name', label: '名称' },
        { key: 'url', label: 'URL', render: (r) => <span className="font-mono text-[11px]">{r.url}</span> },
        { key: 'enabled', label: '状态', render: (r) => <Pill tone={r.enabled ? 'ok' : 'mute'}>{r.enabled ? '启用' : '禁用'}</Pill> },
        { key: 'last_status', label: '最近状态' },
      ]}
      rows={items}
      empty="暂无 webhook。"
    />
  )
}
```

- [ ] **Step 3**: 主页

```tsx
// web/src/pages/admin/AdminSystemPage.tsx
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Button, Pill } from '../../ui'
import ProxyTable from './_system/ProxyTable'
import WebhooksTable from './_system/WebhooksTable'

export default function AdminSystemPage() {
  const [info, setInfo] = useState<any>(null)
  const [reloading, setReloading] = useState(false)
  useEffect(() => { api('/admin/system/info').then(setInfo) }, [])

  async function reload() {
    setReloading(true)
    try { await api('/admin/system/reload', { method: 'POST' }); alert('已重载') }
    finally { setReloading(false) }
  }

  return (
    <div className="max-w-[1200px] space-y-8">
      <header>
        <h1 className="text-[26px] font-serif">系统</h1>
        <p className="text-[13px] text-[var(--mute)] mt-1">版本信息 · 出站代理 · Webhooks</p>
      </header>

      {info && (
        <section className="p-5 rounded-[6px] border border-[var(--line)] bg-[var(--surface)]">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[14px] font-medium">运行信息</h2>
            <Button variant="ghost" disabled={reloading} onClick={reload}>{reloading ? '重载中…' : '重载配置'}</Button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-[13px]">
            <div><div className="text-[11px] text-[var(--mute)]">环境</div><div className="mt-1"><Pill tone={info.deployment === 'gwbk' ? 'info' : 'accent'}>{info.deployment}</Pill></div></div>
            <div><div className="text-[11px] text-[var(--mute)]">版本</div><div className="mt-1 font-mono text-[12px]">{info.version}</div></div>
            <div><div className="text-[11px] text-[var(--mute)]">Commit</div><div className="mt-1 font-mono text-[11px]">{info.commit?.slice(0, 8)}</div></div>
            <div><div className="text-[11px] text-[var(--mute)]">部署时间</div><div className="mt-1">{info.deployedAt ? new Date(info.deployedAt).toLocaleString() : '-'}</div></div>
            <div><div className="text-[11px] text-[var(--mute)]">Node</div><div className="mt-1">{info.nodeVersion}</div></div>
            <div><div className="text-[11px] text-[var(--mute)]">运行时长</div><div className="mt-1 tabular-nums">{Math.floor(info.uptimeSec / 3600)} 小时</div></div>
          </div>
        </section>
      )}

      <section>
        <h2 className="text-[14px] font-medium mb-3">出站代理</h2>
        <ProxyTable />
      </section>

      <section>
        <h2 className="text-[14px] font-medium mb-3">Webhooks</h2>
        <WebhooksTable />
      </section>
    </div>
  )
}
```

- [ ] **Step 4**: 路由

```tsx
import AdminSystemPage from './pages/admin/AdminSystemPage'
<Route path="/admin/system" element={<AdminSystemPage />} />
```

- [ ] **Step 5**: 提交

```bash
git add web/src/pages/admin/AdminSystemPage.tsx web/src/pages/admin/_system web/src/router.tsx
git commit -m "feat(admin-system): system info + proxies + webhooks on one page"
```

---

## Task 2: 部署 + 合并

- [ ] 部署、点重载 → `audit_logs` 出 `system.reload`
- [ ] merge

```bash
git fetch origin main && git rebase origin/main
git checkout main && git merge --no-ff feat/admin-system -m "merge: feat/admin-system"
git push origin main
```
