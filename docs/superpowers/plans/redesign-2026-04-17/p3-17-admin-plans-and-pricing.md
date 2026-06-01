# Admin Plans & Pricing Implementation Plan — `feat/admin-plans-and-pricing`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 合并原 `/admin/plans`、`/admin/pricing`、`/admin/quotas` 三处到一个页面 `/admin/plans`：
- Tab A "套餐"：列出 plans、创建/编辑/删除；字段包括 price_cents, request_limit, allowed_models, active_session_limit, context_1m。
- Tab B "模型定价"：列出每个模型的 input/output token 单价。
- Tab C "订阅"：查看谁订阅了哪个 plan，手动 grant / revoke / 调账户余额。

**Architecture:**
- 后端大部分端点已有（`server/src/routes/admin.ts` 里的 plans/pricing/quotas handlers）。本分支只做：新增 `POST /admin/plans/:id/assign` （grant）与 `DELETE /admin/subscriptions/:id` （revoke）的门面，以及 `POST /admin/balances/:userId/adjust`。
- 前端新 `AdminPlansPage.tsx` 合并三 Tab。

**Tech Stack:** React 19 + `@/ui` + Express。

---

## 约束

1. 编辑 plan 的 `allowed_models` 用多选 chip（`@/ui/Chip`），不用自由输入避免打错模型 ID。
2. 调余额支持负数（扣款），必须要求 `note` 字段，写入 `balance_ledger`。
3. 删除 plan 前必须检查没有活跃订阅引用它；有则拒绝并提示。
4. 禁 emoji、禁渐变色、禁 PR。

---

## 文件结构

**Create:**
- `web/src/pages/admin/AdminPlansPage.tsx`（替换现有）
- `web/src/pages/admin/_plans/PlanTab.tsx`
- `web/src/pages/admin/_plans/PricingTab.tsx`
- `web/src/pages/admin/_plans/SubscriptionsTab.tsx`

**Modify:**
- `server/src/routes/admin.ts` — 3 个新 handler
- `web/src/router.tsx`

---

## Task 1: 后端 grant/revoke/adjust

- [ ] **Step 1**:

```bash
cd /path/to/cc-gateway
git checkout main && git pull && git checkout -b feat/admin-plans-and-pricing
```

- [ ] **Step 2**: 加 handlers

```typescript
router.post('/plans/:id/assign', requireAdmin, async (req, res) => {
  const { userId, periodDays = 30 } = req.body ?? {}
  if (!userId) return res.status(400).json({ error: 'userId required' })
  const plan = (await query(`SELECT id, name FROM plans WHERE id=$1`, [req.params.id])).rows[0]
  if (!plan) return res.status(404).json({ error: 'plan not found' })
  await query(`UPDATE subscriptions SET status='expired' WHERE user_id=$1 AND status='active'`, [userId])
  const { rows } = await query(
    `INSERT INTO subscriptions (user_id, plan_id, status, period_start, period_end, request_used)
     VALUES ($1, $2, 'active', now(), now() + ($3 || ' days')::interval, 0)
     RETURNING id`,
    [userId, req.params.id, String(periodDays)],
  )
  await audit(req, {
    action: 'subscription.grant', resource_type: 'subscription', resource_id: rows[0].id,
    after: { user_id: userId, plan_id: req.params.id, period_days: periodDays },
    summary: `grant ${plan.name} → ${userId}`,
  })
  res.json({ ok: true, id: rows[0].id })
})

router.delete('/subscriptions/:id', requireAdmin, async (req, res) => {
  const before = (await query(`SELECT * FROM subscriptions WHERE id=$1`, [req.params.id])).rows[0]
  if (!before) return res.status(404).json({ error: 'not found' })
  await query(`UPDATE subscriptions SET status='revoked' WHERE id=$1`, [req.params.id])
  await audit(req, { action: 'subscription.revoke', resource_type: 'subscription', resource_id: req.params.id, before })
  res.json({ ok: true })
})

router.post('/balances/:userId/adjust', requireAdmin, async (req, res) => {
  const { amountCents, note } = req.body ?? {}
  if (typeof amountCents !== 'number' || !note) return res.status(400).json({ error: 'amountCents + note required' })
  await query(
    `INSERT INTO user_balances (user_id, balance_cents) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET balance_cents = user_balances.balance_cents + EXCLUDED.balance_cents`,
    [req.params.userId, amountCents],
  )
  await query(
    `INSERT INTO balance_ledger (user_id, amount_cents, kind, note) VALUES ($1, $2, 'admin_adjust', $3)`,
    [req.params.userId, amountCents, note],
  )
  await audit(req, {
    action: 'subscription.adjust_balance', resource_type: 'user', resource_id: req.params.userId,
    after: { amount_cents: amountCents, note },
    summary: `adjust balance ${amountCents >= 0 ? '+' : ''}${amountCents}`,
  })
  res.json({ ok: true })
})
```

