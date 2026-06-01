# Admin Dashboard Implementation Plan — `feat/admin-dashboard`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/admin` 页：5 维度切片（时间 / 账号组 / OAuth 账号 / 用户 / 模型）叠加到同一时间序列图上；顶部 6 个 KPI（总请求 / 总成功率 / 总拦截 / 活跃账号 / 活跃用户 / 总 Token）；底部 4 个 Top 榜单（Top 用户 / Top 模型 / Top 客户端 / Top 被拦截原因）。

**Architecture:**
- 后端 `/api/admin/overview`：接收 `granularity`, `slice`（枚举 group|account|user|model|time），返回 `{ kpis, series }`。
- 前端 `web/src/pages/admin/AdminDashboardPage.tsx`（新），挂 `/admin`。
- 大而重的组件 —— 拆成子组件 `KpiBar.tsx` `SliceChart.tsx` `TopLists.tsx` 放到同目录。

**Tech Stack:** React 19 + `@/ui` + Express + PostgreSQL。

---

## 约束

1. 后端 SQL 必须有聚合索引或 parition pruning；不能全表扫 request_logs 所有分区。默认窗口 7d。
2. 切片颜色稳定：同一 label（如 `user=alice`）在多次渲染颜色一致 —— 用 hash → 预设 12 色调色板。
3. 禁 emoji、禁渐变色、禁 PR。

---

## 文件结构

**Create:**
- `server/src/routes/admin-overview.ts`
- `web/src/pages/admin/AdminDashboardPage.tsx`
- `web/src/pages/admin/_dashboard/KpiBar.tsx`
- `web/src/pages/admin/_dashboard/SliceChart.tsx`
- `web/src/pages/admin/_dashboard/TopLists.tsx`
- `tests/admin-overview.test.ts`

**Modify:**
- `server/src/index.ts`
- `web/src/router.tsx`

---

## Task 1: 切分支 + 后端 overview

- [ ] **Step 1**:

```bash
cd /path/to/cc-gateway
git checkout main && git pull && git checkout -b feat/admin-dashboard
```

- [ ] **Step 2**: 后端

```typescript
// server/src/routes/admin-overview.ts
import { Router } from 'express'
import { requireAdmin } from '../middleware/auth'
import { query } from '../db'

export type Slice = 'time' | 'group' | 'account' | 'user' | 'model'

export async function loadOverview(opts: {
  slice: Slice
  granularity: 'hour' | 'day'
  since: Date
  until: Date
}) {
  const trunc = opts.granularity === 'hour' ? 'hour' : 'day'
  const args = [opts.since.toISOString(), opts.until.toISOString()]

  const kpis = (await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE response_status BETWEEN 200 AND 299 AND block_reason IS NULL)::int AS ok,
       COUNT(*) FILTER (WHERE block_reason IS NOT NULL)::int AS blocked,
       COUNT(DISTINCT oauth_account_id)::int AS active_accounts,
       (SELECT COUNT(DISTINCT c.user_id) FROM request_logs rl
          JOIN clients c ON c.id = rl.client_id
         WHERE rl.created_at >= $1 AND rl.created_at < $2)::int AS active_users,
       COALESCE((SELECT SUM(total_tokens) FROM usage_records WHERE created_at >= $1 AND created_at < $2),0)::bigint AS total_tokens
     FROM request_logs WHERE created_at >= $1 AND created_at < $2`,
    args,
  )).rows[0]

  let groupKey = 'total'
  let series: any[] = []
  if (opts.slice === 'time') {
    series = (await query(
      `SELECT date_trunc('${trunc}', created_at) AS t, COUNT(*)::int AS v
         FROM request_logs WHERE created_at >= $1 AND created_at < $2
         GROUP BY t ORDER BY t`, args,
    )).rows.map((r: any) => ({ t: r.t, label: 'total', v: r.v }))
  } else if (opts.slice === 'group') {
    groupKey = 'group_name'
    series = (await query(
      `SELECT date_trunc('${trunc}', rl.created_at) AS t, g.name AS label, COUNT(*)::int AS v
         FROM request_logs rl
         JOIN clients c ON c.id = rl.client_id
         JOIN account_groups g ON g.id = c.group_id
        WHERE rl.created_at >= $1 AND rl.created_at < $2
        GROUP BY t, g.name ORDER BY t`, args,
    )).rows
  } else if (opts.slice === 'account') {
    series = (await query(
      `SELECT date_trunc('${trunc}', rl.created_at) AS t,
              COALESCE(oa.name, '(none)') AS label, COUNT(*)::int AS v
         FROM request_logs rl
         LEFT JOIN oauth_accounts oa ON oa.id = rl.oauth_account_id
        WHERE rl.created_at >= $1 AND rl.created_at < $2
        GROUP BY t, label ORDER BY t`, args,
    )).rows
  } else if (opts.slice === 'user') {
    series = (await query(
      `SELECT date_trunc('${trunc}', rl.created_at) AS t,
              COALESCE(u.email, '(unknown)') AS label, COUNT(*)::int AS v
         FROM request_logs rl
         JOIN clients c ON c.id = rl.client_id
         LEFT JOIN users u ON u.id = c.user_id
        WHERE rl.created_at >= $1 AND rl.created_at < $2
        GROUP BY t, label ORDER BY t`, args,
    )).rows
  } else if (opts.slice === 'model') {
    series = (await query(
      `SELECT date_trunc('${trunc}', created_at) AS t,
              COALESCE(request_model, 'unknown') AS label, COUNT(*)::int AS v
         FROM request_logs WHERE created_at >= $1 AND created_at < $2
         GROUP BY t, label ORDER BY t`, args,
    )).rows
  }

  const [topUsers, topModels, topClients, topBlocks] = await Promise.all([
    query(
      `SELECT COALESCE(u.email, '(unknown)') AS label, COUNT(*)::int AS v
         FROM request_logs rl JOIN clients c ON c.id=rl.client_id
         LEFT JOIN users u ON u.id=c.user_id
        WHERE rl.created_at >= $1 AND rl.created_at < $2
        GROUP BY label ORDER BY v DESC LIMIT 10`, args),
    query(
      `SELECT COALESCE(request_model, 'unknown') AS label, COUNT(*)::int AS v
         FROM request_logs WHERE created_at >= $1 AND created_at < $2
         GROUP BY label ORDER BY v DESC LIMIT 10`, args),
    query(
      `SELECT c.name AS label, COUNT(*)::int AS v
         FROM request_logs rl JOIN clients c ON c.id=rl.client_id
        WHERE rl.created_at >= $1 AND rl.created_at < $2
        GROUP BY label ORDER BY v DESC LIMIT 10`, args),
    query(
      `SELECT block_reason AS label, COUNT(*)::int AS v
         FROM request_logs WHERE created_at >= $1 AND created_at < $2
           AND block_reason IS NOT NULL
         GROUP BY label ORDER BY v DESC LIMIT 10`, args),
  ])

  return {
    kpis: {
      total: kpis.total,
      successRate: kpis.total === 0 ? 1 : kpis.ok / kpis.total,
      blocked: kpis.blocked,
      activeAccounts: kpis.active_accounts,
      activeUsers: kpis.active_users,
      totalTokens: Number(kpis.total_tokens),
    },
    series,
    top: {
      users: topUsers.rows,
      models: topModels.rows,
      clients: topClients.rows,
      blocks: topBlocks.rows,
    },
    groupKey,
  }
}

