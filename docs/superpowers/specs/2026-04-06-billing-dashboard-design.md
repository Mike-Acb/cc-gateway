# 2Coding Gateway — 计费系统 & Web Dashboard 设计规格

## 概述

为 2Coding Gateway（原 CC Gateway）增加计费、限制、Web 管理面板和支付功能。用户通过 Dashboard 注册、管理客户端、查看用量和账单、在线支付。管理员通过 Dashboard 管理用户、配置计费规则、审核客户端、创建活动。

---

## 1. 架构

三个独立服务 + PostgreSQL：

```
客户端 (cc-alice, cc-bob, ...)
        │
        ▼
┌────────────────────────────┐
│  ① 2Coding Gateway        │  Port 8443
│  API 代理 + 身份改写       │
│  速率限制 + 额度检查       │
│  用量计量 (写入 PG)        │
└────────────┬───────────────┘
             │                      │
    转发请求  │                      │ 读写 PG
             ▼                      ▼
   Anthropic API            ┌──────────────┐
                            │  PostgreSQL  │
             ┌──────────────┤              │
             │              └──────────────┘
             ▼                      ▲
┌────────────────────────────┐      │
│  ② API Server              │  Port 3000
│  Dashboard REST API        │  读写 PG
│  账单生成 (定时任务)        │
│  易支付集成 + 回调          │
│  客户端注册/审核            │
│  Webhook 通知推送           │
└────────────────────────────┘

┌────────────────────────────┐
│  ③ React Frontend          │  Port 5173 (dev)
│  管理员 Dashboard           │  Nginx/Caddy (prod)
│  客户端用量面板             │
│  React 19 + Vite + Tailwind│
└────────────────────────────┘
```

**服务间通信：** Gateway 和 API Server 共享 PostgreSQL。Gateway 每 30 秒轮询 PG 获取最新 clients/quotas/rate_limits（增量同步 `updated_at > last_sync_at`）。API Server 可通过 PG NOTIFY 触发 Gateway 即时同步。

---

## 2. 数据库设计 (PostgreSQL)

### 2.1 身份 & 认证

```sql
-- Dashboard 登录账号
CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username       VARCHAR(64) UNIQUE NOT NULL,
  email          VARCHAR(255) UNIQUE NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  role           VARCHAR(16) NOT NULL DEFAULT 'user',  -- 'admin' | 'user'
  status         VARCHAR(16) NOT NULL DEFAULT 'active', -- 'active' | 'suspended'
  invited_by     UUID REFERENCES users(id),
  invite_bound_at TIMESTAMPTZ,
  free_until     DATE,
  discount_rate  DECIMAL(3,2) DEFAULT 1.0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Gateway 客户端 token
CREATE TABLE clients (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id),
  name           VARCHAR(64) NOT NULL,
  token          CHAR(64) UNIQUE NOT NULL,
  status         VARCHAR(16) NOT NULL DEFAULT 'pending', -- 'active' | 'suspended' | 'pending'
  approved_by    UUID REFERENCES users(id),
  approved_at    TIMESTAMPTZ,
  suspended_at   TIMESTAMPTZ,
  suspend_reason VARCHAR(64),  -- 'quota_exceeded' | 'unpaid' | 'manual'
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, name)
);
```

Dashboard 认证：JWT（access 15min + refresh 7d），refresh_token 存 httpOnly cookie。

### 2.2 用量计量

```sql
-- 每次 API 请求的 token 用量（按月分区）
CREATE TABLE usage_records (
  id             BIGSERIAL,
  client_id      UUID NOT NULL REFERENCES clients(id),
  model          VARCHAR(64) NOT NULL,
  input_tokens   INT NOT NULL DEFAULT 0,
  output_tokens  INT NOT NULL DEFAULT 0,
  cache_read     INT NOT NULL DEFAULT 0,
  cache_write    INT NOT NULL DEFAULT 0,
  cost           DECIMAL(10,6) NOT NULL DEFAULT 0,
  latency_ms     INT,
  path           VARCHAR(255),
  status_code    SMALLINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 自动创建月分区
-- CREATE TABLE usage_records_2026_04 PARTITION OF usage_records
--   FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

CREATE INDEX idx_usage_client_time ON usage_records (client_id, created_at);
CREATE INDEX idx_usage_time ON usage_records (created_at);
```

### 2.3 限制引擎

