# Account Groups Backend Implementation Plan — `feat/account-groups-backend`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引入"账号组"概念：一组 oauth_accounts + 一组 clients 共享同一调度范围。支持 default 组兜底。后端完成 migration / CRUD API / 调度器改造，UI 不碰。

**Architecture:**
- Migration `015_account_groups.sql`：新表 `account_groups`；`oauth_accounts.group_id`（NULL 允许）；`clients.group_id` NOT NULL DEFAULT 指向系统 default 组。
- `server/src/services/groups.ts` — 组 CRUD + default guard（任意时刻必须有且仅有一个 `is_default = true`）。
- `server/src/routes/groups.ts` — `/admin/groups` REST。
- 调度器：`src/launcher.ts` / `src/proxy-agent.ts` 在挑选 oauth_account 时，必须限制在 client.group_id 下的 accounts 集合中；若 client 指定的组为空则按 default 组兜底；再兜不到就报 `no_available_account`。

**Tech Stack:** TypeScript + PostgreSQL + Express + tsx assert-style tests.

---

## 约束

1. **Default 组唯一性** — 用部分唯一索引强制 `CREATE UNIQUE INDEX ... WHERE is_default = true`。
2. **迁移零中断** — 创建 default 组后，`UPDATE clients SET group_id = <default> WHERE group_id IS NULL` 回填；现存 `oauth_accounts.group_id` 保持 NULL 视为"不限组"。
3. **调度策略** — client → 固定 group；account group_id = NULL 表示"共享池"，任何 client 都可使用。
4. **不改 UI** — `feat/admin-groups-ui` 负责前端。
5. 禁 emoji、禁渐变色、不提 PR。

---

## 文件结构

**Create:**
- `migrations/015_account_groups.sql`
- `server/src/services/groups.ts`
- `server/src/routes/groups.ts`
- `tests/account-groups.test.ts` — gateway-side 调度测试（跑在 repo 根的 tests/ 下，按现有约定）
- `server/src/routes/groups.test.ts` — API 冒烟（与现有 server 测试风格一致；如果 server/ 没有 tests 基础设施，合并进 `tests/` 根目录用 tsx 跑）

**Modify:**
- `server/src/index.ts`（或 `routes/index.ts`）— 挂 `/admin/groups`
- `src/launcher.ts` — 调度时按 group 过滤
- `src/proxy-agent.ts` — 透传 client.group_id
- `server/src/routes/admin.ts` — oauth_accounts list 返回 `group_id`

---

## Task 1: 切分支 + 写 migration

- [ ] **Step 1: 切分支**

```bash
cd /path/to/cc-gateway
git checkout main && git pull
git checkout -b feat/account-groups-backend
```

- [ ] **Step 2: 写 migration**

```sql
-- migrations/015_account_groups.sql
BEGIN;

CREATE TABLE IF NOT EXISTS account_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(64) NOT NULL UNIQUE,
  description TEXT,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_account_groups_default
  ON account_groups (is_default) WHERE is_default = true;

-- Seed default group
INSERT INTO account_groups (name, description, is_default)
VALUES ('default', '默认组，未指定组的客户端兜底使用', true)
ON CONFLICT (name) DO NOTHING;

-- OAuth accounts: nullable group_id, NULL = 共享池
ALTER TABLE oauth_accounts
  ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES account_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_accounts_group ON oauth_accounts (group_id);

-- Clients: NOT NULL group_id, 先允许 NULL 做回填再加约束
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES account_groups(id) ON DELETE RESTRICT;

UPDATE clients
SET group_id = (SELECT id FROM account_groups WHERE is_default = true LIMIT 1)
WHERE group_id IS NULL;

ALTER TABLE clients ALTER COLUMN group_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clients_group ON clients (group_id);

COMMIT;
```

- [ ] **Step 3: 跑 migration**

```bash
psql "$DATABASE_URL" -f migrations/015_account_groups.sql
```

