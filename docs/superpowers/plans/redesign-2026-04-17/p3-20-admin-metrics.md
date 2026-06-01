# Admin Metrics Implementation Plan — `feat/admin-metrics`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/admin/metrics` 新页：SLO 指标面板 — P50/P95 延迟、首 token 时间、错误率、按模型细分、按账号细分、按拦截原因的堆叠条；可切换 1h / 24h / 7d 窗口。

**Architecture:**
- 后端 `/api/admin/metrics?window=1h|24h|7d`：返回 `{ latency: {p50,p95,byModel}, firstToken: {p50,p95,byModel}, errorRate: {gw, up, byReason}, volume: {byModel, byAccount} }`。
- 前端 `web/src/pages/admin/AdminMetricsPage.tsx`。

**Tech Stack:** React 19 + `@/ui` + Express + PostgreSQL.

---

## 约束

1. P50 / P95 用 PostgreSQL `percentile_cont`；窗口内样本 < 50 时 P95 返回 null 标记"样本不足"。
2. 只看成功 2xx 请求的延迟；拦截的不纳入 latency。
3. 禁 emoji、禁渐变色、禁 PR。

---

## 文件结构

**Create:**
- `server/src/routes/admin-metrics.ts`
- `web/src/pages/admin/AdminMetricsPage.tsx`
- `tests/admin-metrics.test.ts`

**Modify:**
- `server/src/index.ts`
- `web/src/router.tsx`

---

## Task 1: 后端 percentile

- [ ] **Step 1**:

```bash
cd /path/to/cc-gateway
git checkout main && git pull && git checkout -b feat/admin-metrics
```

- [ ] **Step 2**: 写 loader

```typescript
// server/src/routes/admin-metrics.ts
import { Router } from 'express'
import { requireAdmin } from '../middleware/auth'
import { query } from '../db'

const WINDOW_SQL: Record<string, string> = {
  '1h':  `now() - INTERVAL '1 hour'`,
  '24h': `now() - INTERVAL '24 hours'`,
  '7d':  `now() - INTERVAL '7 days'`,
}

export async function loadMetrics(windowKey: keyof typeof WINDOW_SQL) {
  const since = WINDOW_SQL[windowKey] ?? WINDOW_SQL['24h']

  const [latency, firstToken, errorRate, volume] = await Promise.all([
    query(
      `WITH s AS (
         SELECT latency_ms, COALESCE(request_model,'unknown') AS m
           FROM request_logs
          WHERE created_at >= ${since}
            AND block_reason IS NULL
            AND response_status BETWEEN 200 AND 299
            AND latency_ms IS NOT NULL
       )
       SELECT
         percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_ms) AS p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
         COUNT(*)::int AS n
       FROM s`
    ),
    query(
      `WITH s AS (
         SELECT first_token_ms, COALESCE(request_model,'unknown') AS m
           FROM request_logs
          WHERE created_at >= ${since}
            AND streaming = true
            AND first_token_ms IS NOT NULL
       )
       SELECT
         percentile_cont(0.5)  WITHIN GROUP (ORDER BY first_token_ms) AS p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY first_token_ms) AS p95,
         COUNT(*)::int AS n
       FROM s`
    ),
    query(
      `SELECT
         COUNT(*) FILTER (WHERE block_source = 'gw')::int AS gw,
         COUNT(*) FILTER (WHERE block_source = 'up')::int AS up,
         COUNT(*) FILTER (WHERE block_reason IS NULL AND response_status BETWEEN 200 AND 299)::int AS ok,
         COUNT(*)::int AS total,
         ARRAY(
           SELECT jsonb_build_object('reason', reason, 'n', n)
             FROM (SELECT block_reason AS reason, COUNT(*)::int AS n
                     FROM request_logs WHERE created_at >= ${since} AND block_reason IS NOT NULL
                     GROUP BY 1 ORDER BY 2 DESC LIMIT 12) t
         ) AS by_reason
       FROM request_logs WHERE created_at >= ${since}`
    ),
    query(
      `SELECT
         COALESCE(request_model,'unknown') AS model,
         COUNT(*)::int AS n
       FROM request_logs WHERE created_at >= ${since}
       GROUP BY 1 ORDER BY 2 DESC LIMIT 12`
    ),
  ])

  function safe(row: any, field: 'p50' | 'p95') {
    if (row.n < 50) return null
    return Math.round(Number(row[field]) || 0)
  }
  const L = latency.rows[0]
  const F = firstToken.rows[0]
  const E = errorRate.rows[0]

  return {
    window: windowKey,
    latency: { p50: safe(L, 'p50'), p95: safe(L, 'p95'), n: L.n },
    firstToken: { p50: safe(F, 'p50'), p95: safe(F, 'p95'), n: F.n },
    errorRate: {
      gw: E.gw, up: E.up, ok: E.ok, total: E.total,
      byReason: E.by_reason ?? [],
    },
    volume: volume.rows,
  }
}

const router = Router()
router.get('/metrics', requireAdmin, async (req, res) => {
  const w = (String(req.query.window || '24h')) as keyof typeof WINDOW_SQL
  res.json(await loadMetrics(w))
})
export default router
```