```sql
-- 灵活时间窗口额度限制
CREATE TABLE quota_rules (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type    VARCHAR(8) NOT NULL,   -- 'user' | 'client'
  target_id      UUID NOT NULL,
  metric         VARCHAR(16) NOT NULL,  -- 'tokens' | 'cost' | 'requests'
  window         INTERVAL NOT NULL,     -- '5 hours', '1 day', '7 days'
  max_value      DECIMAL NOT NULL,
  action         VARCHAR(16) NOT NULL DEFAULT 'reject', -- 'reject' | 'throttle' | 'notify'
  enabled        BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 速率限制配置（实际执行在 Gateway 内存中用滑动窗口）
CREATE TABLE rate_limits (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type    VARCHAR(8) NOT NULL,   -- 'user' | 'client'
  target_id      UUID NOT NULL,
  max_rpm        INT NOT NULL,          -- 每分钟最大请求数
  max_rph        INT,                   -- 每小时最大请求数（可选）
  enabled        BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.4 计费 & 账单

两种计费模式并行：
- **Token 计费** — 按模型单价实时计算每个客户端的费用
- **成本均摊** — 管理员设定每日固定成本，按各用户用量比例分摊

```sql
-- 模型单价表
CREATE TABLE model_pricing (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_pattern    VARCHAR(64) NOT NULL,
  input_mtok       DECIMAL(10,4) NOT NULL,  -- $/1M input tokens
  output_mtok      DECIMAL(10,4) NOT NULL,
  cache_read_mtok  DECIMAL(10,4) NOT NULL DEFAULT 0,
  cache_write_mtok DECIMAL(10,4) NOT NULL DEFAULT 0,
  effective_from   DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(model_pattern, effective_from)
);

-- 每日固定成本（管理员设定）
CREATE TABLE daily_costs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date           DATE UNIQUE NOT NULL,
  amount         DECIMAL(10,2) NOT NULL,
  note           VARCHAR(255),
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 月度账单
CREATE TABLE invoices (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id),
  period_start     DATE NOT NULL,
  period_end       DATE NOT NULL,
  original_amount  DECIMAL(10,2),          -- 折扣前金额
  coupon_id        UUID,                   -- 使用的优惠券
  coupon_amount    DECIMAL(10,2) DEFAULT 0,
  discount_rate    DECIMAL(3,2) DEFAULT 1.0,
  token_credit_used BIGINT DEFAULT 0,      -- 赠送 token 抵扣量
  total_due        DECIMAL(10,2) NOT NULL,
  status           VARCHAR(16) NOT NULL DEFAULT 'draft', -- 'draft' | 'issued' | 'paid' | 'overdue'
  due_date         DATE,
  issued_at        TIMESTAMPTZ,
  paid_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 账单明细行
CREATE TABLE invoice_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     UUID NOT NULL REFERENCES invoices(id),
  type           VARCHAR(8) NOT NULL,  -- 'token' | 'share'

  -- token 类型
  model          VARCHAR(64),
  input_tokens   BIGINT,
  output_tokens  BIGINT,
  unit_cost      DECIMAL(10,6),
  subtotal       DECIMAL(10,4),

  -- share 类型
  total_cost     DECIMAL(10,4),
  user_tokens    BIGINT,
  all_tokens     BIGINT,
  share_ratio    DECIMAL(5,4),

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.5 支付

```sql
CREATE TABLE payments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     UUID NOT NULL REFERENCES invoices(id),
  user_id        UUID NOT NULL REFERENCES users(id),
  amount         DECIMAL(10,2) NOT NULL,
  provider       VARCHAR(16) NOT NULL DEFAULT 'epay',
  trade_no       VARCHAR(64),          -- 易支付交易号
  out_trade_no   VARCHAR(64) UNIQUE,   -- 商户订单号
  status         VARCHAR(16) NOT NULL DEFAULT 'pending', -- 'pending' | 'paid' | 'failed'
  paid_at        TIMESTAMPTZ,
  raw_callback   JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.6 通知 & Webhook

```sql
CREATE TABLE notifications (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id),
  type           VARCHAR(16) NOT NULL,  -- 'quota_warn' | 'invoice' | 'payment' | 'system' | 'suspend'
  title          VARCHAR(255) NOT NULL,
  content        TEXT,
  read           BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_configs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id),
  url            VARCHAR(512) NOT NULL,
  secret         VARCHAR(128),
  events         TEXT[] NOT NULL,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.7 邀请 & 活动

