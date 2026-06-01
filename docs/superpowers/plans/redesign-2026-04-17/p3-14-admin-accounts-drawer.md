# Admin Accounts Drawer Implementation Plan — `feat/admin-accounts-drawer`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/admin/accounts` 页：账号池表格 + 右侧 Drawer 展示单个账号详情（调度统计、错误分布、最近 24h 时序、分组切换、启/禁用、重置 token）。

**Architecture:**
- 后端：`/api/admin/accounts` 已有，本分支扩展返回字段（group_id, 近 24h 请求数 / 成功率 / 限流计数）；新增 `/api/admin/accounts/:id` detail endpoint。
- 前端：`web/src/pages/admin/AdminAccountsPage.tsx`（已有，重写）+ 新 `AccountDrawer.tsx`。
- Drawer 基于 `@/ui/Drawer`（p1-02）。
- 切换 group 调用 `/api/admin/groups/accounts/:id`（p1-05）。

**Tech Stack:** React 19 + `@/ui` + Express + PostgreSQL。

---

## 约束

1. 列表一次拉 200 条（按 created_at 分页），Drawer 懒加载 detail。
2. 切换 group 后即时刷新列表。
3. reset_token / enable / disable / delete 均走 audit（p1-06）。这个分支不需要再写 audit 代码，但要验证埋点已生效。
4. 禁 emoji、禁渐变色、禁 PR。

---

## 文件结构

**Create:**
- `web/src/pages/admin/_accounts/AccountDrawer.tsx`
- `tests/admin-accounts-detail.test.ts`

**Modify:**
- `server/src/routes/admin.ts` — list 多返回字段 + 新 GET /accounts/:id
- `web/src/pages/admin/AdminAccountsPage.tsx` — 整页重写

---

## Task 1: 后端扩展

- [ ] **Step 1**:

```bash
cd /path/to/cc-gateway
git checkout main && git pull && git checkout -b feat/admin-accounts-drawer
```

- [ ] **Step 2**: 找 list handler，扩展 SELECT

在 `server/src/routes/admin.ts` 的 `GET /accounts` 改为：

```sql
WITH stats AS (
  SELECT oauth_account_id,
         COUNT(*)::int AS req_24h,
         COUNT(*) FILTER (WHERE response_status BETWEEN 200 AND 299)::int AS ok_24h,
         COUNT(*) FILTER (WHERE block_reason = 'rate_limited' OR block_reason = 'upstream_429')::int AS limited_24h
    FROM request_logs
   WHERE created_at > now() - INTERVAL '24 hours'
   GROUP BY oauth_account_id
)
SELECT oa.id, oa.name, oa.enabled, oa.group_id, g.name AS group_name,
       oa.created_at, oa.updated_at,
       COALESCE(s.req_24h, 0) AS req_24h,
       COALESCE(s.ok_24h, 0)  AS ok_24h,
       COALESCE(s.limited_24h, 0) AS limited_24h
  FROM oauth_accounts oa
  LEFT JOIN account_groups g ON g.id = oa.group_id
  LEFT JOIN stats s ON s.oauth_account_id = oa.id
ORDER BY oa.created_at DESC
LIMIT 200
```

- [ ] **Step 3**: 新 detail endpoint

```typescript
router.get('/accounts/:id', requireAdmin, async (req, res) => {
  const id = req.params.id
  const base = await query(`SELECT oa.*, g.name AS group_name FROM oauth_accounts oa LEFT JOIN account_groups g ON g.id=oa.group_id WHERE oa.id=$1`, [id])
  if (base.rows.length === 0) return res.status(404).json({ error: 'not found' })
  const [trend, errors] = await Promise.all([
    query(
      `SELECT date_trunc('hour', created_at) AS t, COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE block_reason IS NOT NULL)::int AS blocked
         FROM request_logs WHERE oauth_account_id=$1 AND created_at > now() - INTERVAL '24 hours'
         GROUP BY t ORDER BY t`, [id]),
    query(
      `SELECT COALESCE(block_reason,'other_5xx') AS reason, COUNT(*)::int AS n
         FROM request_logs WHERE oauth_account_id=$1 AND created_at > now() - INTERVAL '24 hours'
           AND (block_reason IS NOT NULL OR response_status >= 500)
         GROUP BY 1 ORDER BY 2 DESC`, [id]),
  ])
  const row = base.rows[0]
  delete row.access_token
  delete row.refresh_token
  res.json({ account: row, trend: trend.rows, errors: errors.rows })
})
```

