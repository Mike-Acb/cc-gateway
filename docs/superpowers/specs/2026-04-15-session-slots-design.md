# Anti-Ban Fix: Session Slots + Fingerprint Hardening

2026-04-14/15 封号事件的完整修复方案。核心问题：多客户端共享 OAuth 账号时，出站指纹不一致 + session 数量异常，被 Anthropic 检测为凭证共享。

## Problem

2412 条请求日志分析发现以下出站异常（Anthropic 视角）：

1. **Session 爆炸**：`十三-max5` 单账号 32 个不同 session_id，单小时最高 11 个并发
2. **OS/arch 指纹跳变**：同一 device_id 在 MacOS/arm64 和 Linux/x64 间来回切换
3. **UA 版本分裂**：PM2 重启后 version lock 丢失，同一 device_id 出现 3 个不同 CC 版本
4. **假版本号泄漏**：5 条请求 billing header 带了 `cc_version=2.1.888`（不存在的版本）
5. **封号后无熔断**：收到 401 后继续用同一账号重试

## Fix 1: Session Slots

### Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Slot full strategy | LRU reuse | 新客户端复用最久未用槽位的 derivedId，Anthropic 看到的 session 数永远 <= max |
| Default max_sessions | 3 | 所有账号统一默认值 |
| Frontend location | Account Detail 卡片 "Session Slots" 区域 | 核心运行时状态，一眼可见 |
| Persistence | Memory (hot path) + Redis + DB | 内存零延迟分配；Redis 跨重启；DB 存复用历史 |
| Architecture | 进程内管理，异步同步 | 当前单进程 PM2，不需要分布式锁 |

### Data Model

#### DB: `session_slots` table

```sql
CREATE TABLE session_slots (
  id                BIGSERIAL PRIMARY KEY,
  account_id        UUID NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,
  slot_index        SMALLINT NOT NULL,
  derived_session_id VARCHAR(36) NOT NULL,
  bound_keys        TEXT[] NOT NULL DEFAULT '{}',
  reuse_count       INT NOT NULL DEFAULT 0,
  last_used_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, slot_index)
);
CREATE INDEX idx_session_slots_account ON session_slots(account_id);
```

#### DB: `session_slot_history` table

```sql
CREATE TABLE session_slot_history (
  id                BIGSERIAL PRIMARY KEY,
  account_id        UUID NOT NULL REFERENCES oauth_accounts(id) ON DELETE CASCADE,
  slot_index        SMALLINT NOT NULL,
  action            VARCHAR(16) NOT NULL,  -- 'created', 'bound', 'evicted'
  client_name       VARCHAR(64),
  evicted_client    VARCHAR(64),
  idle_duration_ms  BIGINT,
  reuse_number      INT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_slot_history_account ON session_slot_history(account_id, created_at DESC);
```

#### DB: `oauth_accounts.max_sessions` default change

```sql
ALTER TABLE oauth_accounts ALTER COLUMN max_sessions SET DEFAULT 3;
UPDATE oauth_accounts SET max_sessions = 3 WHERE max_sessions = 0;
```

#### Redis Keys

| Key | Type | Content | TTL |
|-----|------|---------|-----|
| `slots:{accountId}:meta` | Hash | field=slotIndex, value=JSON `{derivedId, lastUsed, reuseCount}` | 24h |

#### In-Memory Structure

```typescript
type SessionSlot = {
  derivedId: string
  lastUsed: number
  boundKeys: Set<string>
  reuseCount: number
}

type AccountSessionTable = {
  slots: SessionSlot[]
  keyToSlot: Map<string, number>
}

const sessionTables = new Map<string, AccountSessionTable>()
```

### Core Logic: Slot Allocation