```sql
-- 活动/推广计划
CREATE TABLE campaigns (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(128) NOT NULL,
  type             VARCHAR(16) NOT NULL,  -- 'invite' | 'promo'
  status           VARCHAR(16) NOT NULL DEFAULT 'active', -- 'active' | 'paused' | 'expired'
  start_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  end_at           TIMESTAMPTZ,
  max_uses         INT,
  current_uses     INT NOT NULL DEFAULT 0,
  invite_required  BOOLEAN NOT NULL DEFAULT false,
  code_prefix      VARCHAR(16),
  codes_per_user   INT NOT NULL DEFAULT 5,
  bind_window      INTERVAL NOT NULL DEFAULT '5 days',
  inviter_rewards  JSONB,   -- 奖励配置数组
  invitee_rewards  JSONB,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 邀请码
CREATE TABLE invite_codes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    UUID NOT NULL REFERENCES campaigns(id),
  owner_id       UUID NOT NULL REFERENCES users(id),
  code           VARCHAR(16) UNIQUE NOT NULL,
  max_uses       INT NOT NULL DEFAULT 1,
  used_count     INT NOT NULL DEFAULT 0,
  status         VARCHAR(16) NOT NULL DEFAULT 'active', -- 'active' | 'exhausted' | 'revoked'
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 邀请关系
CREATE TABLE invite_bindings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_code_id UUID NOT NULL REFERENCES invite_codes(id),
  inviter_id     UUID NOT NULL REFERENCES users(id),
  invitee_id     UUID NOT NULL REFERENCES users(id),
  status         VARCHAR(16) NOT NULL DEFAULT 'bound', -- 'bound' | 'rewarded'
  bound_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(invitee_id)  -- 一个用户只能被邀请一次
);

-- 已发放的奖励
CREATE TABLE rewards (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id),
  campaign_id    UUID REFERENCES campaigns(id),
  binding_id     UUID REFERENCES invite_bindings(id),
  type           VARCHAR(16) NOT NULL,  -- 'coupon' | 'tokens' | 'free_days' | 'discount'
  status         VARCHAR(16) NOT NULL DEFAULT 'active', -- 'active' | 'used' | 'expired'
  coupon_id      UUID,
  token_amount   BIGINT,
  token_remaining BIGINT,
  free_until     DATE,
  discount_rate  DECIMAL(3,2),
  discount_periods_left INT,
  expires_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 优惠券
CREATE TABLE coupons (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id),
  code           VARCHAR(32) UNIQUE NOT NULL,
  amount         DECIMAL(10,2) NOT NULL,
  min_order      DECIMAL(10,2) NOT NULL DEFAULT 0,
  status         VARCHAR(16) NOT NULL DEFAULT 'unused', -- 'unused' | 'used' | 'expired'
  used_at        TIMESTAMPTZ,
  used_on_invoice UUID REFERENCES invoices(id),
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 3. API Server 接口设计

### 3.1 认证

```
POST   /api/auth/register          注册 (username, email, password, invite_code?)
POST   /api/auth/login             登录 → JWT access + refresh
POST   /api/auth/refresh           刷新 access token
POST   /api/auth/logout            登出
GET    /api/auth/me                当前用户信息
PATCH  /api/auth/me                更新个人信息
POST   /api/auth/forgot-password   忘记密码
POST   /api/auth/reset-password    重置密码
```

### 3.2 客户端管理

```
GET    /api/clients                我的客户端列表 (user) / 所有客户端 (admin)
POST   /api/clients                创建客户端 → 生成 token
GET    /api/clients/:id            客户端详情
PATCH  /api/clients/:id            更新客户端
DELETE /api/clients/:id            删除客户端
POST   /api/clients/:id/suspend    停用
POST   /api/clients/:id/activate   激活
GET    /api/clients/:id/launcher   下载 launcher 脚本

GET    /api/admin/clients/pending          待审核列表
POST   /api/admin/clients/:id/approve      审核通过
POST   /api/admin/clients/:id/reject       审核拒绝
```

### 3.3 用量统计

```
GET    /api/usage/summary          用量摘要 (?range=today|7d|30d|custom&from=&to=)
GET    /api/usage/timeline         用量时间线 (?range=7d&granularity=hour|day)
GET    /api/usage/records          用量明细 (?client_id=&page=1&limit=50)

