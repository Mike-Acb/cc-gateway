# Admin & User Console Redesign（gwbk.example.com）

基于 `.superpowers/brainstorm/96985-1776356290/content/04-full-prototype.html` 的交互原型，对 cc-gateway 的 Web 控制台（用户视角 + 管理员视角）做一次完整重做。

**部署目标：`gwbk.example.com`（独立站点，与生产 `gw.example.com` 并行）。** `gw` 继续作为线上生产服务不动；新前端 / 新后端 / 新表结构全部在 `gwbk` 侧落地、验证，稳定后再决定是否切流量。

## Problem

当前控制台存在四类问题：

1. **视觉混乱** — 组件散落、风格不一：按钮/输入/卡片各页各样，用户与管理员共用同一套页面堆叠。
2. **运营视角缺失** — 管理员关心的"按模型/账号/用户/分组切片的请求量"没法看；观测指标只有单一折线。
3. **账号调度粒度不够** — 账号池是平铺列表，没有"分组"概念，也就没法把稳定池 / 冷备 / 测试账号隔离开。
4. **审计缺失** — 增删订阅、封禁用户、新增/停用账号、重载网关、套餐价格调整……这些操作没有任何留痕，出了问题无法回溯。

用户在多轮反馈里也明确点出了：用户视角缺少请求日志详情、套餐和充值混在一起、组件不统一、图表悬停没详情、缺系统操作审计。

## Goals

* 两种视角各自成体系：User（订阅、用量、自己的日志、客户端）和 Admin（全局运营 + 观测 + 系统）。
* 一套统一的设计 token（字体、色板、输入/选择/勾选/开关/分段），所有页面复用。
* 账号加"分组"这一级抽象，支持 weighted / round_robin / failover 策略，客户端**必须**绑定到某个分组，没有选就落到**默认分组**。
* 所有"改动系统状态"的操作进审计日志表，带 actor / action / resource / before / after / 时间 / IP。
* 请求日志新增可观测维度：总时长、首 token 时长、是否流式、拦截原因（区分网关拦截 vs 上游 4xx/5xx）。
* 每日成本卡位下线（已被月度配额 + 余额卡取代）。

### Non-Goals（YAGNI）

* 不做多租户 / workspace。
* 不做审计日志的 UI 侧过滤"按 diff 字段精确匹配"之类的花活，只给 actor / action / resource / 时间四维过滤。
* 不做观测指标的告警规则 UI（先只读展示，告警规则下一阶段）。
* 不做账号分组的"自动迁移"（账号切分组用手动拖动或 drawer 改，不搞规则引擎）。
* 不做请求日志全文搜索。

## Current State Audit

* **前端路由/页面**：`web/src/pages/admin/` 下 6 个文件，全部挂在 `AdminPages.tsx` 的 tab 组件里；用户侧 `web/src/pages/{auth,clients,invite}`，Dashboard 在顶层 `App.tsx`。
* **后端路由**：`server/src/routes/` 下 15 个路由文件，`admin.ts` 是杂物抽屉，`request-logs.ts` / `identity-profiles.ts` / `outbound-proxies.ts` 已独立。
* **数据模型**：`oauth_accounts` 无 `group_id`；`request_logs` 已有 `latency_ms` 但没有 `first_token_ms` / `streaming` / `block_reason`（009 迁移加了 headers/body 调试字段，但没加业务字段）；没有 `account_groups` / `audit_logs` 表。
* **身份模板**：`identity_profiles` 表存在，`src/proxy.ts` 和 `src/account-pool.ts` 在用，**没废弃**，继续保留。
* **出站代理**：`outbound_proxies` 表 + `src/proxy-agent.ts` 已就绪，UI 也在，不动逻辑，只做视觉统一。

## Design

### 1 — 信息架构（Information Architecture）

顶部一个 `User / Admin` 视角切换（同一个账号可以两边都进）。左侧导航按视角展开不同组。

**User 视角（6 页）**

* 仪表盘（概览、订阅卡、余额卡、按客户端 / 按模型切片的请求量、最近请求）
* 我的用量（月度曲线、Top 模型、Top 客户端）
* 请求日志（带详情 modal，对用户隐藏账号名等内部字段）
* 客户端（增删改查、查看 key、切换分组）
* 订阅与账单（订阅管理、充值、发票）
* 设置（profile、API key、安全）

