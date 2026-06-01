# Admin Campaigns Implementation Plan — `feat/admin-campaigns`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/admin/campaigns` 页重做：活动列表 + 新建/编辑（奖励类型、触发条件、名额）+ 兑换记录查询。使用 `@/ui`。

**Architecture:**
- 后端现有 `server/src/routes/campaigns.ts`；本分支不新增业务 handler，只前端重写 + 补 audit（若 p1-06 未覆盖）。
- 前端 `web/src/pages/admin/AdminCampaignsPage.tsx`（替换）。

**Tech Stack:** React 19 + `@/ui` + Express。

---

## 约束

1. 兑换记录表格按 claimed_at 倒序、分页 50。
2. 创建活动必须设截止时间；不允许无上限。
3. 禁 emoji、禁渐变色、禁 PR。

---

## 文件结构

**Modify:**
- `web/src/pages/admin/AdminCampaignsPage.tsx`（若不存在则创建）
- `server/src/routes/campaigns.ts`（如 p1-06 未埋 audit 则补）
- `web/src/router.tsx`

---

## Task 1: 切分支 + 前端重写

- [ ] **Step 1**:

```bash
cd /path/to/cc-gateway
git checkout main && git pull && git checkout -b feat/admin-campaigns
```

- [ ] **Step 2**: 确认后端 endpoint 形状

Run: `Grep` pattern `router\.(get|post|patch|delete).*campaign` in `server/src/routes/campaigns.ts`
Expected: 列出 CRUD + 兑换记录端点；写下对应 path 供前端使用。

- [ ] **Step 3**: 若 audit 未埋点，在 create/update/delete handler 前插入：

```typescript
await audit(req, { action: 'system.campaign_create', resource_type: 'campaign', resource_id: created.id, after: created })
```

- [ ] **Step 4**: 前端页面

```tsx
// web/src/pages/admin/AdminCampaignsPage.tsx
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Segmented, Button, Field, Input, Select, Table, Pill, Modal } from '../../ui'

type Campaign = {
  id: string; name: string; reward_type: string; reward_amount: number
  quota: number; claimed: number; expires_at: string; status: string
}

export default function AdminCampaignsPage() {
  const [tab, setTab] = useState<'list' | 'redemptions'>('list')
  const [items, setItems] = useState<Campaign[]>([])
  const [redemptions, setRedemptions] = useState<any[]>([])
  const [editing, setEditing] = useState<any | null>(null)
  const [form, setForm] = useState<any>({
    name: '', reward_type: 'balance_credit', reward_amount: 0,
    quota: 100, expires_at: '',
  })

  async function load() {
    if (tab === 'list') setItems((await api('/admin/campaigns')).items ?? [])
    else setRedemptions((await api('/admin/campaigns/redemptions?limit=50')).items ?? [])
  }
  useEffect(() => { load() }, [tab])

  async function save() {
    if (!form.expires_at) { alert('必须设置截止时间'); return }
    const payload = { ...form, expires_at: new Date(form.expires_at).toISOString() }
    if (editing?.id) {
      await api(`/admin/campaigns/${editing.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
    } else {
      await api('/admin/campaigns', { method: 'POST', body: JSON.stringify(payload) })
    }
    setEditing(null); await load()
  }
  async function remove(id: string) {
    if (!confirm('删除活动？已兑换的记录不受影响。')) return
    await api(`/admin/campaigns/${id}`, { method: 'DELETE' })
    await load()
  }

  return (
    <div className="max-w-[1200px] space-y-6">
      <header>
        <h1 className="text-[26px] font-serif">推广活动</h1>
        <p className="text-[13px] text-[var(--mute)] mt-1">奖励与兑换管理</p>
      </header>

      <Segmented value={tab} onChange={setTab as any} options={[
        { value: 'list', label: '活动' },
        { value: 'redemptions', label: '兑换记录' },
      ]} />

      {tab === 'list' && (
        <>
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => { setEditing({}); setForm({ name: '', reward_type: 'balance_credit', reward_amount: 0, quota: 100, expires_at: '' }) }}>新建活动</Button>
          </div>
          <Table
            columns={[
              { key: 'name', label: '活动' },
              { key: 'reward', label: '奖励', render: (r: Campaign) => `${r.reward_type} · ${r.reward_amount}` },
              { key: 'quota', label: '名额', render: (r: Campaign) => `${r.claimed} / ${r.quota}` },
              { key: 'expires_at', label: '截止', render: (r: Campaign) => new Date(r.expires_at).toLocaleDateString() },
              { key: 'status', label: '状态', render: (r: Campaign) => <Pill tone={r.status === 'active' ? 'ok' : 'mute'}>{r.status}</Pill> },
              { key: 'action', label: '', render: (r: Campaign) => (
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => { setEditing(r); setForm({ ...r, expires_at: r.expires_at.slice(0, 10) }) }}>编辑</Button>
                  <Button variant="ghost" onClick={() => remove(r.id)}>删除</Button>
                </div>
              ) },
            ]}
            rows={items}
            empty="暂无活动。"
          />
        </>
      )}

      {tab === 'redemptions' && (
        <Table
          columns={[
            { key: 'claimed_at', label: '时间', render: (r) => new Date(r.claimed_at).toLocaleString() },
            { key: 'campaign_name', label: '活动' },
            { key: 'user_email', label: '用户' },
            { key: 'reward_amount', label: '奖励' },
          ]}
          rows={redemptions}
          empty="没有兑换记录。"
        />
      )}

      {editing !== null && (
        <Modal onClose={() => setEditing(null)} title={editing?.id ? `编辑 ${editing.name}` : '新建活动'}>
          <div className="space-y-3">
            <Field label="名称"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="奖励类型">
              <Select value={form.reward_type} onChange={(e) => setForm({ ...form, reward_type: e.target.value })}>
                <option value="balance_credit">余额充值</option>
                <option value="plan_trial">试用套餐</option>
                <option value="request_bonus">请求额度奖励</option>
              </Select>
            </Field>
            <Field label="奖励数值"><Input type="number" value={form.reward_amount} onChange={(e) => setForm({ ...form, reward_amount: Number(e.target.value) })} /></Field>
            <Field label="名额"><Input type="number" value={form.quota} onChange={(e) => setForm({ ...form, quota: Number(e.target.value) })} /></Field>
            <Field label="截止日期"><Input type="date" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} /></Field>
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

- [ ] **Step 5**: 路由

```tsx
import AdminCampaignsPage from './pages/admin/AdminCampaignsPage'
<Route path="/admin/campaigns" element={<AdminCampaignsPage />} />
```

- [ ] **Step 6**: 提交

```bash
git add web/src/pages/admin/AdminCampaignsPage.tsx server/src/routes/campaigns.ts web/src/router.tsx
git commit -m "feat(admin-campaigns): page rewrite + audit coverage"
```

---

## Task 2: 部署 + 合并

- [ ] 部署，新建 / 编辑 / 删除 各一次 → audit 验证
- [ ] merge

```bash
git fetch origin main && git rebase origin/main
git checkout main && git merge --no-ff feat/admin-campaigns -m "merge: feat/admin-campaigns"
git push origin main
```