GET    /api/admin/usage/overview   全局用量概览
GET    /api/admin/usage/ranking    用户用量排行
```

### 3.4 额度 & 限制

```
GET    /api/quotas                 我的额度规则
GET    /api/quotas/status          我的额度消耗状态

GET    /api/admin/quotas           所有额度规则
POST   /api/admin/quotas           创建
PATCH  /api/admin/quotas/:id       修改
DELETE /api/admin/quotas/:id       删除
GET    /api/admin/rate-limits      所有速率限制
POST   /api/admin/rate-limits      创建
PATCH  /api/admin/rate-limits/:id  修改
DELETE /api/admin/rate-limits/:id  删除
```

### 3.5 计费 & 账单

```
GET    /api/invoices               我的账单列表
GET    /api/invoices/:id           账单详情 (含 invoice_items)

POST   /api/admin/invoices/generate       手动生成当月账单
GET    /api/admin/daily-costs             每日成本记录
POST   /api/admin/daily-costs             设置每日成本
PATCH  /api/admin/daily-costs/:id         修改
GET    /api/admin/model-pricing           模型价格表
POST   /api/admin/model-pricing           添加
PATCH  /api/admin/model-pricing/:id       修改
```

### 3.6 支付

```
POST   /api/payments/create        发起支付 (invoice_id) → { pay_url, out_trade_no }
POST   /api/payments/notify        易支付异步回调 (验签 → 更新状态 → 恢复客户端)
GET    /api/payments/return        易支付同步跳转 → 重定向 Dashboard
GET    /api/payments               我的支付记录
```

### 3.7 通知 & Webhook

```
GET    /api/notifications          通知列表 (?unread=true)
PATCH  /api/notifications/:id/read 标记已读
POST   /api/notifications/read-all 全部标记已读
GET    /api/notifications/count    未读数量
POST   /api/admin/notifications/broadcast 群发通知

GET    /api/webhooks               我的 Webhook 列表
POST   /api/webhooks               创建
PATCH  /api/webhooks/:id           修改
DELETE /api/webhooks/:id           删除
POST   /api/webhooks/:id/test      测试
```

### 3.8 邀请 & 活动

```
GET    /api/admin/campaigns              活动列表
POST   /api/admin/campaigns              创建活动 (含奖励配置 JSONB)
PATCH  /api/admin/campaigns/:id          修改活动
GET    /api/admin/campaigns/:id/stats    活动数据统计

GET    /api/invite-codes                 我的邀请码列表
POST   /api/invite-codes                 生成邀请码
GET    /api/invite-codes/:code/info      查询邀请码信息

POST   /api/invite/bind                  绑定邀请码 (注册时或5天内)
GET    /api/invite/records               我的邀请记录