**Admin 视角（11 页）**

* **运营组**：全局概览、账号池、账号分组、用户、客户端
* **计费组**：套餐、模型定价、配额规则、活动
* **观测组**：请求日志、观测指标
* **系统组**：**审计日志（新）**、系统状态

（每日成本卡位全部拿掉。）

### 2 — 视觉 Token

原型已经敲定，实现时搬过来即可：

* 字体：`Instrument Serif`（标题）+ `IBM Plex Sans`（正文）+ `JetBrains Mono` / `IBM Plex Mono`（数字、日志、ID）
* 色板：`#faf9f5` 背景 / `#c44` 强调 / `#2d7a5f` ok / `#d97706` warn / `#245a8a` info / `#a02020` err
* 圆角一律 2–6px（避免过度圆润）
* **禁止使用渐变色**（用户明确要求）
* 表单基础组件统一收敛：`.btn` / `.chk` / `.rad` / `.switch` / `.seg` / `.field` / `.filter-bar` / `.pill` / `.chip`

### 3 — 数据模型变更

#### 3.1 account_groups 表（新）

```sql
CREATE TABLE account_groups (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         VARCHAR(64) UNIQUE NOT NULL,
  strategy     VARCHAR(16) NOT NULL CHECK (strategy IN ('weighted','round_robin','failover')),
  is_default   BOOLEAN NOT NULL DEFAULT FALSE,
  fallback_id  UUID REFERENCES account_groups(id) ON DELETE SET NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_account_groups_one_default ON account_groups (is_default) WHERE is_default;

ALTER TABLE oauth_accounts ADD COLUMN group_id UUID REFERENCES account_groups(id);
ALTER TABLE clients        ADD COLUMN group_id UUID NOT NULL REFERENCES account_groups(id);

-- 初始化默认分组并把现有所有账号/客户端落到它上面
INSERT INTO account_groups (name, strategy, is_default) VALUES ('default', 'weighted', TRUE);
UPDATE oauth_accounts SET group_id = (SELECT id FROM account_groups WHERE is_default);
UPDATE clients        SET group_id = (SELECT id FROM account_groups WHERE is_default);
ALTER TABLE oauth_accounts ALTER COLUMN group_id SET NOT NULL;
```

**约束**：

* 全表至多一条 `is_default=true`（部分唯一索引保证）。
* 客户端必须有 `group_id`（NOT NULL），注册/创建客户端时若未指定，走默认分组。
* 删除分组前必须把下属账号 / 客户端全部迁出；删除默认分组前必须先把别的分组设为默认。
* `fallback_id` 只在 `strategy='failover'` 时参与决策。

#### 3.2 request_logs 字段扩充

```sql
ALTER TABLE request_logs
  ADD COLUMN first_token_ms INT,
  ADD COLUMN streaming      BOOLEAN,
  ADD COLUMN block_reason   VARCHAR(32),
  ADD COLUMN block_source   VARCHAR(8);      -- 'gw' | 'up' | NULL

CREATE INDEX idx_request_logs_block ON request_logs (block_reason, created_at) WHERE block_reason IS NOT NULL;
```

`block_reason` 枚举：`rate_limited` / `plan_forbidden_model` / `auth_missing` / `quota_exceeded` / `malformed_block` / `upstream_5xx` / `upstream_429`。
`block_source`：`gw` 表示网关拦截（没走到 Anthropic），`up` 表示上游 4xx/5xx。

（`latency_ms` 已存在复用；`duration_ms` 字段不再新加。）

#### 3.3 audit_logs 表（新）

```sql
CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  actor_type  VARCHAR(16) NOT NULL,        -- 'user' | 'system'
  actor_id    UUID,                         -- 对 system 为 NULL
  actor_email VARCHAR(128),
  actor_ip    VARCHAR(45),
  action      VARCHAR(48) NOT NULL,         -- e.g. 'plan.update'
  resource    VARCHAR(128) NOT NULL,        -- e.g. 'plan:Pro' / 'user:jerry@x.com'
  summary     TEXT,
  before      JSONB,
  after       JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_actor  ON audit_logs (actor_id, created_at);
CREATE INDEX idx_audit_action ON audit_logs (action, created_at);
CREATE INDEX idx_audit_time   ON audit_logs (created_at);
```

