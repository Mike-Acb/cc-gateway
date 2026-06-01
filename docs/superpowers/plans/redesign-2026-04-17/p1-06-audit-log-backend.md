# Audit Log Backend Implementation Plan — `feat/audit-log-backend`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `audit_logs` 表 + 统一审计埋点工具，让所有后台管理动作（plan / account / user / group / subscription / campaign / system）都有结构化审计记录。UI 不做。

**Architecture:**
- Migration `016_audit_logs.sql`：表 `audit_logs(id, actor_id, actor_email, action, resource_type, resource_id, before, after, summary, ip, user_agent, created_at)`。
- `server/src/services/audit.ts` — `recordAudit(ctx, { action, resource, before, after, summary })` 工具函数；从 request 抽 actor / ip / ua。
- 把所有 admin 写操作（7 大 namespace，~30 个 action）都 wrap 一层 audit 调用。
- REST `/admin/audit` 查询：按 actor / action / resource / 时间筛选 + 分页。

**Tech Stack:** TypeScript + PostgreSQL + Express + tsx assert-style tests.

---

## 约束

1. **Action 命名空间（7 组，全部小写、点分三段）**：
   - `plan.create|update|delete|assign_user`
   - `account.create|update|enable|disable|delete|reset_token`
   - `group.create|update|delete|assign_account|assign_client`
   - `user.register|ban|unban|grant_role|revoke_role|delete`
   - `subscription.grant|revoke|adjust_balance`
   - `client.create|update|revoke|rotate_key`
   - `system.reload|campaign_create|campaign_update`
2. **Diff 字段可选** — 创建类动作 `before = NULL`；删除类动作 `after = NULL`；update 类动作两者都给。Diff 里 **必须脱敏** `access_token`/`refresh_token`/`api_key`/`password_hash`。
3. **异步/非阻塞** — 审计失败不能阻断业务（catch + log.error），但要在测试里断言至少插入一次。
4. **不碰 UI**。
5. 禁 emoji、禁渐变色、不提 PR。

---

## 文件结构

**Create:**
- `migrations/016_audit_logs.sql`
- `server/src/services/audit.ts`
- `server/src/routes/audit.ts`
- `tests/audit-log.test.ts`

**Modify:**
- `server/src/index.ts` — 挂 `/admin/audit`
- `server/src/routes/admin.ts` — wrap plan/account/user/subscription/system 动作
- `server/src/routes/groups.ts` — wrap group 动作（来自 p1-05）
- `server/src/routes/campaigns.ts` — wrap campaign 动作
- `server/src/routes/clients.ts` — wrap client 动作

---

## Task 1: 切分支 + migration

- [ ] **Step 1: 切分支**

```bash
cd /path/to/cc-gateway
git checkout main && git pull
git checkout -b feat/audit-log-backend
```

- [ ] **Step 2: 写 migration**

```sql
-- migrations/016_audit_logs.sql
BEGIN;

CREATE TABLE IF NOT EXISTS audit_logs (
  id            BIGSERIAL PRIMARY KEY,
  actor_id      UUID,
  actor_email   VARCHAR(255),
  action        VARCHAR(64)  NOT NULL,
  resource_type VARCHAR(32)  NOT NULL,
  resource_id   VARCHAR(128),
  before        JSONB,
  after         JSONB,
  summary       TEXT,
  ip            VARCHAR(45),
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_time       ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor      ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action     ON audit_logs (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource   ON audit_logs (resource_type, resource_id, created_at DESC);

COMMIT;
```

- [ ] **Step 3: 跑**

```bash
psql "$DATABASE_URL" -f migrations/016_audit_logs.sql
```

- [ ] **Step 4: 提交**

```bash
git add migrations/016_audit_logs.sql
git commit -m "feat(audit): add audit_logs table"
```

---

## Task 2: 失败测试

**Files:**
- Create: `tests/audit-log.test.ts`

- [ ] **Step 1: 写测试**