- [ ] **Step 4**: 冒烟测试

```typescript
// tests/admin-accounts-detail.test.ts
import { strict as assert } from 'assert'
import { query } from '../src/db.js'
async function main() {
  const { rows } = await query(`SELECT id FROM oauth_accounts LIMIT 1`)
  if (rows.length === 0) { console.log('SKIP (no accounts)'); process.exit(0) }
  // 只校验 schema 字段存在
  const detail = await query(`SELECT oa.id, oa.name, oa.enabled, oa.group_id FROM oauth_accounts oa WHERE oa.id=$1`, [rows[0].id])
  assert.ok(detail.rows[0].name !== undefined)
  console.log('OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
```

```bash
npx tsx tests/admin-accounts-detail.test.ts
```

- [ ] **Step 5**: 提交

```bash
git add server/src/routes/admin.ts tests/admin-accounts-detail.test.ts
git commit -m "feat(admin-accounts): list includes 24h stats + detail endpoint"
```

---

## Task 2: Drawer 组件

**Files:** Create `web/src/pages/admin/_accounts/AccountDrawer.tsx`

- [ ] **Step 1**: 写

```tsx
// web/src/pages/admin/_accounts/AccountDrawer.tsx
import { useEffect, useState } from 'react'
import { api } from '../../../api/client'
import { Drawer, Segmented, Button, Pill, Select, Field } from '../../../ui'
import { Bars } from '../../../ui/chart/Bars'
import { SparkLine } from '../../../ui/chart/SparkLine'

type Group = { id: string; name: string }

export default function AccountDrawer({
  accountId, groups, onClose, onChange,
}: { accountId: string; groups: Group[]; onClose: () => void; onChange: () => void }) {
  const [detail, setDetail] = useState<any>(null)

  async function load() {
    const r = await api(`/admin/accounts/${accountId}`)
    setDetail(r)
  }
  useEffect(() => { load() }, [accountId])

  if (!detail) return <Drawer onClose={onClose}><div className="text-[13px] text-[var(--mute)]">Loading…</div></Drawer>

  const a = detail.account

  async function toggleEnabled() {
    await api(`/admin/accounts/${accountId}/${a.enabled ? 'disable' : 'enable'}`, { method: 'POST' })
    await load(); onChange()
  }
  async function resetToken() {
    if (!confirm('重置 OAuth token 会强制重新登录该账号。继续？')) return
    await api(`/admin/accounts/${accountId}/reset-token`, { method: 'POST' })
    await load(); onChange()
  }
  async function setGroup(groupId: string | null) {
    await api(`/admin/groups/accounts/${accountId}`, { method: 'POST', body: JSON.stringify({ groupId }) })
    await load(); onChange()
  }

  return (
    <Drawer onClose={onClose} title={a.name}>
      <div className="space-y-6">
        <section className="flex items-center gap-3">
          <Pill tone={a.enabled ? 'ok' : 'mute'}>{a.enabled ? '启用' : '已禁用'}</Pill>
          <Pill tone="info">{a.group_name ?? '共享池'}</Pill>
        </section>

        <section>
          <h3 className="text-[13px] font-medium mb-2">24h 趋势</h3>
          <SparkLine
            points={detail.trend.map((t: any) => t.n)}
            labels={detail.trend.map((t: any) => String(t.t).slice(11,13))}
            height={80}
          />
        </section>

        <section>
          <h3 className="text-[13px] font-medium mb-2">24h 错误分布</h3>
          <Bars data={detail.errors.map((e: any) => ({ label: e.reason, value: e.n }))} />
        </section>

        <section>
          <h3 className="text-[13px] font-medium mb-3">调度组</h3>
          <Field label="分组">
            <Select value={a.group_id ?? ''} onChange={(e) => setGroup(e.target.value || null)}>
              <option value="">共享池 (无分组)</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </Select>
          </Field>
        </section>

        <section className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={toggleEnabled}>{a.enabled ? '禁用' : '启用'}</Button>
          <Button variant="ghost" onClick={resetToken}>重置 token</Button>
        </section>
      </div>
    </Drawer>
  )
}
```