**Action 命名空间**（namespace.verb）：

| 命名空间 | verb 列表 |
|---|---|
| `plan` | `create` / `update` / `delete` |
| `subscription` | `grant` / `revoke` / `extend` |
| `user` | `register` / `ban` / `unban` / `delete` / `role_change` |
| `account` | `create` / `update` / `disable` / `enable` / `delete` |
| `group` | `create` / `update` / `delete` / `set_default` |
| `client` | `create` / `revoke` / `update` |
| `gateway` | `reload` / `config_change` |

**写入机制**：后端抽一个 `auditLog(req, action, resource, before, after, summary)` helper，所有修改类路由（`admin.ts` / `plans.ts` / `oauth-accounts.ts` / `clients.ts`/ `users.*` / `campaigns.ts`）调用。注册路由通过中间件自动记 `user.register`。`gateway.reload` 在 `launcher.ts` 的 reload hook 里记。

### 4 — API 变更概要

新路由（全部挂 `/api/admin` 前缀，要求 admin role）：

* `GET    /api/admin/audit-logs`              （过滤 + 分页）
* `GET    /api/admin/audit-logs/:id`          （单条详情）
* `GET    /api/admin/account-groups`
* `POST   /api/admin/account-groups`
* `PATCH  /api/admin/account-groups/:id`
* `DELETE /api/admin/account-groups/:id`
* `POST   /api/admin/account-groups/:id/set-default`

既有路由改造：

* `POST /api/admin/oauth-accounts` body 加 `group_id`（可省，省则用默认分组）。
* `POST /api/admin/clients` 同上。
* `GET /api/admin/request-logs` 响应加 `first_token_ms`/`streaming`/`block_reason`/`block_source`；查询参数加 `?block_source=gw|up` 和 `?block_reason=...`。
* `GET /api/admin/metrics` 新端点，返回 P50/P90/P95/P99 时序 + 按维度切片（model/account/user/group/stream）的请求量。

用户侧：

* `GET /api/me/request-logs/:id` 返回**脱敏**版单条详情（不含 `oauth_account_name`、不含 `request_body_out`）。

### 5 — 账号调度（account-pool）改造

`src/account-pool.ts` 目前按账号级别做 weighted 选择。改为：

1. 先按客户端的 `group_id` 选中一个分组。
2. 在分组内按 `strategy` 选账号：
   * `weighted` — 现有逻辑。
   * `round_robin` — Redis 维护 `group:{id}:rr_idx`。
   * `failover` — 只选第 1 个 active 账号；都不可用就查 `fallback_id` 指向的分组，递归最多 1 层。
3. 账号的 cooldown/disabled 不跨分组溢出（即便默认分组全挂，也不会借用别的分组，除非通过 fallback 链）。

### 6 — 前端组件库（`web/src/ui/`）

把原型里的组件正式落到代码库。放 `web/src/ui/`：

```
web/src/ui/
  Button.tsx          -- 按钮三态（primary / default / disabled）
  Checkbox.tsx        -- .chk 样式
  Radio.tsx           -- .rad
  Switch.tsx          -- .switch
  Segmented.tsx       -- .seg
  Field.tsx           -- label + input 组合
  FilterBar.tsx       -- 顶栏过滤组件壳
  Pill.tsx            -- ok/warn/err/info/mute
  Chip.tsx
  Table.tsx           -- .tbl 标准化
  StatGrid.tsx        -- 概览卡片栅格
  Modal.tsx / Drawer.tsx
  Tooltip.tsx         -- 通用悬停提示
  Chart/
    StackedBars.tsx   -- 带 hover tooltip
    MultiLine.tsx     -- P50/P90/P95/P99 折线
    SparkLine.tsx
    Bars.tsx
  DiffViewer.tsx      -- 审计日志用
```

所有既有 admin 页面逐步改用这些组件；不做"大爆炸重写"，跟着 feature 分支走，每条支线改到哪替换到哪。

### 7 — 页面映射（原型 → 真实代码）