```typescript
// tests/audit-log.test.ts
import { strict as assert } from 'assert'
import { query } from '../src/db.js'
import { recordAudit, sanitize } from '../server/src/services/audit.js'

async function main() {
  // sanitize 脱敏
  const cleaned = sanitize({
    id: '1', access_token: 'secret', refresh_token: 'r', api_key: 'k',
    password_hash: 'p', inner: { api_key: 'nested', ok: true },
  })
  assert.equal(cleaned.access_token, '***')
  assert.equal(cleaned.refresh_token, '***')
  assert.equal(cleaned.api_key, '***')
  assert.equal(cleaned.password_hash, '***')
  assert.equal(cleaned.inner.api_key, '***')
  assert.equal(cleaned.inner.ok, true)

  // recordAudit 插入
  await recordAudit(
    { actor_id: null, actor_email: 'x@x', ip: '1.2.3.4', user_agent: 'ua' },
    {
      action: 'plan.update',
      resource_type: 'plan',
      resource_id: 'abc',
      before: { name: 'old' },
      after: { name: 'new' },
      summary: 'rename test',
    },
  )
  const { rows } = await query(
    `SELECT * FROM audit_logs WHERE resource_id = 'abc' AND action = 'plan.update' ORDER BY id DESC LIMIT 1`,
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].actor_email, 'x@x')
  assert.equal(rows[0].ip, '1.2.3.4')
  assert.equal(rows[0].before.name, 'old')
  assert.equal(rows[0].after.name, 'new')

  console.log('OK')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: 跑应失败**

```bash
npx tsx tests/audit-log.test.ts
```

---

## Task 3: 审计服务

**Files:**
- Create: `server/src/services/audit.ts`

- [ ] **Step 1: 写服务**

```typescript
// server/src/services/audit.ts
import type { Request } from 'express'
import { query } from '../db'
import { log } from '../logger'

const REDACT_KEYS = new Set([
  'access_token', 'refresh_token', 'api_key', 'api_key_hash',
  'password_hash', 'secret', 'verified_token',
])

export function sanitize<T>(value: T): T {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((v) => sanitize(v)) as unknown as T
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k) ? '***' : sanitize(v)
    }
    return out as unknown as T
  }
  return value
}

export type AuditActor = {
  actor_id: string | null
  actor_email: string | null
  ip: string | null
  user_agent: string | null
}

export function actorFromRequest(req: Request): AuditActor {
  const user = (req as any).user
  return {
    actor_id: user?.id ?? null,
    actor_email: user?.email ?? null,
    ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip || null,
    user_agent: (req.headers['user-agent'] as string) || null,
  }
}

export type AuditEntry = {
  action: string
  resource_type: string
  resource_id?: string | null
  before?: unknown
  after?: unknown
  summary?: string | null
}

export async function recordAudit(actor: AuditActor, entry: AuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs
        (actor_id, actor_email, action, resource_type, resource_id, before, after, summary, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        actor.actor_id,
        actor.actor_email,
        entry.action,
        entry.resource_type,
        entry.resource_id ?? null,
        entry.before === undefined ? null : sanitize(entry.before),
        entry.after === undefined ? null : sanitize(entry.after),
        entry.summary ?? null,
        actor.ip,
        actor.user_agent,
      ],
    )
  } catch (err) {
    log('error', `audit insert failed: ${String(err)}`)
  }
}