GET    /api/rewards                      我的奖励列表
GET    /api/coupons                      我的优惠券列表
POST   /api/coupons/:id/apply            使用优惠券
```

### 3.9 系统管理

```
GET    /api/admin/users             用户列表
PATCH  /api/admin/users/:id         修改用户 (角色/状态)
GET    /api/admin/system/stats      系统状态
GET    /api/admin/system/gateway    Gateway 健康检查
POST   /api/admin/system/reload     通知 Gateway 热加载配置
```

---

## 4. Gateway 改造

在现有代理流程中增加三个环节：

### 4.1 请求路径

```
Auth → RateLimit → QuotaCheck → Rewrite → Upstream → ExtractUsage → WriteToDB → StreamToClient
```

新增步骤：
- **RateLimit** — 内存中滑动窗口计数器，配置从 PG rate_limits 表热加载
- **QuotaCheck** — 查 PG 当前窗口内已用量 vs quota_rules.max_value，超限按 action 处理
- **ExtractUsage** — 从 upstream 响应中提取 `usage` 字段（input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens）
- **WriteToDB** — 按 model_pricing 计算 cost，写入 usage_records

### 4.2 热加载

Gateway 启动时和每 30 秒从 PG 同步：
- `clients` → 内存 token map（认证用）
- `rate_limits` → 内存速率限制配置
- `quota_rules` → 内存额度配置
- `users.free_until` / `rewards.token_remaining` → 免费/赠送额度判断

PG NOTIFY channel `gateway_reload` 可触发即时同步。

### 4.3 客户端状态检查

认证通过后检查：
- `client.status != 'active'` → 403
- `user.status != 'active'` → 403

被停用的客户端请求直接拒绝，无需等下一次热加载周期。

---

## 5. Web Dashboard

### 5.1 技术栈

- React 19 + Vite
- React Router v7
- Tailwind CSS（Apple HIG 自定义 theme）
- Recharts（图表）
- Zustand（状态管理）
- 亮色主题优先，可选暗色

### 5.2 设计规范

- **配色：** Blue #007aff, Green #34c759, Orange #ff9500, Purple #af52de, Red #ff3b30
- **背景层级：** 页面底 #f5f5f7, 卡片 #ffffff, 侧栏 #fafafa
- **字体：** SF Pro / Inter / system-ui，标题 600 weight -0.5px tracking，数字 tabular-nums
- **圆角：** 卡片 14px, 按钮/输入框 10px, 标签 5px
- **风格：** 克制、留白、无渐变发光，信息密度适中，字重/色深建立层级

### 5.3 页面清单

**公开页面 (3页)：**
- 注册页（左侧品牌介绍 + 右侧表单，邀请码可选填）
- 登录页（居中卡片式）
- 忘记密码

**用户引导 (3页)：**
- 创建客户端（三步进度条）
- 等待审核（可补填邀请码）
- 审核通过（下载 Launcher + 快速开始）

**管理员页面 (9页)：**
- Dashboard 概览（4 指标卡片 + 用量趋势图 + Token 构成环形图 + 客户端用量表）
- 用量分析（图表 + 多维筛选）
- 客户端管理（含审核队列）
- 用户管理
- 额度 & 限制规则
- 账单管理
- 每日成本 & 模型定价
- 活动管理（campaigns CRUD + 数据统计）
- 系统设置（通知/Webhook）

**用户页面 (7页)：**
- 概览（用量/费用/额度 + 待付账单提醒）
- 我的客户端（创建/下载 launcher）
- 用量统计（图表 + 请求明细表，展示 Input/Output/Cache Read/Cache Write 四列）
- 请求详情展开（每种 token 的数量/单价/费用 + 费用构成横条图 + 缓存命中率）
- 账单 & 支付
- 邀请好友（邀请码管理 + 邀请记录）
- 我的奖励（优惠券/额度/折扣卡片）

---

## 6. 支付流程

### 6.1 月度账单生成

每月 1 日定时任务：
1. 查询上月所有用户的 usage_records
2. 按模型聚合，结合 model_pricing 生成 token 类型的 invoice_items
3. 汇总 daily_costs，按用户 token 占比生成 share 类型的 invoice_items
4. 扣除赠送 token 额度（rewards.token_remaining）
5. 应用账单折扣（rewards.discount_rate）
6. 生成 invoice，status = 'issued'，due_date = 当月 15 日
7. 通知用户（Dashboard + Webhook）

### 6.2 支付

1. 用户选择账单，可选使用优惠券
2. POST /api/payments/create → 生成商户订单号，调用易支付 API 获取支付 URL
3. 用户跳转易支付完成付款
4. 易支付异步回调 POST /api/payments/notify → 验签 → 更新 payment.status = 'paid'
5. 更新 invoice.status = 'paid'
6. 如该用户所有 overdue 账单已清，自动恢复被停用的客户端

### 6.3 欠费停用

1. 账单到期未付 → invoice.status = 'overdue'
2. 发送通知 + Webhook
3. 宽限期（可配置，默认 3 天）后自动停用该用户所有客户端
4. client.status = 'suspended'，suspend_reason = 'unpaid'
5. 付款后自动恢复

---

## 7. 邀请 & 活动系统

### 7.1 活动配置

管理员创建 campaign，通过 JSONB 配置奖励规则：

```json
{
  "inviter_rewards": [
    { "type": "coupon", "amount": 10, "min_order": 0, "valid_days": 30 },
    { "type": "tokens", "amount": 500000, "valid_days": 30 }
  ],
  "invitee_rewards": [
    { "type": "coupon", "amount": 10, "min_order": 0, "valid_days": 30 },
    { "type": "tokens", "amount": 500000, "valid_days": 30 }
  ]
}
```

四种奖励类型：
- **coupon** — 优惠券，支付账单时选择使用，直接抵扣金额
- **tokens** — 额度赠送，使用赠送 token 时不计入账单费用
- **free_days** — 免费天数，free_until 内的用量不生成账单
- **discount** — 账单折扣，下 N 期账单自动打折

### 7.2 邀请流程

1. 管理员创建活动，配置奖励
2. 用户在设置页生成个人邀请码（受 codes_per_user 限制）
3. 分享邀请码
4. 被邀请人注册时填写，或注册后 5 天内补填（bind_window = '5 days'）
5. 系统验证：注册时间 < 5天 / 未绑定过 / 邀请码有效 / 邀请人 ≠ 自己
6. 创建 invite_binding，按活动配置向双方发放奖励

---

## 8. 注册流程

```
用户                        系统                        管理员
 │                           │                           │
 ├─ POST /api/auth/register ▶│                           │
 │   {username, email,       ├─ 创建 user                │
 │    password, invite_code?}│                           │
 │                           ├─ 如有邀请码:              │
 │                           │   验证 → binding → 奖励   │
 │                           │                           │
 ├─ 引导: 创建客户端 ──────▶│                           │
 │                           ├─ 创建 client (pending)    │
 │                           ├─ 通知管理员 ─────────────▶│
 │                           │                           │
 │  等待审核 (可补填邀请码)  │                    approve │
 │                           │◀─────────────────────────┤
 │                           ├─ client.status = active   │
 │◀── 通知审核通过 ─────────┤                           │
 │                           │                           │
 ├─ GET /clients/:id/launcher│                           │
 │◀── 下载 cc-{name} 脚本 ──┤                           │
 │                           │                           │
 ├─ chmod +x && ccg ────────▶│ Gateway 热加载识别 token  │