| 原型页 | 落地文件 | 备注 |
|---|---|---|
| `u-dashboard` | `web/src/pages/Dashboard.tsx` | 拆出 `SubscriptionCard` / `BalanceCard`，订阅和充值分离 |
| `u-usage` | 新 `web/src/pages/Usage.tsx` | 月度曲线 + Top 模型 / Top 客户端 |
| `u-logs` | 新 `web/src/pages/RequestLogs.tsx` | 用户视图，详情 modal 脱敏 |
| `u-clients` | `web/src/pages/clients/ClientsPage.tsx` | 加 group 选择 |
| `u-billing` | 新 `web/src/pages/Billing.tsx` | 订阅 / 充值 / 发票三 tab |
| `u-settings` | 新 `web/src/pages/Settings.tsx` | |
| `a-dashboard` | 新 `web/src/pages/admin/AdminDashboard.tsx` | 5 维切片 stacked chart |
| `a-accounts` | `AdminAccountsPage.tsx`（重构） | 4 tab drawer |
| `a-groups` | 新 `AdminGroupsPage.tsx` | |
| `a-users` | 新 `AdminUsersPage.tsx` | |
| `a-clients` | 新 `AdminClientsPage.tsx` | |
| `a-plans` | `AdminPlansPage.tsx`（重构） | 编辑 drawer |
| `a-pricing` | 新 `AdminPricingPage.tsx` | |
| `a-quotas` | 新 `AdminQuotasPage.tsx` | |
| `a-campaigns` | 新 `AdminCampaignsPage.tsx` | |
| `a-logs` | `AdminRequestLogsPage.tsx`（重构） | 新字段 + 来源过滤 |
| `a-metrics` | 新 `AdminMetricsPage.tsx` | |
| `a-audit-log` | 新 `AdminAuditLogPage.tsx` | |
| `a-system` | 保留（已有功能足够） | |

### 8 — 部署目标：gwbk.example.com

服务器 `1.2.3.4` 上的现状（已通过 SSH 核实）：

| 资源 | 现状 |
|---|---|
| 1Panel 站点 | `gwbk.example.com` 已建，TLS 证书已发（web root 在 `/www/sites/gwbk.example.com/index/`） |
| 源代码目录 | `/home/ubuntu/gwbk/` —— 只有网关一个进程的老版本：有 `src/` `dist/` `config.yaml` `ecosystem.config.cjs`，**没有 `server/`（API）也没有 `web/`（前端）** |
| PM2 进程 | 当前只有 PM2 app `gateway-bk`（跑 `src/index.ts`）。线上 `gw` 侧跑的是 `gateway` + `api-server` 两进程 |
| OpenResty 配置 | `/opt/1panel/www/conf.d/gwbk.example.com.conf` 是裸静态站配置：`include /www/sites/gwbk.example.com/proxy/*.conf`（此目录为空） |
| DB | 生产 `cc_gateway` 库复用；gwbk 连同一套 PG，但 OAuth 账号、用户、客户端**独立一套数据**（新建时带 `origin='gwbk'` 标签） |

部署策略落两条铁律：

1. **代码路径独立**：`/home/ubuntu/gwbk/` 完全放新版本（含 `server/` + `web/`）；不碰 `/home/ubuntu/gw/`。
2. **数据独立**：gwbk 的 `oauth_accounts` / `clients` / `users` 在 DB 层用 `deployment='gwbk'` 标记做软隔离（同一张表、不同 scope），或者直接用独立 schema（`gwbk.oauth_accounts`）—— **方案见 #9，在 `feat/gwbk-infra` 分支里拍板**。

### 9 — 分支拆分（18 条，按阶段编号）

每条分支：
* **独立 merge**、目标 PR diff ≤ 500 行；
* 自带 migration（如有），能在 `scripts/migrate.sh` 无报错跑通；
* 至少一条 Playwright 冒烟（或 API 侧 vitest）；
* 合并前部署到 gwbk 验证一次。

**Phase 0 · 基础设施（阻塞一切）**

| # | 分支 | 估时 | 范围 |
|---|---|---|---|
| 1 | `feat/gwbk-infra` | 1d | `/home/ubuntu/gwbk/` 目录重建为完整栈（拷 `gw` 的 `server/` + `web/` 骨架）；`ecosystem.config.cjs` 加 `api-server-bk`（端口 3001）和 `gateway-bk` 保留；OpenResty 追加 `/api/` → `127.0.0.1:3001`、`/v1/` → `127.0.0.1:8444`；决定数据隔离方案（独立 schema vs 软标签），写进本 spec；`scripts/deploy-gwbk.sh` 一键部署脚本；gwbk-only 的 `.env`（`CORS_ORIGIN=https://gwbk.example.com`） |