export async function audit(req: Request, entry: AuditEntry): Promise<void> {
  return recordAudit(actorFromRequest(req), entry)
}
```

- [ ] **Step 2: 跑测试通过**

```bash
npx tsx tests/audit-log.test.ts
```

Expected: `OK`

- [ ] **Step 3: 提交**

```bash
git add server/src/services/audit.ts tests/audit-log.test.ts
git commit -m "feat(audit): audit service with sanitize + Express helper"
```

---

## Task 4: 接入 admin 写操作（plan / account / user / subscription / system）

**Files:**
- Modify: `server/src/routes/admin.ts`

- [ ] **Step 1: 梳理所有需要埋点的 handler**

Run: `Grep` pattern `router\.(post|patch|put|delete)\(` in `server/src/routes/admin.ts`

把结果列出来，对每个 handler 对照 action 命名空间表决定 action id。

- [ ] **Step 2: 在 handler 里埋点**

模板：

```typescript
import { audit } from '../services/audit'

router.patch('/plans/:id', requireAdmin, async (req, res) => {
  const { rows: beforeRows } = await query('SELECT * FROM plans WHERE id = $1', [req.params.id])
  // ... 原有 update 逻辑 ...
  const { rows: afterRows } = await query('SELECT * FROM plans WHERE id = $1', [req.params.id])
  await audit(req, {
    action: 'plan.update',
    resource_type: 'plan',
    resource_id: req.params.id,
    before: beforeRows[0],
    after: afterRows[0],
    summary: `plan ${afterRows[0]?.name} updated`,
  })
  res.json(afterRows[0])
})
```

必须覆盖的 action（在本分支全部处理完）：
- `plan.create` `plan.update` `plan.delete` `plan.assign_user`
- `account.create` `account.update` `account.enable` `account.disable` `account.delete` `account.reset_token`
- `user.ban` `user.unban` `user.grant_role` `user.revoke_role` `user.delete`
- `subscription.grant` `subscription.revoke` `subscription.adjust_balance`
- `system.reload` （若有对应接口；若无则跳过此条）

- [ ] **Step 3: 埋点 client 和 group 相关 action**

在 `server/src/routes/clients.ts`：
- `client.create` `client.update` `client.revoke` `client.rotate_key`

在 `server/src/routes/groups.ts`（p1-05 落地的文件）：
- `group.create` `group.update` `group.delete` `group.assign_account` `group.assign_client`

在 `server/src/routes/campaigns.ts`：
- `system.campaign_create` `system.campaign_update`

在 `server/src/routes/auth.ts` 的注册成功 handler：
- `user.register`（这个 actor_id 可以是新注册用户自己 — 视为系统动作也可）

- [ ] **Step 4: 提交**

```bash
git add server/src/routes/
git commit -m "feat(audit): instrument plan/account/user/subscription/system handlers"
```

---

## Task 5: /admin/audit 查询路由

**Files:**
- Create: `server/src/routes/audit.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: 写路由**

```typescript
// server/src/routes/audit.ts
import { Router } from 'express'
import { requireAdmin } from '../middleware/auth'
import { query } from '../db'

const router = Router()

router.get('/', requireAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const offset = Number(req.query.offset) || 0
  const actor = String(req.query.actor || '').trim()
  const action = String(req.query.action || '').trim()
  const resourceType = String(req.query.resource_type || '').trim()
  const since = req.query.since ? new Date(String(req.query.since)) : null
  const until = req.query.until ? new Date(String(req.query.until)) : null

  const where: string[] = []
  const args: unknown[] = []
  if (actor) {
    args.push(`%${actor}%`)
    where.push(`(actor_email ILIKE $${args.length} OR actor_id::text = $${args.length - 0})`)
  }
  if (action) { args.push(action); where.push(`action = $${args.length}`) }
  if (resourceType) { args.push(resourceType); where.push(`resource_type = $${args.length}`) }
  if (since) { args.push(since.toISOString()); where.push(`created_at >= $${args.length}`) }
  if (until) { args.push(until.toISOString()); where.push(`created_at <= $${args.length}`) }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const { rows } = await query(
    `SELECT id, actor_id, actor_email, action, resource_type, resource_id,
            before, after, summary, ip, created_at
       FROM audit_logs
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
    args,
  )
  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS n FROM audit_logs ${whereSql}`,
    args,
  )
  res.json({ items: rows, total: countRows[0].n, limit, offset })
})

export default router
```

- [ ] **Step 2: 挂路由**

```typescript
// server/src/index.ts
import auditRouter from './routes/audit'
app.use('/api/admin/audit', auditRouter)
```

- [ ] **Step 3: 手测**

```bash
curl -s -H "cookie: access_token=$ADMIN_COOKIE" \
  "http://localhost:3001/api/admin/audit?limit=5&action=plan.update" | jq '.items[] | {action, resource_id, actor_email}'
```

- [ ] **Step 4: 提交**

```bash
git add server/src/routes/audit.ts server/src/index.ts
git commit -m "feat(audit): /admin/audit query with filters + pagination"
```

---

## Task 6: 穷尽检查

- [ ] **Step 1: grep 所有写操作，确认埋点无遗漏**

Run: `Grep` pattern `router\.(post|patch|put|delete)\(` in `server/src/routes/` → 输出到 checklist。
对每一条核对是否有 `audit(req, …)` 调用。遗漏的补上。

- [ ] **Step 2: 提交（若有补**）

```bash
git commit -am "feat(audit): fill gaps in instrumentation"
```

---

## Task 7: 部署到 gwbk 验证

- [ ] **Step 1: 部署**

```bash
./scripts/deploy-gwbk.sh
```

- [ ] **Step 2: 在 UI 未变的前提下手动触发几个动作**

用 production UI（连到 gwbk DB）触发：创建账号 → 禁用账号 → 改 plan → 撤销 client。

```bash
psql "$DATABASE_URL" -c "
SELECT created_at, actor_email, action, resource_type, resource_id
FROM audit_logs
ORDER BY created_at DESC LIMIT 10"
```

Expected: 出现相应 4 条记录，`before`/`after` 非空，`access_token` 类字段已脱敏为 `***`。

---

## Task 8: 合并到 main

```bash
git fetch origin main && git rebase origin/main
git checkout main && git merge --no-ff feat/audit-log-backend -m "merge: feat/audit-log-backend"
git push origin main
```

通知：`feat/admin-audit-log-ui` 解除依赖。