const router = Router()
router.get('/overview', requireAdmin, async (req, res) => {
  const slice = (req.query.slice ?? 'time') as Slice
  const granularity = req.query.granularity === 'hour' ? 'hour' : 'day'
  const since = req.query.since ? new Date(String(req.query.since)) : new Date(Date.now() - 7 * 86400_000)
  const until = req.query.until ? new Date(String(req.query.until)) : new Date()
  res.json(await loadOverview({ slice, granularity, since, until }))
})
export default router
```

挂到 `server/src/index.ts`: `app.use('/api/admin', adminOverviewRouter)`.

- [ ] **Step 3**: 冒烟测试

```typescript
// tests/admin-overview.test.ts
import { strict as assert } from 'assert'
import { loadOverview } from '../server/src/routes/admin-overview.js'
async function main() {
  const r = await loadOverview({ slice: 'model', granularity: 'day', since: new Date(Date.now()-7*86400_000), until: new Date() })
  assert.ok(typeof r.kpis.total === 'number')
  assert.ok(Array.isArray(r.series))
  console.log('OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
```

```bash
npx tsx tests/admin-overview.test.ts
```

- [ ] **Step 4**: 提交

```bash
git add server/src/routes/admin-overview.ts server/src/index.ts tests/admin-overview.test.ts
git commit -m "feat(admin): /api/admin/overview with 5-slice aggregator"
```

---

## Task 2: 前端页面

**Files:**
- Create: 4 files under `web/src/pages/admin/_dashboard/` + `AdminDashboardPage.tsx`

- [ ] **Step 1**: KpiBar

```tsx
// web/src/pages/admin/_dashboard/KpiBar.tsx
import { StatGrid } from '../../../ui'
type Kpis = { total: number; successRate: number; blocked: number; activeAccounts: number; activeUsers: number; totalTokens: number }
export default function KpiBar({ kpis }: { kpis: Kpis }) {
  return <StatGrid items={[
    { label: '总请求', value: kpis.total.toLocaleString() },
    { label: '成功率', value: (kpis.successRate * 100).toFixed(1) + '%' },
    { label: '被拦截', value: kpis.blocked.toLocaleString() },
    { label: '活跃账号', value: kpis.activeAccounts.toLocaleString() },
    { label: '活跃用户', value: kpis.activeUsers.toLocaleString() },
    { label: '总 Token', value: kpis.totalTokens.toLocaleString() },
  ]} />
}
```

- [ ] **Step 2**: SliceChart

```tsx
// web/src/pages/admin/_dashboard/SliceChart.tsx
import { useMemo } from 'react'
import { MultiLine } from '../../../ui/chart/MultiLine'

const PALETTE = [
  'var(--accent)', 'var(--info)', 'var(--ok)', 'var(--warn)',
  '#6b56a8', '#2a8585', '#b7663a', '#5a7a2d',
  '#8a5757', '#3d6ea3', '#a98c3a', '#6e4a8a',
]

function colorFor(label: string): string {
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) | 0
  return PALETTE[Math.abs(h) % PALETTE.length]
}

export default function SliceChart({ series }: { series: Array<{ t: string; label: string; v: number }> }) {
  const { labels, lines } = useMemo(() => {
    const tSet = new Set(series.map((s) => s.t))
    const labels = [...tSet].sort()
    const byLabel = new Map<string, Map<string, number>>()
    for (const s of series) {
      if (!byLabel.has(s.label)) byLabel.set(s.label, new Map())
      byLabel.get(s.label)!.set(s.t, s.v)
    }
    const lines = [...byLabel.entries()].map(([label, m]) => ({
      name: label, color: colorFor(label),
      data: labels.map((t) => m.get(t) ?? 0),
    }))
    return { labels, lines }
  }, [series])

  if (labels.length === 0) return <div className="text-[13px] text-[var(--mute)]">暂无数据</div>
  return <MultiLine labels={labels.map((t) => String(t).slice(5, 16))} lines={lines} height={260} />
}
```

- [ ] **Step 3**: TopLists

```tsx
// web/src/pages/admin/_dashboard/TopLists.tsx
import { Bars } from '../../../ui/chart/Bars'
type Top = { label: string; v: number }
export default function TopLists({ top }: { top: { users: Top[]; models: Top[]; clients: Top[]; blocks: Top[] } }) {
  return (
    <div className="grid md:grid-cols-2 gap-6">
      <div><h3 className="text-[13px] font-medium mb-2">Top 用户</h3><Bars data={top.users.map(x => ({ label: x.label, value: x.v }))} /></div>
      <div><h3 className="text-[13px] font-medium mb-2">Top 模型</h3><Bars data={top.models.map(x => ({ label: x.label, value: x.v }))} /></div>
      <div><h3 className="text-[13px] font-medium mb-2">Top 客户端</h3><Bars data={top.clients.map(x => ({ label: x.label, value: x.v }))} /></div>
      <div><h3 className="text-[13px] font-medium mb-2">Top 拦截原因</h3><Bars data={top.blocks.map(x => ({ label: x.label, value: x.v }))} /></div>
    </div>
  )
}
```

- [ ] **Step 4**: 页面

```tsx
// web/src/pages/admin/AdminDashboardPage.tsx
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Segmented } from '../../ui'
import KpiBar from './_dashboard/KpiBar'
import SliceChart from './_dashboard/SliceChart'
import TopLists from './_dashboard/TopLists'

