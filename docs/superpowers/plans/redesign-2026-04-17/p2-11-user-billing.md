# User Billing Implementation Plan — `feat/user-billing`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-table. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/billing` 页：把"订阅信息"与"账户余额"拆成两个独立区块展示；订阅历史时间线；余额流水表。

**Architecture:**
- 后端 `/api/me/billing`：返回 `{ activeSubscription, subscriptionHistory, balance, ledger }`。
- 前端 `web/src/pages/billing/BillingPage.tsx`（重写，已有 stub）。
- 时间线视觉使用 ul + 左侧竖线，CSS-only（参考 prototype）。
- 不做支付接口 — 本期只读 + 显示已有数据。

**Tech Stack:** React 19 + `@/ui` + Express + PostgreSQL。

---

## 约束

1. **订阅 ≠ 余额** — UI 上明确分区，文案区分"周期内请求额度"与"账户现金余额"。
2. 金额显示单位："¥ 12.34"，以分为存储单位。
3. 时间线倒序，标记 `已续订 / 升级 / 降级 / 取消 / 首次订阅`。
4. 禁 emoji、禁渐变色、禁 PR。

---

## 文件结构

**Create:**
- `server/src/routes/billing-me.ts`
- `tests/me-billing.test.ts`

**Modify:**
- `web/src/pages/billing/BillingPage.tsx`（现存；重写）
- `server/src/index.ts`

---

## Task 1: 切分支 + 后端

- [ ] **Step 1**:

```bash
cd /path/to/cc-gateway
git checkout main && git pull && git checkout -b feat/user-billing
```

- [ ] **Step 2**: 写 loader

```typescript
// server/src/routes/billing-me.ts
import { Router } from 'express'
import { requireUser } from '../middleware/auth'
import { query } from '../db'

export async function loadBilling(userId: string) {
  const [subs, balance, ledger] = await Promise.all([
    query(
      `SELECT s.id, s.status, s.period_start, s.period_end, s.request_used,
              p.name AS plan_name, p.request_limit, p.price_cents
         FROM subscriptions s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.user_id = $1
        ORDER BY s.period_start DESC LIMIT 20`,
      [userId],
    ),
    query(
      `SELECT COALESCE(balance_cents, 0) AS balance_cents,
              COALESCE(total_topup_cents, 0) AS total_topup_cents,
              COALESCE(total_spend_cents, 0) AS total_spend_cents
         FROM user_balances WHERE user_id = $1`,
      [userId],
    ),
    query(
      `SELECT id, amount_cents, kind, note, created_at
         FROM balance_ledger
        WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 100`,
      [userId],
    ),
  ])
  const history = subs.rows
  const active = history.find((s: any) => s.status === 'active') ?? null
  return {
    activeSubscription: active,
    subscriptionHistory: history,
    balance: balance.rows[0] ?? { balance_cents: 0, total_topup_cents: 0, total_spend_cents: 0 },
    ledger: ledger.rows,
  }
}

const router = Router()
router.get('/billing', requireUser, async (req, res) => {
  const userId = (req as any).user.id
  res.json(await loadBilling(userId))
})
export default router
```

**NOTE:** 若 `user_balances` / `balance_ledger` 表名不同，前置到 Task 1 确认。本分支不创建表 — 只查询；若表不存在，先跑 `Grep` 找真实表名或在进入实现前回头修 SQL。

Run: `Grep` pattern `CREATE TABLE.*balance|user_balance|balance_ledger` in `migrations/`
Expected: 定位真实 schema。若不匹配，按实际表名改 SQL。

- [ ] **Step 3**: 挂路由

```typescript
// server/src/index.ts
import billingMeRouter from './routes/billing-me'
app.use('/api/me', billingMeRouter)
```

- [ ] **Step 4**: 测试

```typescript
// tests/me-billing.test.ts
import { strict as assert } from 'assert'
import { loadBilling } from '../server/src/routes/billing-me.js'
async function main() {
  const r = await loadBilling('00000000-0000-0000-0000-000000000000')
  assert.ok(r.balance)
  assert.ok(Array.isArray(r.subscriptionHistory))
  assert.ok(Array.isArray(r.ledger))
  console.log('OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
```

```bash
npx tsx tests/me-billing.test.ts
```

- [ ] **Step 5**: 提交

```bash
git add server/src/routes/billing-me.ts server/src/index.ts tests/me-billing.test.ts
git commit -m "feat(billing): /api/me/billing returns subscription + balance + ledger"
```

---

## Task 2: 前端页面

**Files:** Modify `web/src/pages/billing/BillingPage.tsx`

- [ ] **Step 1**:

```tsx
// web/src/pages/billing/BillingPage.tsx
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Pill, Table } from '../../ui'

type Dto = {
  activeSubscription: any | null
  subscriptionHistory: any[]
  balance: { balance_cents: number; total_topup_cents: number; total_spend_cents: number }
  ledger: any[]
}

function yuan(cents: number): string { return `¥ ${(cents / 100).toFixed(2)}` }

export default function BillingPage() {
  const [data, setData] = useState<Dto | null>(null)
  useEffect(() => { api('/me/billing').then(setData) }, [])
  if (!data) return <div className="text-[13px] text-[var(--mute)]">Loading…</div>

  const active = data.activeSubscription
  return (
    <div className="max-w-[1040px] space-y-8">
      <header>
        <h1 className="text-[26px] font-serif">账单</h1>
        <p className="text-[13px] text-[var(--mute)] mt-1">订阅与余额</p>
      </header>

      {/* 订阅 */}
      <section className="p-5 rounded-[6px] border border-[var(--line)] bg-[var(--surface)]">
        <h2 className="text-[14px] font-medium mb-3">当前订阅</h2>
        {active ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-[13px]">
            <div>
              <div className="text-[11px] text-[var(--mute)]">套餐</div>
              <div className="mt-1 text-[15px] font-medium">{active.plan_name}</div>
            </div>
            <div>
              <div className="text-[11px] text-[var(--mute)]">周期</div>
              <div className="mt-1">{active.period_start?.slice(0, 10)} → {active.period_end?.slice(0, 10)}</div>
            </div>
            <div>
              <div className="text-[11px] text-[var(--mute)]">已用 / 额度</div>
              <div className="mt-1 tabular-nums">{active.request_used} / {active.request_limit ?? '∞'}</div>
            </div>
            <div>
              <div className="text-[11px] text-[var(--mute)]">状态</div>
              <div className="mt-1"><Pill tone="ok">{active.status}</Pill></div>
            </div>
          </div>
        ) : (
          <div className="text-[13px] text-[var(--mute)]">暂无活动订阅。</div>
        )}
      </section>

      {/* 余额 */}
      <section className="p-5 rounded-[6px] border border-[var(--line)] bg-[var(--surface)]">
        <h2 className="text-[14px] font-medium mb-3">账户余额</h2>
        <div className="grid grid-cols-3 gap-6 text-[13px]">
          <div>
            <div className="text-[11px] text-[var(--mute)]">当前余额</div>
            <div className="mt-1 text-[20px] font-medium tabular-nums">{yuan(data.balance.balance_cents)}</div>
          </div>
          <div>
            <div className="text-[11px] text-[var(--mute)]">累计充值</div>
            <div className="mt-1 tabular-nums">{yuan(data.balance.total_topup_cents)}</div>
          </div>
          <div>
            <div className="text-[11px] text-[var(--mute)]">累计消耗</div>
            <div className="mt-1 tabular-nums">{yuan(data.balance.total_spend_cents)}</div>
          </div>
        </div>
      </section>

      {/* 订阅历史 */}
      <section>
        <h2 className="text-[14px] font-medium mb-3">订阅时间线</h2>
        <ul className="relative border-l border-[var(--line)] pl-5 space-y-4">
          {data.subscriptionHistory.map((s: any, idx: number) => (
            <li key={s.id} className="relative">
              <span className="absolute -left-[7px] top-[6px] w-[10px] h-[10px] rounded-full bg-[var(--accent)]" />
              <div className="text-[13px]">
                <span className="font-medium">{s.plan_name}</span>
                <span className="text-[var(--mute)]"> · {s.period_start?.slice(0,10)} → {s.period_end?.slice(0,10)}</span>
              </div>
              <div className="text-[11px] text-[var(--mute)] mt-0.5">
                <Pill tone={s.status === 'active' ? 'ok' : 'mute'}>{s.status}</Pill>
                {idx === 0 && data.subscriptionHistory.length > 1 && <span className="ml-2">当前</span>}
              </div>
            </li>
          ))}
          {data.subscriptionHistory.length === 0 && <li className="text-[13px] text-[var(--mute)]">没有订阅记录。</li>}
        </ul>
      </section>

      {/* 余额流水 */}
      <section>
        <h2 className="text-[14px] font-medium mb-3">余额流水</h2>
        <Table
          columns={[
            { key: 'created_at', label: '时间', render: (r) => new Date(r.created_at).toLocaleString() },
            { key: 'kind', label: '类型' },
            { key: 'amount_cents', label: '金额', render: (r) => (
              <span className={r.amount_cents >= 0 ? 'text-[var(--ok)]' : 'text-[var(--err)]'}>
                {r.amount_cents >= 0 ? '+' : ''}{yuan(r.amount_cents)}
              </span>
            ) },
            { key: 'note', label: '备注', render: (r) => r.note ?? '-' },
          ]}
          rows={data.ledger}
          empty="暂无流水。"
        />
      </section>
    </div>
  )
}
```

- [ ] **Step 2**: 路由 `/billing` 接真实页

```tsx
import BillingPage from './pages/billing/BillingPage'
<Route path="/billing" element={<BillingPage />} />
```

- [ ] **Step 3**: 提交

```bash
git add web/src/pages/billing/BillingPage.tsx web/src/router.tsx
git commit -m "feat(billing): rewrite page separating subscription vs balance"
```

---

## Task 3: 部署 + 合并

- [ ] 部署、访问 `/billing` 验证
- [ ] merge 回 main

```bash
git fetch origin main && git rebase origin/main
git checkout main && git merge --no-ff feat/user-billing -m "merge: feat/user-billing"
git push origin main
```
