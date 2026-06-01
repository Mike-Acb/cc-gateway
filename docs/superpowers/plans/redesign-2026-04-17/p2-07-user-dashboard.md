# User Dashboard Implementation Plan — `feat/user-dashboard`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现用户端"总览"页（`/`）：顶部 4 个 KPI 卡 + 近 7 天请求量曲线 + Top 客户端 / Top 模型 柱状图 + 最近被拦截请求列表 + 当前订阅信息。

**Architecture:**
- 读 `server/src/routes/usage.ts` 扩展的新 endpoint `/api/me/dashboard`，一次返回所有聚合数据避免多次 roundtrip。
- 前端 `web/src/pages/dashboard/DashboardPage.tsx`（替换 p1-03 的 stub），全部使用 `@/ui` 组件。
- 图表用 `@/ui/chart/SparkLine` `StackedBars`；不引新依赖。

**Tech Stack:** React 19 + TailwindCSS v4 + `@/ui`（来自 p1-02）+ Express + PostgreSQL。

---

## 约束

1. **一次 API 返回全部数据** — 不允许多次请求拼装首屏。
2. **时间窗固定 7 天**（`now()-7 days`），复用 request_logs + usage_records。
3. 禁止渐变色；所有颜色走 `var(--accent|ok|warn|err|info)`。
4. 不提 PR、禁 emoji。

---

## 文件结构

**Create:**
- `server/src/routes/dashboard.ts`
- `web/src/pages/dashboard/DashboardPage.tsx`
- `tests/me-dashboard.test.ts`

**Modify:**
- `server/src/index.ts` — 挂 `/api/me/dashboard`
- `web/src/router.tsx` — 把 `/` 从 stub 换成真实页

---

## Task 1: 切分支 + 后端 DTO

- [ ] **Step 1**: 切分支

```bash
cd /path/to/cc-gateway
git checkout main && git pull && git checkout -b feat/user-dashboard
```

- [ ] **Step 2**: 写失败测试

```typescript
// tests/me-dashboard.test.ts
import { strict as assert } from 'assert'
import { loadDashboardForUser } from '../server/src/routes/dashboard.js'

async function main() {
  const data = await loadDashboardForUser('00000000-0000-0000-0000-000000000000') // 不存在
  assert.deepEqual(data.kpis, {
    requestCount7d: 0, successRate7d: 1, blockedCount7d: 0, tokenCount7d: 0,
  })
  assert.ok(Array.isArray(data.trend))
  assert.equal(data.trend.length, 7)
  assert.ok(Array.isArray(data.topClients))
  assert.ok(Array.isArray(data.topModels))
  assert.ok(Array.isArray(data.recentBlocks))
  assert.ok(data.subscription === null || typeof data.subscription === 'object')
  console.log('OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 3**: 跑，确认失败

```bash
npx tsx tests/me-dashboard.test.ts
```

---

## Task 2: loadDashboardForUser 实现

**Files:** Create `server/src/routes/dashboard.ts`

- [ ] **Step 1**: 写 loader

```typescript
// server/src/routes/dashboard.ts
import { Router } from 'express'
import { requireUser } from '../middleware/auth'
import { query } from '../db'

export type DashboardDTO = {
  kpis: {
    requestCount7d: number
    successRate7d: number // 0..1
    blockedCount7d: number
    tokenCount7d: number
  }
  trend: Array<{ date: string; success: number; blocked: number }>
  topClients: Array<{ name: string; count: number }>
  topModels: Array<{ model: string; count: number }>
  recentBlocks: Array<{
    id: string
    created_at: string
    client_name: string
    request_model: string | null
    block_reason: string | null
    block_source: string | null
    response_status: number | null
  }>
  subscription: {
    plan_name: string
    period_end: string
    request_limit: number | null
    request_used: number
    balance_cents: number
  } | null
}

