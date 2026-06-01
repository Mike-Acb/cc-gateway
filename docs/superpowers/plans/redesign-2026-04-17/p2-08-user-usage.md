# User Usage Implementation Plan — `feat/user-usage`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/usage` 页：时间粒度切换（日/小时）+ 客户端+模型双维堆叠柱状图 + 明细表（按小时/按日聚合）+ CSV 导出。

**Architecture:**
- 后端 `GET /api/me/usage?granularity=hour|day&since=&until=&client_id=&model=`，返回 `{ buckets: [{ t, client_id, client_name, model, count, tokens, blocked }] }`。
- 前端 `web/src/pages/usage/UsagePage.tsx`（替换 stub）。
- 使用 `StackedBars` 图表 + `FilterBar` 过滤 + `Table` 展示。
- CSV 导出在前端用 Blob 拼接。

**Tech Stack:** React 19 + `@/ui` + Express + PostgreSQL。

---

## 约束

1. 时间默认窗口：最近 24h（granularity=hour）或 最近 30 天（granularity=day）。
2. 图表颜色按 model 映射 — `claude-opus-* → accent`，`claude-sonnet-* → info`，`claude-haiku-* → ok`，其他 → `mute`。
3. 明细表分页，每页 50 行。
4. 禁 emoji、禁渐变色、禁 PR。

---

## 文件结构

**Create:**
- `server/src/routes/usage-me.ts`
- `web/src/pages/usage/UsagePage.tsx`
- `tests/me-usage.test.ts`

**Modify:**
- `server/src/index.ts` — 挂 `/api/me/usage`
- `web/src/router.tsx` — 接真实页

---

## Task 1: 切分支 + 后端查询

- [ ] **Step 1**:

```bash
cd /path/to/cc-gateway
git checkout main && git pull && git checkout -b feat/user-usage
```

- [ ] **Step 2**: 失败测试

```typescript
// tests/me-usage.test.ts
import { strict as assert } from 'assert'
import { loadUsage } from '../server/src/routes/usage-me.js'

async function main() {
  const r = await loadUsage({
    userId: '00000000-0000-0000-0000-000000000000',
    granularity: 'day',
    since: new Date(Date.now() - 7 * 86400_000),
    until: new Date(),
  })
  assert.ok(Array.isArray(r.buckets))
  console.log('OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 3**: 写 loader

```typescript
// server/src/routes/usage-me.ts
import { Router } from 'express'
import { requireUser } from '../middleware/auth'
import { query } from '../db'

export type UsageBucket = {
  t: string
  client_id: string
  client_name: string
  model: string
  count: number
  tokens: number
  blocked: number
}

export async function loadUsage(opts: {
  userId: string
  granularity: 'hour' | 'day'
  since: Date
  until: Date
  clientId?: string
  model?: string
}): Promise<{ buckets: UsageBucket[] }> {
  const trunc = opts.granularity === 'hour' ? 'hour' : 'day'
  const args: unknown[] = [opts.userId, opts.since.toISOString(), opts.until.toISOString()]
  let extra = ''
  if (opts.clientId) { args.push(opts.clientId); extra += ` AND rl.client_id = $${args.length}` }
  if (opts.model)    { args.push(opts.model);    extra += ` AND rl.request_model = $${args.length}` }

  const { rows } = await query(
    `SELECT
       date_trunc('${trunc}', rl.created_at) AS t,
       rl.client_id::text AS client_id,
       c.name AS client_name,
       COALESCE(rl.request_model, 'unknown') AS model,
       COUNT(*)::int AS count,
       COALESCE(SUM(ur.total_tokens),0)::int AS tokens,
       COUNT(*) FILTER (WHERE rl.block_reason IS NOT NULL)::int AS blocked
     FROM request_logs rl
     JOIN clients c ON c.id = rl.client_id
     LEFT JOIN usage_records ur ON ur.trace_id = rl.trace_id
     WHERE c.user_id = $1 AND rl.created_at >= $2 AND rl.created_at < $3
     ${extra}
     GROUP BY t, rl.client_id, c.name, COALESCE(rl.request_model,'unknown')
     ORDER BY t, client_name, model`,
    args,
  )
  return { buckets: rows.map((r: any) => ({ ...r, t: r.t.toISOString ? r.t.toISOString() : r.t })) }
}

const router = Router()
router.get('/usage', requireUser, async (req, res) => {
  const userId = (req as any).user.id
  const granularity = (req.query.granularity === 'hour' ? 'hour' : 'day') as 'hour' | 'day'
  const since = req.query.since ? new Date(String(req.query.since)) : new Date(Date.now() - (granularity === 'hour' ? 86400_000 : 30 * 86400_000))
  const until = req.query.until ? new Date(String(req.query.until)) : new Date()
  const clientId = req.query.client_id ? String(req.query.client_id) : undefined
  const model = req.query.model ? String(req.query.model) : undefined
  res.json(await loadUsage({ userId, granularity, since, until, clientId, model }))
})
export default router
```

```typescript
// server/src/index.ts — 合并到已有 /api/me
import usageMeRouter from './routes/usage-me'
app.use('/api/me', usageMeRouter)
```

- [ ] **Step 4**: 跑测试

```bash
npx tsx tests/me-usage.test.ts
```

Expected: `OK`.

- [ ] **Step 5**: 提交

```bash
git add server/src/routes/usage-me.ts server/src/index.ts tests/me-usage.test.ts
git commit -m "feat(usage): /api/me/usage with granularity + filters"
```

---

## Task 2: 前端页面

**Files:**
- Create: `web/src/pages/usage/UsagePage.tsx`
- Modify: `web/src/router.tsx`

- [ ] **Step 1**: 写页面

```tsx
// web/src/pages/usage/UsagePage.tsx
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api/client'
import { FilterBar, Segmented, Field, Select, Button, Table } from '../../ui'
import { StackedBars } from '../../ui/chart/StackedBars'