Expected: 无错，`SELECT * FROM account_groups` 返回 1 行 default；`\d clients` 显示 group_id NOT NULL。

- [ ] **Step 4: 提交**

```bash
git add migrations/015_account_groups.sql
git commit -m "feat(groups): add account_groups table with default seeding"
```

---

## Task 2: 写服务层 + 失败测试

**Files:**
- Create: `server/src/services/groups.ts`
- Create: `tests/account-groups.test.ts`

- [ ] **Step 1: 写服务层骨架**

```typescript
// server/src/services/groups.ts
import { query } from '../db'

export type AccountGroup = {
  id: string
  name: string
  description: string | null
  is_default: boolean
  created_at: string
  updated_at: string
}

export async function listGroups(): Promise<AccountGroup[]> {
  const { rows } = await query('SELECT * FROM account_groups ORDER BY is_default DESC, name ASC')
  return rows
}

export async function getDefaultGroupId(): Promise<string> {
  const { rows } = await query('SELECT id FROM account_groups WHERE is_default = true LIMIT 1')
  if (rows.length === 0) throw new Error('default group missing')
  return rows[0].id
}

export async function createGroup(input: { name: string; description?: string }): Promise<AccountGroup> {
  const { rows } = await query(
    `INSERT INTO account_groups (name, description) VALUES ($1, $2) RETURNING *`,
    [input.name, input.description ?? null],
  )
  return rows[0]
}

export async function updateGroup(id: string, input: { name?: string; description?: string | null }): Promise<AccountGroup> {
  const { rows } = await query(
    `UPDATE account_groups
       SET name = COALESCE($2, name),
           description = COALESCE($3, description),
           updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, input.name ?? null, input.description ?? null],
  )
  if (rows.length === 0) throw new Error('group not found')
  return rows[0]
}

export async function deleteGroup(id: string): Promise<void> {
  const { rows } = await query('SELECT is_default FROM account_groups WHERE id = $1', [id])
  if (rows.length === 0) throw new Error('group not found')
  if (rows[0].is_default) throw new Error('cannot delete default group')
  // 把被删组的 clients 打回 default
  const fallback = await getDefaultGroupId()
  await query('UPDATE clients SET group_id = $1 WHERE group_id = $2', [fallback, id])
  await query('UPDATE oauth_accounts SET group_id = NULL WHERE group_id = $1', [id])
  await query('DELETE FROM account_groups WHERE id = $1', [id])
}

export async function setAccountGroup(accountId: string, groupId: string | null): Promise<void> {
  await query('UPDATE oauth_accounts SET group_id = $2 WHERE id = $1', [accountId, groupId])
}

export async function setClientGroup(clientId: string, groupId: string): Promise<void> {
  await query('UPDATE clients SET group_id = $2 WHERE id = $1', [clientId, groupId])
}
```

- [ ] **Step 2: 写服务测试**

```typescript
// tests/account-groups.test.ts
import { strict as assert } from 'assert'
import { query } from '../src/db.js'
import {
  listGroups, createGroup, updateGroup, deleteGroup,
  getDefaultGroupId, setAccountGroup, setClientGroup,
} from '../server/src/services/groups.js'