export async function loadDashboardForUser(userId: string): Promise<DashboardDTO> {
  const [kpiRes, trendRes, topClientsRes, topModelsRes, blockRes, subRes] = await Promise.all([
    query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE block_reason IS NULL AND response_status BETWEEN 200 AND 299)::int AS ok_cnt,
         COUNT(*) FILTER (WHERE block_reason IS NOT NULL)::int AS blocked_cnt
       FROM request_logs rl
       JOIN clients c ON c.id = rl.client_id
       WHERE c.user_id = $1 AND rl.created_at >= now() - INTERVAL '7 days'`,
      [userId],
    ),
    query(
      `SELECT
         to_char(d::date, 'YYYY-MM-DD') AS date,
         COALESCE(SUM(CASE WHEN rl.block_reason IS NULL AND rl.response_status BETWEEN 200 AND 299 THEN 1 ELSE 0 END), 0)::int AS success,
         COALESCE(SUM(CASE WHEN rl.block_reason IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS blocked
       FROM generate_series(
              (now() - INTERVAL '6 days')::date,
              now()::date,
              INTERVAL '1 day'
            ) d
       LEFT JOIN request_logs rl
         ON rl.created_at::date = d::date
        AND rl.client_id IN (SELECT id FROM clients WHERE user_id = $1)
       GROUP BY d ORDER BY d`,
      [userId],
    ),
    query(
      `SELECT c.name, COUNT(*)::int AS count
         FROM request_logs rl
         JOIN clients c ON c.id = rl.client_id
        WHERE c.user_id = $1 AND rl.created_at >= now() - INTERVAL '7 days'
        GROUP BY c.name ORDER BY 2 DESC LIMIT 5`,
      [userId],
    ),
    query(
      `SELECT request_model AS model, COUNT(*)::int AS count
         FROM request_logs rl
         JOIN clients c ON c.id = rl.client_id
        WHERE c.user_id = $1 AND rl.created_at >= now() - INTERVAL '7 days'
          AND rl.request_model IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
      [userId],
    ),
    query(
      `SELECT rl.id::text AS id, rl.created_at, c.name AS client_name,
              rl.request_model, rl.block_reason, rl.block_source, rl.response_status
         FROM request_logs rl
         JOIN clients c ON c.id = rl.client_id
        WHERE c.user_id = $1 AND rl.block_reason IS NOT NULL
          AND rl.created_at >= now() - INTERVAL '7 days'
        ORDER BY rl.created_at DESC LIMIT 10`,
      [userId],
    ),
    query(
      `SELECT p.name AS plan_name, s.period_end, p.request_limit, s.request_used,
              COALESCE(b.balance_cents, 0) AS balance_cents
         FROM subscriptions s
         JOIN plans p ON p.id = s.plan_id
         LEFT JOIN user_balances b ON b.user_id = s.user_id
        WHERE s.user_id = $1 AND s.status = 'active'
        ORDER BY s.period_end DESC LIMIT 1`,
      [userId],
    ),
  ])

  const k = kpiRes.rows[0] ?? { total: 0, ok_cnt: 0, blocked_cnt: 0 }
  const total = k.total ?? 0
  return {
    kpis: {
      requestCount7d: total,
      successRate7d: total === 0 ? 1 : (k.ok_cnt ?? 0) / total,
      blockedCount7d: k.blocked_cnt ?? 0,
      tokenCount7d: 0,
    },
    trend: trendRes.rows,
    topClients: topClientsRes.rows,
    topModels: topModelsRes.rows,
    recentBlocks: blockRes.rows,
    subscription: subRes.rows[0] ?? null,
  }
}

const router = Router()
router.get('/dashboard', requireUser, async (req, res) => {
  const userId = (req as any).user.id
  res.json(await loadDashboardForUser(userId))
})
export default router
```

- [ ] **Step 2**: 挂路由

```typescript
// server/src/index.ts
import dashboardRouter from './routes/dashboard'
app.use('/api/me', dashboardRouter)
```

- [ ] **Step 3**: 测试通过

```bash
npx tsx tests/me-dashboard.test.ts
```

- [ ] **Step 4**: 提交

```bash
git add server/src/routes/dashboard.ts server/src/index.ts tests/me-dashboard.test.ts
git commit -m "feat(dashboard): /api/me/dashboard aggregator"
```

---

## Task 3: 前端页面

**Files:**
- Create: `web/src/pages/dashboard/DashboardPage.tsx`
- Modify: `web/src/router.tsx`

- [ ] **Step 1**: 写页面

```tsx
// web/src/pages/dashboard/DashboardPage.tsx
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { StatGrid, Pill, Table } from '../../ui'
import { SparkLine } from '../../ui/chart/SparkLine'
import { Bars } from '../../ui/chart/Bars'