const SLICES = [
  { value: 'time', label: '时间' },
  { value: 'group', label: '账号组' },
  { value: 'account', label: 'OAuth 账号' },
  { value: 'user', label: '用户' },
  { value: 'model', label: '模型' },
]

export default function AdminDashboardPage() {
  const [slice, setSlice] = useState('time')
  const [granularity, setGranularity] = useState<'day' | 'hour'>('day')
  const [data, setData] = useState<any>(null)

  useEffect(() => {
    api(`/admin/overview?slice=${slice}&granularity=${granularity}`).then(setData)
  }, [slice, granularity])

  if (!data) return <div className="text-[13px] text-[var(--mute)]">Loading…</div>

  return (
    <div className="max-w-[1200px] space-y-8">
      <header>
        <h1 className="text-[26px] font-serif">总览</h1>
        <p className="text-[13px] text-[var(--mute)] mt-1">系统整体健康 · 近 7 天</p>
      </header>

      <KpiBar kpis={data.kpis} />

      <section>
        <div className="flex items-center justify-between mb-3">
          <Segmented value={slice} options={SLICES} onChange={setSlice as any} />
          <Segmented value={granularity} options={[{ value: 'day', label: '按天' }, { value: 'hour', label: '按小时' }]} onChange={setGranularity as any} />
        </div>
        <SliceChart series={data.series} />
      </section>

      <TopLists top={data.top} />
    </div>
  )
}
```

- [ ] **Step 5**: 路由挂真实页

```tsx
import AdminDashboardPage from './pages/admin/AdminDashboardPage'
<Route path="/admin" element={<AdminDashboardPage />} />
```

- [ ] **Step 6**: 提交

```bash
git add web/src/pages/admin/AdminDashboardPage.tsx web/src/pages/admin/_dashboard web/src/router.tsx
git commit -m "feat(admin): admin dashboard with 5-slice chart + KPIs + top lists"
```

---

## Task 3: 部署 + 合并

- [ ] 部署 `./scripts/deploy-gwbk.sh`，访问 `/admin`
- [ ] 切换每一个 slice，验证线图颜色稳定
- [ ] merge

```bash
git fetch origin main && git rebase origin/main
git checkout main && git merge --no-ff feat/admin-dashboard -m "merge: feat/admin-dashboard"
git push origin main
```