（注意 `user_balances` / `balance_ledger` 表名沿用 p2-11 的结论。若实际不同，提前 `Grep` 定位。）

- [ ] **Step 3**: 提交

```bash
git add server/src/routes/admin.ts
git commit -m "feat(admin-plans): grant/revoke subscription + adjust balance endpoints"
```

---

## Task 2: 前端 3-Tab 页面

- [ ] **Step 1**: PlanTab

```tsx
// web/src/pages/admin/_plans/PlanTab.tsx
import { useEffect, useState } from 'react'
import { api } from '../../../api/client'
import { Button, Field, Input, Table, Chip, Modal, Checkbox } from '../../../ui'

const MODELS = [
  'claude-opus-4-7', 'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001', 'claude-opus-4-1',
  'claude-sonnet-3-7', 'claude-haiku-3-5',
]

export default function PlanTab() {
  const [items, setItems] = useState<any[]>([])
  const [editing, setEditing] = useState<any | null>(null)
  const [form, setForm] = useState<any>({ name: '', price_cents: 0, request_limit: null, allowed_models: [], context_1m: false })

  async function load() { setItems((await api('/admin/plans')).items ?? []) }
  useEffect(() => { load() }, [])

  function openNew() {
    setEditing({})
    setForm({ name: '', price_cents: 0, request_limit: null, allowed_models: [], context_1m: false })
  }
  function openEdit(p: any) {
    setEditing(p)
    setForm({ ...p, allowed_models: p.allowed_models ?? [] })
  }
  async function save() {
    if (editing?.id) {
      await api(`/admin/plans/${editing.id}`, { method: 'PATCH', body: JSON.stringify(form) })
    } else {
      await api('/admin/plans', { method: 'POST', body: JSON.stringify(form) })
    }
    setEditing(null); await load()
  }
  async function remove(p: any) {
    if (!confirm(`删除 ${p.name}？若存在活跃订阅将被拒绝。`)) return
    try {
      await api(`/admin/plans/${p.id}`, { method: 'DELETE' })
      await load()
    } catch (e: any) { alert(e?.message || '删除失败') }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end"><Button variant="primary" onClick={openNew}>新建套餐</Button></div>
      <Table
        columns={[
          { key: 'name', label: '名称' },
          { key: 'price_cents', label: '价格', render: (r) => `¥ ${(r.price_cents/100).toFixed(2)}` },
          { key: 'request_limit', label: '请求额度', render: (r) => r.request_limit ?? '∞' },
          { key: 'allowed_models', label: '允许模型', render: (r) => (
            <div className="flex flex-wrap gap-1">{(r.allowed_models ?? []).map((m: string) => <Chip key={m}>{m}</Chip>)}</div>
          ) },
          { key: 'context_1m', label: '1M Ctx', render: (r) => r.context_1m ? '是' : '-' },
          { key: 'action', label: '', render: (r) => (
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => openEdit(r)}>编辑</Button>
              <Button variant="ghost" onClick={() => remove(r)}>删除</Button>
            </div>
          ) },
        ]}
        rows={items}
        empty="暂无套餐。"
      />

      {editing !== null && (
        <Modal onClose={() => setEditing(null)} title={editing?.id ? `编辑 ${editing.name}` : '新建套餐'}>
          <div className="space-y-3">
            <Field label="名称"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="价格 (分)"><Input type="number" value={form.price_cents ?? 0} onChange={(e) => setForm({ ...form, price_cents: Number(e.target.value) })} /></Field>
            <Field label="请求额度（空为无限）">
              <Input type="number" value={form.request_limit ?? ''} onChange={(e) => setForm({ ...form, request_limit: e.target.value === '' ? null : Number(e.target.value) })} />
            </Field>
            <Field label="允许模型">
              <div className="flex flex-wrap gap-2">
                {MODELS.map((m) => {
                  const on = (form.allowed_models ?? []).includes(m)
                  return (
                    <button
                      key={m}
                      className={`px-2 py-1 text-[12px] rounded border ${on ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--line)] text-[var(--mute)]'}`}
                      onClick={() => setForm({
                        ...form,
                        allowed_models: on
                          ? form.allowed_models.filter((x: string) => x !== m)
                          : [...(form.allowed_models ?? []), m],
                      })}
                    >{m}</button>
                  )
                })}
              </div>
            </Field>
            <Checkbox checked={!!form.context_1m} onChange={(e) => setForm({ ...form, context_1m: e.target.checked })}>启用 1M 上下文</Checkbox>
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