- [ ] **Step 2**: 主页面

```tsx
// web/src/pages/admin/AdminAccountsPage.tsx
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Table, Pill, Button, FilterBar, Input, Field } from '../../ui'
import AccountDrawer from './_accounts/AccountDrawer'

export default function AdminAccountsPage() {
  const [items, setItems] = useState<any[]>([])
  const [groups, setGroups] = useState<any[]>([])
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  async function load() {
    const [a, g] = await Promise.all([api('/admin/accounts'), api('/admin/groups')])
    setItems(a.items ?? a)
    setGroups(g.items ?? g)
  }
  useEffect(() => { load() }, [])

  const shown = q ? items.filter((i) => i.name.toLowerCase().includes(q.toLowerCase())) : items

  return (
    <div className="max-w-[1200px] space-y-6">
      <header>
        <h1 className="text-[26px] font-serif">账号池</h1>
        <p className="text-[13px] text-[var(--mute)] mt-1">OAuth 账号调度与健康</p>
      </header>

      <FilterBar>
        <Field label="搜索"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="账号名…" /></Field>
      </FilterBar>

      <Table
        columns={[
          { key: 'name', label: '账号' },
          { key: 'group_name', label: '分组', render: (r) => <Pill tone="info">{r.group_name ?? '共享池'}</Pill> },
          { key: 'enabled', label: '状态', render: (r) => <Pill tone={r.enabled ? 'ok' : 'mute'}>{r.enabled ? '启用' : '禁用'}</Pill> },
          { key: 'req_24h', label: '24h 请求', render: (r) => r.req_24h.toLocaleString() },
          { key: 'success', label: '24h 成功率', render: (r) => r.req_24h === 0 ? '-' : `${((r.ok_24h / r.req_24h) * 100).toFixed(1)}%` },
          { key: 'limited_24h', label: '24h 限流', render: (r) => r.limited_24h > 0 ? <Pill tone="warn">{r.limited_24h}</Pill> : '0' },
          { key: 'action', label: '', render: (r) => <Button variant="ghost" onClick={() => setSelected(r.id)}>查看</Button> },
        ]}
        rows={shown}
        empty="没有账号。"
      />

      {selected && (
        <AccountDrawer accountId={selected} groups={groups} onClose={() => setSelected(null)} onChange={load} />
      )}
    </div>
  )
}
```

- [ ] **Step 3**: 提交

```bash
git add web/src/pages/admin/AdminAccountsPage.tsx web/src/pages/admin/_accounts/AccountDrawer.tsx
git commit -m "feat(admin-accounts): table with drawer + group switch + health stats"
```

---

## Task 3: 部署 + 验证 audit

- [ ] 部署 `./scripts/deploy-gwbk.sh`，访问 `/admin/accounts`
- [ ] 启用/禁用一个账号 → `SELECT * FROM audit_logs WHERE action LIKE 'account.%' ORDER BY created_at DESC LIMIT 5` 应有新记录
- [ ] 切换 group → `action='group.assign_account'` 应有记录
- [ ] merge

```bash
git fetch origin main && git rebase origin/main
git checkout main && git merge --no-ff feat/admin-accounts-drawer -m "merge: feat/admin-accounts-drawer"
git push origin main
```