**Phase 1 · 基础（Phase 0 之后可全并行）**

| # | 分支 | 依赖 | 估时 | 范围 |
|---|---|---|---|---|
| 2 | `feat/ui-kit`                  | 1    | 1.5d | `web/src/ui/` 15 个组件：Button / Checkbox / Radio / Switch / Segmented / Field / FilterBar / Pill / Chip / Table / StatGrid / Modal / Drawer / Tooltip / Chart（StackedBars / MultiLine / SparkLine / Bars）+ 设计 tokens |
| 3 | `feat/nav-shell`               | 1, 2 | 0.5d | App 壳：顶栏 User/Admin 角色切换、左侧导航分组、404/loading 基类、路由表 |
| 4 | `feat/request-log-fields`      | 1    | 1d   | migration 加 `first_token_ms` / `streaming` / `block_reason` / `block_source`；网关 `src/proxy.ts` + `src/logger.ts` 写入补齐；`/api/admin/request-logs` 响应暴露新字段 |
| 5 | `feat/account-groups-backend`  | 1    | 1.5d | `account_groups` migration + `oauth_accounts.group_id` + `clients.group_id`；`src/account-pool.ts` 调度器改成"先选分组、再按 strategy 选账号 + fallback 递归"；`/api/admin/account-groups` CRUD；**不带 UI** |
| 6 | `feat/audit-log-backend`       | 1    | 1.5d | `audit_logs` migration + `auditLog()` helper（`server/src/services/audit.ts`）+ 在所有修改类路由埋点 + `tests/audit-coverage.test.ts`（扫 route 文件断言埋点覆盖率）+ `/api/admin/audit-logs` 列表/详情 API |

**Phase 2 · 用户视角（Phase 1 完成后并行 6 条）**

| # | 分支 | 依赖 | 估时 | 范围（对应原型页）|
|---|---|---|---|---|
| 7  | `feat/user-dashboard`  | 2, 3, 4, 5 | 1.5d | `u-dashboard`：SubscriptionCard / BalanceCard 分离 + 按客户端/模型切片的请求量 + 最近请求表 |
| 8  | `feat/user-usage`      | 2, 3, 4    | 1d   | `u-usage`：月度曲线 + Top 模型 + Top 客户端 |
| 9  | `feat/user-logs`       | 2, 3, 4    | 1d   | `u-logs`：脱敏请求日志列表 + 用户端详情 modal（`/api/me/request-logs/:id`） |
| 10 | `feat/user-clients`    | 2, 3, 5    | 1d   | `u-clients`：客户端 CRUD + group 绑定下拉（默认 default group） |
| 11 | `feat/user-billing`    | 2, 3       | 1d   | `u-billing`：订阅 / 充值 / 发票三 tab |
| 12 | `feat/user-settings`   | 2, 3       | 0.5d | `u-settings`：profile / API key / 安全 |

**Phase 3 · 管理员视角（Phase 1 完成后并行 8 条）**