```
getOrAssignSession(accountId, stickyKey, clientName, maxSessions) -> derivedSessionId

1. maxSessions == 0 → bypass, use original deriveSessionId() directly

2. keyToSlot.has(stickyKey)?
   YES → update lastUsed, async update Redis, return slot.derivedId

3. slots.length < maxSessions?
   YES → create new slot:
         derivedId = deriveSessionId(accountId, stickyKey)
         push to slots, set keyToSlot
         async write Redis + DB (INSERT session_slots)
         async write DB history (action='created')
         return derivedId

4. LRU eviction:
   find slot with smallest lastUsed
   record evicted client name + idle duration
   clear old boundKeys from keyToSlot
   reset boundKeys to {stickyKey}
   keep existing derivedId (critical: do not change)
   reuseCount++
   update lastUsed
   async write Redis + DB (UPDATE session_slots)
   async write DB history (action='bound' + action='evicted')
   return derivedId
```

maxSessions 被调小时：下次请求懒触发 LRU 淘汰多余 slot。

### Startup Hydrate

在 `startAccountPool()` 里 `syncAccounts()` 之后调用：

```
hydrateSessionSlots():
  SELECT * FROM session_slots WHERE last_used_at > now() - INTERVAL '24 hours'
  rebuild sessionTables in memory
  overwrite Redis keys (DB is source of truth on cold start)
```

### Expiry & Cleanup

- Redis: TTL 24h 自动过期
- Memory: hydrate 时过滤 last_used_at > 24h
- DB session_slots: 每小时清理 last_used_at < 24h
- DB session_slot_history: 保留 7 天

### stickyKey to Client Name Resolution

`getOrAssignSession()` 接收 `clientName` 参数（来自 `authResult.clientName`），写入 history 表和 slot 的 bound_keys 时同时记录 clientName。API 响应中的 `bound_clients` 从内存中的 boundKeys 关联 clientName 映射。

### API

#### GET `/api/admin/oauth-accounts/:id/session-slots`

```json
{
  "max_sessions": 3,
  "slots": [
    {
      "slot_index": 0,
      "derived_session_id": "5aa1f225-29b3-...",
      "bound_clients": ["alice", "my-macbook"],
      "reuse_count": 4,
      "last_used_at": "2026-04-15T15:30:00Z",
      "created_at": "2026-04-15T14:25:00Z",
      "status": "active"
    }
  ],
  "history": [
    {
      "slot_index": 0,
      "action": "bound",
      "client_name": "my-macbook",
      "evicted_client": "dev",
      "idle_duration_ms": 1380000,
      "reuse_number": 4,
      "created_at": "2026-04-15T06:59:47Z"
    }
  ]
}
```

#### Stats extension in GET `/api/admin/oauth-accounts`

AccountStats 新增：
```typescript
session_slots: { used: number, max: number }
```

### Frontend

#### Account Detail Card: "Session Slots" section

位置：Detail 视图中 concurrent/RPM/TPM 实时状态区块之后。

**收起状态：**
- Section header: "SESSION SLOTS" + `used/max` 计数
- Usage bar: 分段条（绿=活跃, 琥珀=空闲/LRU 候选, 灰=未分配）
- Slot 行: slot_index, derived_session_id(截断), bound client names 标签, reuse count, last active 相对时间, 状态圆点, 展开箭头

**展开状态（点击 slot）：**
- Reuse History 时间线
- 每条记录: action (Bound/Evicted/Created), client name, evicted client, idle duration, timestamp
- 竖线 + 圆点样式（绿=当前, 灰=历史）

**状态指示：**
- 绿色: lastUsed < 5 min
- 琥珀色 + "LRU" 标签: 最久未用的 slot
- 灰色 + 虚线边框: 未分配

Mockup: `mockups/session-slots.html`

## Fix 2: OS/arch Lock

### Problem

`rewriteHeaders()` 中 `x-stainless-os` 和 `x-stainless-arch` 直接穿透（`out[key] = v`），导致同一 device_id 出现 MacOS + Linux 交替。

### Solution

改为和 UA 一样用 `lockVersionFromFirstClient` 按 account_uuid 锁定：

```typescript
// rewriter.ts, rewriteHeaders()
} else if (lower === 'x-stainless-os') {
  const acctId = view.account_uuid || '_default'
  out[key] = lockVersionFromFirstClient(acctId, 'os', v)
} else if (lower === 'x-stainless-arch') {
  const acctId = view.account_uuid || '_default'
  out[key] = lockVersionFromFirstClient(acctId, 'arch', v)
}
```