挂到 `server/src/index.ts`: `app.use('/api/admin', metricsRouter)`.

- [ ] **Step 3**: 冒烟测试

```typescript
// tests/admin-metrics.test.ts
import { strict as assert } from 'assert'
import { loadMetrics } from '../server/src/routes/admin-metrics.js'
async function main() {
  const r = await loadMetrics('24h')
  assert.ok(r.latency)
  assert.ok(Array.isArray(r.errorRate.byReason))
  console.log('OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
```

```bash
npx tsx tests/admin-metrics.test.ts
```

- [ ] **Step 4**: 提交

```bash
git add server/src/routes/admin-metrics.ts server/src/index.ts tests/admin-metrics.test.ts
git commit -m "feat(admin-metrics): /api/admin/metrics with percentile + byReason"
```

---

## Task 2: 前端页面

- [ ] **Step 1**:

```tsx
// web/src/pages/admin/AdminMetricsPage.tsx
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Segmented, StatGrid, Pill } from '../../ui'
import { Bars } from '../../ui/chart/Bars'

function ms(v: number | null) { return v == null ? '样本不足' : `${v} ms` }

export default function AdminMetricsPage() {
  const [w, setW] = useState<'1h' | '24h' | '7d'>('24h')
  const [d, setD] = useState<any>(null)
  useEffect(() => { api(`/admin/metrics?window=${w}`).then(setD) }, [w])
  if (!d) return <div className="text-[13px] text-[var(--mute)]">Loading…</div>

  const errTotal = d.errorRate.total
  const errPct = errTotal === 0 ? '0%' : `${(((errTotal - d.errorRate.ok) / errTotal) * 100).toFixed(2)}%`

  return (
    <div className="max-w-[1200px] space-y-6">
      <header>
        <h1 className="text-[26px] font-serif">指标</h1>
        <p className="text-[13px] text-[var(--mute)] mt-1">延迟 / 首 token / 错误分布</p>
      </header>

      <Segmented value={w} onChange={setW as any} options={[
        { value: '1h', label: '近 1h' },
        { value: '24h', label: '近 24h' },
        { value: '7d', label: '近 7d' },
      ]} />

      <StatGrid items={[
        { label: `延迟 P50 (n=${d.latency.n})`, value: ms(d.latency.p50) },
        { label: `延迟 P95`,                  value: ms(d.latency.p95) },
        { label: `首 token P50 (n=${d.firstToken.n})`, value: ms(d.firstToken.p50) },
        { label: `首 token P95`,              value: ms(d.firstToken.p95) },
        { label: `总请求`,                    value: errTotal.toLocaleString() },
        { label: `错误率`,                    value: errPct },
      ]} />

      <section className="grid md:grid-cols-2 gap-6">
        <div>
          <h3 className="text-[13px] font-medium mb-2">按模型请求量</h3>
          <Bars data={d.volume.map((v: any) => ({ label: v.model, value: v.n }))} />
        </div>
        <div>
          <h3 className="text-[13px] font-medium mb-2">拦截原因分布</h3>
          <Bars data={(d.errorRate.byReason || []).map((r: any) => ({ label: r.reason, value: r.n }))} />
        </div>
      </section>

      <section className="flex gap-3">
        <Pill tone="warn">网关拦截 {d.errorRate.gw.toLocaleString()}</Pill>
        <Pill tone="err">上游错误 {d.errorRate.up.toLocaleString()}</Pill>
        <Pill tone="ok">成功 {d.errorRate.ok.toLocaleString()}</Pill>
      </section>
    </div>
  )
}
```

- [ ] **Step 2**: 路由

```tsx
import AdminMetricsPage from './pages/admin/AdminMetricsPage'
<Route path="/admin/metrics" element={<AdminMetricsPage />} />
```

- [ ] **Step 3**: 提交

```bash
git add web/src/pages/admin/AdminMetricsPage.tsx web/src/router.tsx
git commit -m "feat(admin-metrics): metrics page with percentile KPIs + distribution bars"
```

---

## Task 3: 部署 + 合并

- [ ] 部署，打开 `/admin/metrics` 观察三种窗口
- [ ] 人为触发若干限流 / plan 拦截 / 上游 429，刷新 1h 视图看比例
- [ ] merge

```bash
git fetch origin main && git rebase origin/main
git checkout main && git merge --no-ff feat/admin-metrics -m "merge: feat/admin-metrics"
git push origin main
```