async function main() {
  // default group exists
  const defId = await getDefaultGroupId()
  assert.ok(defId)

  // create
  const g = await createGroup({ name: 'test-g-' + Date.now(), description: 'x' })
  assert.equal(g.is_default, false)

  // update
  const g2 = await updateGroup(g.id, { description: 'y' })
  assert.equal(g2.description, 'y')

  // list
  const all = await listGroups()
  assert.ok(all.find((x) => x.id === g.id))
  assert.ok(all[0].is_default === true, 'default group first')

  // refuse delete default
  await assert.rejects(deleteGroup(defId), /default/)

  // delete non-default OK
  await deleteGroup(g.id)
  const after = await listGroups()
  assert.equal(after.find((x) => x.id === g.id), undefined)

  console.log('OK')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 3: 跑测试**

```bash
npx tsx tests/account-groups.test.ts
```

Expected: `OK`.

- [ ] **Step 4: 提交**

```bash
git add server/src/services/groups.ts tests/account-groups.test.ts
git commit -m "feat(groups): service layer with default-guard semantics"
```

---

## Task 3: REST API

**Files:**
- Create: `server/src/routes/groups.ts`
- Modify: `server/src/index.ts`（或已有 router aggregator）

- [ ] **Step 1: 写路由**

```typescript
// server/src/routes/groups.ts
import { Router } from 'express'
import { requireAdmin } from '../middleware/auth'
import {
  listGroups, createGroup, updateGroup, deleteGroup,
  setAccountGroup, setClientGroup,
} from '../services/groups'

const router = Router()

router.get('/', requireAdmin, async (_req, res) => {
  res.json({ items: await listGroups() })
})

router.post('/', requireAdmin, async (req, res) => {
  const { name, description } = req.body ?? {}
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' })
  res.json(await createGroup({ name, description }))
})

router.patch('/:id', requireAdmin, async (req, res) => {
  res.json(await updateGroup(req.params.id, req.body ?? {}))
})

router.delete('/:id', requireAdmin, async (req, res) => {
  await deleteGroup(req.params.id)
  res.json({ ok: true })
})

router.post('/accounts/:accountId', requireAdmin, async (req, res) => {
  const { groupId } = req.body ?? {}
  await setAccountGroup(req.params.accountId, groupId ?? null)
  res.json({ ok: true })
})

router.post('/clients/:clientId', requireAdmin, async (req, res) => {
  const { groupId } = req.body ?? {}
  if (!groupId) return res.status(400).json({ error: 'groupId required' })
  await setClientGroup(req.params.clientId, groupId)
  res.json({ ok: true })
})

export default router
```

- [ ] **Step 2: 挂到 server**

在 `server/src/index.ts`（或 `server/src/routes/index.ts`）加入：

```typescript
import groupsRouter from './routes/groups'
app.use('/api/admin/groups', groupsRouter)
```

- [ ] **Step 3: 手测**

```bash
curl -s -H "cookie: access_token=$ADMIN_COOKIE" http://localhost:3001/api/admin/groups
```

Expected: `{"items":[{"name":"default",...}]}`

- [ ] **Step 4: 提交**

```bash
git add server/src/routes/groups.ts server/src/index.ts
git commit -m "feat(groups): REST /admin/groups + membership assignment"
```

---

## Task 4: admin oauth_accounts/clients 返回 group_id

**Files:**
- Modify: `server/src/routes/admin.ts`
- Modify: `server/src/routes/clients.ts`

- [ ] **Step 1: SELECT 加字段**

找到管理员拉 oauth_accounts 列表的 SQL，把 `group_id` 加进 SELECT 返回。同样对 clients API 加字段。

- [ ] **Step 2: 提交**

```bash
git add server/src/routes/admin.ts server/src/routes/clients.ts
git commit -m "feat(groups): surface group_id on oauth_accounts/clients list APIs"
```

---

## Task 5: 调度器按 group 过滤

**Files:**
- Modify: `src/launcher.ts`
- Modify: `src/proxy-agent.ts`（在它调用 launcher 的地方）

- [ ] **Step 1: 写失败测试 — 跨组调度应失败**

```typescript
// tests/launcher-group.test.ts
import { strict as assert } from 'assert'
import { query } from '../src/db.js'
import { pickAccount } from '../src/launcher.js'

async function main() {
  // 准备：建一个非 default 组，放一个 account 进去
  const { rows: grp } = await query(
    `INSERT INTO account_groups (name) VALUES ('isolation-test-' || floor(random()*1e9)::text) RETURNING id`,
  )
  const groupId = grp[0].id

  const { rows: acct } = await query(
    `INSERT INTO oauth_accounts (name, access_token, refresh_token, group_id, enabled)
     VALUES ('iso-test', 'x', 'x', $1, true) RETURNING id`, [groupId],
  )
  const accountId = acct[0].id

  // 建两个 client：一个绑该组，一个绑 default
  const { rows: def } = await query(`SELECT id FROM account_groups WHERE is_default = true LIMIT 1`)
  const defaultId = def[0].id

  const { rows: c1 } = await query(
    `INSERT INTO clients (name, api_key_hash, group_id) VALUES ('c-iso', 'h1', $1) RETURNING id`, [groupId],
  )
  const { rows: c2 } = await query(
    `INSERT INTO clients (name, api_key_hash, group_id) VALUES ('c-def', 'h2', $1) RETURNING id`, [defaultId],
  )

  // c1 调度应能拿到 acct
  const a1 = await pickAccount({ clientId: c1[0].id, model: 'claude-haiku-4-5-20251001' })
  assert.equal(a1?.id, accountId, 'c1 must pick its group account')

  // c2 不应拿到 acct（不同组）
  const a2 = await pickAccount({ clientId: c2[0].id, model: 'claude-haiku-4-5-20251001' })
  assert.notEqual(a2?.id, accountId, 'c2 must NOT pick other-group account')

  // 清理
  await query(`DELETE FROM clients WHERE id IN ($1,$2)`, [c1[0].id, c2[0].id])
  await query(`DELETE FROM oauth_accounts WHERE id = $1`, [accountId])
  await query(`DELETE FROM account_groups WHERE id = $1`, [groupId])

  console.log('OK')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
```

运行 — 应当失败（当前调度器不按 group 过滤）：

```bash
npx tsx tests/launcher-group.test.ts
```

- [ ] **Step 2: 定位调度函数**

Run: `Grep` pattern `export.*function.*pickAccount|selectAccount|chooseAccount` in `src/launcher.ts`

- [ ] **Step 3: 修改调度**

把 `pickAccount` 的 WHERE 改为：

```sql
WHERE oa.enabled = true
  AND (
    oa.group_id IS NULL                   -- 共享池
    OR oa.group_id = (SELECT group_id FROM clients WHERE id = $clientId)
  )
```

即 account 要么没绑组（共享池），要么和 client 同组。

注意：`(SELECT group_id FROM clients WHERE id = ...)` 子查询做一次就好；可以在 JS 层先查 client.group_id 再拼到主 SQL。

- [ ] **Step 4: 测试通过**

```bash
npx tsx tests/launcher-group.test.ts
```

Expected: `OK`.

- [ ] **Step 5: 提交**

```bash
git add src/launcher.ts tests/launcher-group.test.ts
git commit -m "feat(groups): scheduler honors client.group_id isolation"
```

---

## Task 6: 部署到 gwbk 验证

- [ ] **Step 1: 部署**

```bash
./scripts/deploy-gwbk.sh
```

- [ ] **Step 2: 真实请求验证**

```bash
# 已有 client 走 default 组应正常
curl -s -X POST https://gwbk.example.com/v1/messages \
  -H "authorization: Bearer $TEST_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-haiku-4-5-20251001","stream":true,"max_tokens":16,"messages":[{"role":"user","content":"ping"}]}' \
  | head -c 300
```

```bash
psql "$DATABASE_URL" -c "
SELECT c.name AS client, c.group_id, oa.name AS account, oa.group_id AS account_group
FROM request_logs rl
JOIN clients c ON c.id = rl.client_id
LEFT JOIN oauth_accounts oa ON oa.id = rl.oauth_account_id
ORDER BY rl.created_at DESC LIMIT 5"
```

Expected: account.group_id 要么 NULL，要么等于 client.group_id。

---

## Task 7: 合并到 main

- [ ] **Step 1: rebase + merge**

```bash
git fetch origin main && git rebase origin/main
git checkout main && git merge --no-ff feat/account-groups-backend -m "merge: feat/account-groups-backend"
git push origin main
```

- [ ] **Step 2: 通知：`feat/admin-groups-ui` / `feat/user-clients` 现在解除依赖。**