同时在 `hydrateVersionLocks` 中新增 `'os'` 和 `'arch'` 到 hydrate 字段列表。

## Fix 3: Version Lock 跨重启持久化

### Problem

`versionCache` 是内存 Map，PM2 重启后丢失。`hydrateVersionLocks` 和 `getRedisForLock` 逻辑已有但未生效：
- Redis 可能未配置/连接失败
- `hydrateVersionLocks` 可能未在启动时被调用

### Solution

1. 确认服务器 Redis 运行正常，config.yaml 包含 redis 配置
2. 在 `startAccountPool()` 中显式调用 `hydrateVersionLocks(accountUuids)` — 传入所有活跃账号的 account_uuid
3. `hydrateVersionLocks` 的 field 列表扩展为 `['ua', 'node', 'pkg', 'os', 'arch']`（包含 Fix 2 新增的字段）
4. 添加启动日志：hydrate 了多少个 key，便于排查

## Fix 4: 假版本号 Fallback

### Problem

`identity-rewrite.ts:114` 的 `versionFromUserAgent` 正则不匹配时返回硬编码的 `'2.1.888'`（不存在的版本）。

### Solution

从 config 读取：

```typescript
// identity-rewrite.ts
import { getConfig } from './config.js'

function versionFromUserAgent(userAgent: string): string {
  const match = userAgent.match(/claude-(?:cli|code)\/([^\s]+)/i)
  return match?.[1] ?? getConfig().env?.version ?? '2.1.94'
}
```

同时将 `config.yaml` 中 `env.version` 更新为 `2.1.94`。

## Fix 5: 401/403 封号熔断

### Problem

收到 401 `OAuth authentication is currently not supported` 或 403 `not allowed for this organization` 后，网关继续用同一账号重试。

### Solution

在 proxy.ts 的上游响应处理中，检测这两类错误码+消息，立即将账号标记为 `disabled`：

```
上游返回 401/403
  → 检查 error.message 是否包含 "OAuth authentication" 或 "not allowed for this organization"
  → 是 → UPDATE oauth_accounts SET status = 'disabled' WHERE id = ?
       → 从内存 pool 中移除该账号
       → 日志记录: "Account {name} disabled: {error_message}"
       → 当前请求返回 503 给客户端
  → 否 → 正常错误处理（可能是其他类型的 401/403）
```

恢复方式：管理员在前端面板手动将账号状态改回 `active`。不做自动恢复 — 401/403 是账号级封禁，自动探测会持续暴露被封 token。

## Files to Modify

| File | Fix | Change |
|------|-----|--------|
| `migrations/010_session_slots.sql` | 1 | session_slots + session_slot_history 表, max_sessions 默认值 |
| `src/identity-rewrite.ts` | 1,4 | getOrAssignSession(), session table 管理, hydrate; versionFromUserAgent fallback 改为读 config |
| `src/proxy.ts` | 1,5 | deriveSessionId() 调用改为 getOrAssignSession() (~3处); 401/403 熔断逻辑 |
| `src/rewriter.ts` | 2,3 | x-stainless-os/arch 改为 lockVersionFromFirstClient; hydrateVersionLocks field 列表扩展 |
| `src/account-pool.ts` | 1,3 | startAccountPool() 调用 hydrateSessionSlots() + hydrateVersionLocks() |
| `src/config.ts` | 4 | env.version 暴露给 identity-rewrite 使用（确认 getConfig 可用） |
| `config.yaml` | 4 | env.version 更新为 2.1.94 |
| `server/src/routes/oauth-accounts.ts` | 1 | GET /:id/session-slots 端点 |
| `web/src/pages/admin/AdminAccountsPage.tsx` | 1 | Session Slots section in detail card |

## Not In Scope

- Multi-process PM2 sync（当前单进程）
- Session slot metrics/alerting
- Per-client slot reservation
- 自动封号恢复/探测