- [ ] **Step 2**: PricingTab

```tsx
// web/src/pages/admin/_plans/PricingTab.tsx
import { useEffect, useState } from 'react'
import { api } from '../../../api/client'
import { Table, Input, Button } from '../../../ui'

export default function PricingTab() {
  const [items, setItems] = useState<any[]>([])
  const [edit, setEdit] = useState<Record<string, { input?: string; output?: string }>>({})

  async function load() { setItems((await api('/admin/pricing')).items ?? []) }
  useEffect(() => { load() }, [])

  async function save(model: string) {
    const v = edit[model] ?? {}
    await api(`/admin/pricing/${encodeURIComponent(model)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        input_per_mtok: v.input != null ? Number(v.input) : undefined,
        output_per_mtok: v.output != null ? Number(v.output) : undefined,
      }),
    })
    setEdit({ ...edit, [model]: {} })
    await load()
  }

  return (
    <Table
      columns={[
        { key: 'model', label: '模型' },
        { key: 'input', label: 'Input / Mtok', render: (r) => (
          <Input value={edit[r.model]?.input ?? r.input_per_mtok} onChange={(e) => setEdit({ ...edit, [r.model]: { ...edit[r.model], input: e.target.value } })} />
        ) },
        { key: 'output', label: 'Output / Mtok', render: (r) => (
          <Input value={edit[r.model]?.output ?? r.output_per_mtok} onChange={(e) => setEdit({ ...edit, [r.model]: { ...edit[r.model], output: e.target.value } })} />
        ) },
        { key: 'action', label: '', render: (r) => <Button variant="ghost" onClick={() => save(r.model)}>保存</Button> },
      ]}
      rows={items}
      empty="暂无定价。"
    />
  )
}
```

- [ ] **Step 3**: SubscriptionsTab

```tsx
// web/src/pages/admin/_plans/SubscriptionsTab.tsx
import { useEffect, useState } from 'react'
import { api } from '../../../api/client'
import { Table, Pill, Button, Modal, Field, Input, Select } from '../../../ui'