type Bucket = {
  t: string; client_id: string; client_name: string; model: string
  count: number; tokens: number; blocked: number
}

const MODEL_TONE: Record<string, string> = {
  opus: 'var(--accent)',
  sonnet: 'var(--info)',
  haiku: 'var(--ok)',
  other: 'var(--mute)',
}

function toneFor(model: string): string {
  if (model.includes('opus')) return MODEL_TONE.opus
  if (model.includes('sonnet')) return MODEL_TONE.sonnet
  if (model.includes('haiku')) return MODEL_TONE.haiku
  return MODEL_TONE.other
}

export default function UsagePage() {
  const [granularity, setGranularity] = useState<'hour' | 'day'>('day')
  const [clientId, setClientId] = useState('')
  const [model, setModel] = useState('')
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [clients, setClients] = useState<{ id: string; name: string }[]>([])

  useEffect(() => {
    api('/me/clients').then((r) => setClients(r.items ?? r ?? []))
  }, [])

  useEffect(() => {
    const qs = new URLSearchParams({ granularity, ...(clientId ? { client_id: clientId } : {}), ...(model ? { model } : {}) })
    api(`/me/usage?${qs}`).then((r) => setBuckets(r.buckets))
  }, [granularity, clientId, model])

  const stacked = useMemo(() => {
    const byTime = new Map<string, Record<string, number>>()
    const models = new Set<string>()
    for (const b of buckets) {
      models.add(b.model)
      const m = byTime.get(b.t) ?? {}
      m[b.model] = (m[b.model] ?? 0) + b.count
      byTime.set(b.t, m)
    }
    const labels = [...byTime.keys()].sort()
    const series = [...models].map((m) => ({
      name: m, color: toneFor(m), data: labels.map((t) => byTime.get(t)?.[m] ?? 0),
    }))
    return { labels, series }
  }, [buckets])

  function exportCsv() {
    const header = 't,client,model,count,tokens,blocked'
    const rows = buckets.map((b) => `${b.t},${b.client_name},${b.model},${b.count},${b.tokens},${b.blocked}`)
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `usage-${granularity}-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="max-w-[1040px] space-y-6">
      <header>
        <h1 className="text-[26px] font-serif">用量</h1>
        <p className="text-[13px] text-[var(--mute)] mt-1">按时间粒度查看请求与 Token</p>
      </header>

      <FilterBar>
        <Segmented
          value={granularity}
          options={[{ value: 'day', label: '按天' }, { value: 'hour', label: '按小时' }]}
          onChange={(v) => setGranularity(v as 'day' | 'hour')}
        />
        <Field label="客户端">
          <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">全部</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="模型">
          <Select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">全部</option>
            <option value="claude-opus-4-7">Opus 4.7</option>
            <option value="claude-sonnet-4-6">Sonnet 4.6</option>
            <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
          </Select>
        </Field>
        <Button variant="ghost" onClick={exportCsv}>导出 CSV</Button>
      </FilterBar>

      <section>
        <StackedBars labels={stacked.labels.map((t) => t.slice(5, 16))} series={stacked.series} height={220} />
      </section>

      <section>
        <h2 className="text-[14px] font-medium mb-2">明细</h2>
        <Table
          columns={[
            { key: 't', label: '时间', render: (r) => new Date(r.t).toLocaleString() },
            { key: 'client_name', label: '客户端' },
            { key: 'model', label: '模型' },
            { key: 'count', label: '请求' },
            { key: 'tokens', label: 'Token' },
            { key: 'blocked', label: '拦截' },
          ]}
          rows={buckets}
          empty="该时间段没有数据。"
        />
      </section>
    </div>
  )
}
```

- [ ] **Step 2**: 接路由

```tsx
import UsagePage from './pages/usage/UsagePage'
<Route path="/usage" element={<UsagePage />} />
```

- [ ] **Step 3**: 提交

```bash
git add web/src/pages/usage/UsagePage.tsx web/src/router.tsx
git commit -m "feat(usage): user usage page with stacked bars + CSV"
```

---

## Task 3: 部署 + 合并

- [ ] **Step 1**: `./scripts/deploy-gwbk.sh`
- [ ] **Step 2**: 访问 `/usage`，验证粒度切换、过滤、CSV
- [ ] **Step 3**: 合并

```bash
git fetch origin main && git rebase origin/main
git checkout main && git merge --no-ff feat/user-usage -m "merge: feat/user-usage"
git push origin main
```