```

---

## 9. 项目结构

```
cc-gateway/
├── src/                      # ① Gateway (现有 + 扩展)
│   ├── index.ts
│   ├── proxy.ts              # + RateLimit, QuotaCheck, ExtractUsage
│   ├── rewriter.ts
│   ├── auth.ts               # 改为从 PG 读取 token map
│   ├── oauth.ts
│   ├── db.ts                 # NEW: PG 连接池
│   ├── metering.ts           # NEW: 用量计量 + 写入
│   ├── rate-limiter.ts       # NEW: 滑动窗口速率限制
│   ├── quota-checker.ts      # NEW: 额度检查
│   └── sync.ts               # NEW: PG 热加载同步
│
├── server/                   # ② API Server
│   ├── index.ts
│   ├── app.ts                # Express/Hono app
│   ├── db.ts                 # PG 连接池
│   ├── middleware/
│   │   ├── auth.ts           # JWT 验证
│   │   └── admin.ts          # 管理员权限
│   ├── routes/
│   │   ├── auth.ts
│   │   ├── clients.ts
│   │   ├── usage.ts
│   │   ├── quotas.ts
│   │   ├── invoices.ts
│   │   ├── payments.ts
│   │   ├── notifications.ts
│   │   ├── webhooks.ts
│   │   ├── campaigns.ts
│   │   ├── invites.ts
│   │   └── admin.ts
│   ├── services/
│   │   ├── billing.ts        # 账单生成逻辑
│   │   ├── payment.ts        # 易支付集成
│   │   ├── notification.ts   # 通知 + Webhook 推送
│   │   ├── reward.ts         # 奖励发放
│   │   └── launcher.ts       # Launcher 脚本生成
│   └── jobs/
│       ├── invoice-generator.ts  # 月度账单定时任务
│       └── overdue-checker.ts    # 欠费检查定时任务
│
├── web/                      # ③ React Frontend
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── router.tsx
│   │   ├── stores/           # Zustand
│   │   ├── api/              # API 调用封装
│   │   ├── components/       # 通用组件
│   │   ├── layouts/
│   │   │   ├── AuthLayout.tsx
│   │   │   └── DashboardLayout.tsx
│   │   └── pages/
│   │       ├── auth/         # 登录/注册/忘记密码
│   │       ├── onboarding/   # 创建客户端/等待审核/审核通过
│   │       ├── dashboard/    # 概览
│   │       ├── clients/      # 客户端管理
│   │       ├── usage/        # 用量统计 + 请求明细
│   │       ├── billing/      # 账单 & 支付
│   │       ├── invite/       # 邀请好友
│   │       ├── rewards/      # 我的奖励
│   │       └── admin/        # 管理员页面
│   └── public/
│
├── migrations/               # PG 迁移文件
├── config.yaml
├── package.json
└── docker-compose.yml        # Gateway + API Server + PG + Frontend
```