type Dto = import('../../api/types').DashboardDto // 若无类型文件，本地复制下方 shape

export default function DashboardPage() {
  const [data, setData] = useState<Dto | null>(null)
  useEffect(() => {
    api('/me/dashboard').then(setData).catch(() => setData(null))
  }, [])

  if (!data) return <div className="text-[13px] text-[var(--mute)]">Loading…</div>

  return (
    <div className="max-w-[1040px] space-y-7">
      <header>
        <h1 className="text-[26px] font-serif">总览</h1>
        <p className="text-[13px] text-[var(--mute)] mt-1">近 7 天使用情况</p>
      </header>

      <StatGrid
        items={[
          { label: '请求数', value: data.kpis.requestCount7d.toLocaleString() },
          { label: '成功率', value: (data.kpis.successRate7d * 100).toFixed(1) + '%' },
          { label: '被拦截', value: data.kpis.blockedCount7d.toLocaleString() },
          { label: 'Token 消耗', value: data.kpis.tokenCount7d.toLocaleString() },
        ]}
      />

      <section>
        <h2 className="text-[14px] font-medium mb-2">请求趋势</h2>
        <SparkLine
          points={data.trend.map((d) => d.success + d.blocked)}
          labels={data.trend.map((d) => d.date.slice(5))}
          height={120}
        />
      </section>

      <div className="grid md:grid-cols-2 gap-6">
        <section>
          <h2 className="text-[14px] font-medium mb-2">Top 客户端</h2>
          <Bars data={data.topClients.map((c) => ({ label: c.name, value: c.count }))} />
        </section>
        <section>
          <h2 className="text-[14px] font-medium mb-2">Top 模型</h2>
          <Bars data={data.topModels.map((m) => ({ label: m.model, value: m.count }))} />
        </section>
      </div>

      <section>
        <h2 className="text-[14px] font-medium mb-2">最近被拦截</h2>
        <Table
          columns={[
            { key: 'created_at', label: '时间', render: (r) => new Date(r.created_at).toLocaleString() },
            { key: 'client_name', label: '客户端' },
            { key: 'request_model', label: '模型', render: (r) => r.request_model ?? '-' },
            { key: 'block_reason', label: '原因', render: (r) => (
              <Pill tone="warn">{r.block_reason}</Pill>
            ) },
            { key: 'block_source', label: '来源', render: (r) => r.block_source === 'gw' ? '网关' : '上游' },
          ]}
          rows={data.recentBlocks}
          empty="近 7 天没有被拦截的请求。"
        />
      </section>

      {data.subscription && (
        <section className="p-4 rounded-[6px] border border-[var(--line)] bg-[var(--surface)]">
          <h2 className="text-[14px] font-medium mb-2">当前订阅</h2>
          <div className="text-[13px] text-[var(--ink-2)]">
            {data.subscription.plan_name} · 到期 {new Date(data.subscription.period_end).toLocaleDateString()}
            {' · '}余额 ¥{(data.subscription.balance_cents / 100).toFixed(2)}
          </div>
        </section>
      )}
    </div>
  )
}
```

- [ ] **Step 2**: 路由接上

改 `web/src/router.tsx`：

```tsx
import DashboardPage from './pages/dashboard/DashboardPage'
// ...
<Route path="/" element={<DashboardPage />} />
```

- [ ] **Step 3**: 提交

```bash
git add web/src/pages/dashboard/DashboardPage.tsx web/src/router.tsx
git commit -m "feat(dashboard): user dashboard page with KPIs + charts + blocks"
```

---

## Task 4: 部署 + 合并

- [ ] **Step 1**: `./scripts/deploy-gwbk.sh`
- [ ] **Step 2**: 浏览器访问 `https://gwbk.example.com/`，验证：4 个 KPI 卡 / 曲线 / 两个柱状图 / 拦截列表 / 订阅条全部展示
- [ ] **Step 3**: 跑真实请求，刷新，观察数据更新
- [ ] **Step 4**: 合并

```bash
git fetch origin main && git rebase origin/main
git checkout main && git merge --no-ff feat/user-dashboard -m "merge: feat/user-dashboard"
git push origin main
```