| # | 分支 | 依赖 | 估时 | 范围（对应原型页）|
|---|---|---|---|---|
| 13 | `feat/admin-dashboard`           | 2, 3, 4, 5 | 1d   | `a-dashboard`：全局概览 + 5 维切片 stacked chart（model / account / user / group / stream）+ 告警横幅 |
| 14 | `feat/admin-accounts-drawer`     | 2, 3, 5    | 2d   | `a-accounts` + 4-tab drawer（概览 / 编辑 / 会话插槽 / 清理）+ 新增账号 modal（OAuth / Refresh Token 双流） |
| 15 | `feat/admin-groups-ui`           | 2, 3, 5    | 1d   | `a-groups`：分组列表 + drawer 编辑策略 / fallback / 设为默认 |
| 16 | `feat/admin-users-clients`       | 2, 3, 6    | 1.5d | `a-users` + `a-clients`：用户列表、封禁/解封/赠送订阅；客户端列表、吊销 |
| 17 | `feat/admin-plans-and-pricing`   | 2, 3, 5    | 1.5d | `a-plans`（编辑 drawer：价格/配额/模型白名单/默认分组/可见性）+ `a-pricing`（模型定价）+ `a-quotas`（配额规则） |
| 18 | `feat/admin-campaigns`           | 2, 3       | 1d   | `a-campaigns`：活动 / 优惠码 / 邀请奖励 |
| 19 | `feat/admin-request-logs-v2`     | 2, 3, 4    | 1.5d | `a-logs`：新字段展示、来源过滤（gw / up）、详情 modal 拦截/上游双模版、分页重做（覆盖 pending #31、#32） |
| 20 | `feat/admin-metrics`             | 2, 3, 4    | 2d   | `a-metrics`（新页）：P50/P90/P95/P99 时序 + 5 维切片 + Session Slots + 缓存命中 + block-reason 分布（覆盖 pending #29、#30） |
| 21 | `feat/admin-audit-log-ui`        | 2, 3, 6    | 1d   | `a-audit-log`：审计日志列表 + 4 维过滤 + diff modal |
| 22 | `feat/admin-system`              | 2, 3       | 0.5d | `a-system`：系统状态（保留现有功能但走新 UI kit）|

**Phase 4 · 清理（最后做）**

| # | 分支 | 依赖 | 估时 | 范围 |
|---|---|---|---|---|
| 23 | `feat/remove-daily-cost` | 7, 13 | 0.5d | 下线"每日成本"卡位；清理 Dashboard / Admin 引用；删除相关后端 SQL 聚合 |

总计 **22 条功能分支** + 1 条基建分支 = **23 条**。估时 ~26 人日，3–4 周（两人并行）或 6 周（单人）。

**合流顺序**：

```
feat/gwbk-infra (#1, 必须先合)
   └─► feat/ui-kit (#2)
         └─► feat/nav-shell (#3)
               └─► Phase 2 (6 条 user 页，全并行)
               └─► Phase 3 (8 条 admin 页，全并行)
   └─► feat/request-log-fields (#4)      ─┐
   └─► feat/account-groups-backend (#5)  ─┼─► 对应 UI 支线
   └─► feat/audit-log-backend (#6)       ─┘
                                            └─► feat/remove-daily-cost (#23, 最后)
```

**每条支线验收：**
1. 本地 `scripts/migrate.sh` 跑通；
2. 新页能在本地 dev server 打开、主交互可用；
3. `scripts/deploy-gwbk.sh` 能一键部署到 `gwbk.example.com` 并验证；
4. 只在本分支范围内改动，不顺手改别的页面。

## Risks

* **审计日志埋点遗漏** — 兜底：在 PR review 清单里列一条"所有修改类路由必须 grep 到 `auditLog(`"；并给 `admin.ts` 中间件加一个兜底 `auditLog` 调用（仅记 action + path）。
* **account_groups 回填** — 迁移里有 UPDATE 全表；生产库前先跑 `EXPLAIN` 估算行数，账号 < 100 / 客户端 < 1000，风险很低。
* **调度器改坏** — 失败会让请求全部 503。`feat/account-groups` 分支要带对 `account-pool.ts` 的单元测试，覆盖三种策略 + fallback 递归 + 全挂降级。
* **前端组件库合流慢** — `feat/ui-kit` 先一刀切合进 main，后续支线全部 rebase；不允许边改支线边塞新组件到 ui-kit（避免多分支污染）。

## Testing

* **DB migrations**：`scripts/migrate.sh` 跑到最新，然后 `scripts/migrate.sh -1` 回滚，验证无报错。
* **审计埋点覆盖**：写一个 `tests/audit-coverage.test.ts`，扫 `server/src/routes/` 所有 `POST|PATCH|PUT|DELETE` 路由，断言每个 handler 主体包含 `auditLog(`。
* **调度器**：`tests/account-pool-groups.test.ts` 覆盖 weighted / round_robin / failover / fallback 递归 / 全挂降级。
* **E2E**：每条 feat 支线起码有一条 Playwright 冒烟，走"打开页 → 关键操作 → 断言"。

## Open Questions

无（均已在前三轮 brainstorming 中确认）。