export default function SubscriptionsTab() {
  const [items, setItems] = useState<any[]>([])
  const [granting, setGranting] = useState(false)
  const [grant, setGrant] = useState({ userId: '', planId: '', periodDays: 30 })
  const [adjust, setAdjust] = useState<{ userId: string; amountCents: string; note: string } | null>(null)
  const [users, setUsers] = useState<any[]>([])
  const [plans, setPlans] = useState<any[]>([])

  async function load() {
    const [s, u, p] = await Promise.all([api('/admin/subscriptions'), api('/admin/users'), api('/admin/plans')])
    setItems(s.items ?? s); setUsers(u.items ?? u); setPlans(p.items ?? p)
  }
  useEffect(() => { load() }, [])

  async function doGrant() {
    await api(`/admin/plans/${grant.planId}/assign`, { method: 'POST', body: JSON.stringify({ userId: grant.userId, periodDays: grant.periodDays }) })
    setGranting(false); setGrant({ userId: '', planId: '', periodDays: 30 }); await load()
  }
  async function doRevoke(id: string) {
    if (!confirm('撤销订阅？')) return
    await api(`/admin/subscriptions/${id}`, { method: 'DELETE' })
    await load()
  }
  async function doAdjust() {
    if (!adjust) return
    await api(`/admin/balances/${adjust.userId}/adjust`, { method: 'POST', body: JSON.stringify({ amountCents: Number(adjust.amountCents), note: adjust.note }) })
    setAdjust(null); await load()
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <Button variant="primary" onClick={() => setGranting(true)}>手动授予</Button>
      </div>
      <Table
        columns={[
          { key: 'user_email', label: '用户' },
          { key: 'plan_name', label: '套餐' },
          { key: 'period_end', label: '到期', render: (r) => new Date(r.period_end).toLocaleDateString() },
          { key: 'status', label: '状态', render: (r) => <Pill tone={r.status === 'active' ? 'ok' : 'mute'}>{r.status}</Pill> },
          { key: 'action', label: '', render: (r) => (
            <div className="flex gap-2">
              {r.status === 'active' && <Button variant="ghost" onClick={() => doRevoke(r.id)}>撤销</Button>}
              <Button variant="ghost" onClick={() => setAdjust({ userId: r.user_id, amountCents: '', note: '' })}>调余额</Button>
            </div>
          ) },
        ]}
        rows={items}
        empty="没有订阅。"
      />

      {granting && (
        <Modal onClose={() => setGranting(false)} title="手动授予订阅">
          <Field label="用户">
            <Select value={grant.userId} onChange={(e) => setGrant({ ...grant, userId: e.target.value })}>
              <option value="">选择…</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
            </Select>
          </Field>
          <Field label="套餐">
            <Select value={grant.planId} onChange={(e) => setGrant({ ...grant, planId: e.target.value })}>
              <option value="">选择…</option>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="周期天数"><Input type="number" value={grant.periodDays} onChange={(e) => setGrant({ ...grant, periodDays: Number(e.target.value) })} /></Field>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setGranting(false)}>取消</Button>
            <Button variant="primary" disabled={!grant.userId || !grant.planId} onClick={doGrant}>授予</Button>
          </div>
        </Modal>
      )}

      {adjust && (
        <Modal onClose={() => setAdjust(null)} title="调整余额">
          <Field label="金额（分，负数为扣款）"><Input value={adjust.amountCents} onChange={(e) => setAdjust({ ...adjust, amountCents: e.target.value })} /></Field>
          <Field label="备注"><Input value={adjust.note} onChange={(e) => setAdjust({ ...adjust, note: e.target.value })} /></Field>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAdjust(null)}>取消</Button>
            <Button variant="primary" disabled={!adjust.amountCents || !adjust.note} onClick={doAdjust}>确认</Button>
          </div>
        </Modal>
      )}
    </div>
  )
}
```

- [ ] **Step 4**: 总页面

```tsx
// web/src/pages/admin/AdminPlansPage.tsx
import { useState } from 'react'
import { Segmented } from '../../ui'
import PlanTab from './_plans/PlanTab'
import PricingTab from './_plans/PricingTab'
import SubscriptionsTab from './_plans/SubscriptionsTab'

export default function AdminPlansPage() {
  const [tab, setTab] = useState('plans')
  return (
    <div className="max-w-[1200px] space-y-6">
      <header>
        <h1 className="text-[26px] font-serif">套餐与价格</h1>
        <p className="text-[13px] text-[var(--mute)] mt-1">套餐 · 模型定价 · 订阅</p>
      </header>
      <Segmented value={tab} options={[
        { value: 'plans', label: '套餐' },
        { value: 'pricing', label: '模型定价' },
        { value: 'subs', label: '订阅' },
      ]} onChange={setTab as any} />

      {tab === 'plans' && <PlanTab />}
      {tab === 'pricing' && <PricingTab />}
      {tab === 'subs' && <SubscriptionsTab />}
    </div>
  )
}
```

- [ ] **Step 5**: 路由

```tsx
import AdminPlansPage from './pages/admin/AdminPlansPage'
<Route path="/admin/plans" element={<AdminPlansPage />} />
```

老 `AdminQuotasPage` / `AdminPricingPage` 路径不再需要 — 如果 AppShell 还在引用，删掉旧导航项（理论上 p1-03 已经去掉）。

- [ ] **Step 6**: 提交

```bash
git add web/src/pages/admin/AdminPlansPage.tsx web/src/pages/admin/_plans web/src/router.tsx
git commit -m "feat(admin-plans): unified plans/pricing/subscriptions page"
```

---

## Task 3: 部署 + 合并

- [ ] 部署、三个 Tab 各跑一次写操作
- [ ] 验证 `audit_logs` 收到 `plan.*` / `subscription.*`
- [ ] merge

```bash
git fetch origin main && git rebase origin/main
git checkout main && git merge --no-ff feat/admin-plans-and-pricing -m "merge: feat/admin-plans-and-pricing"
git push origin main
```
