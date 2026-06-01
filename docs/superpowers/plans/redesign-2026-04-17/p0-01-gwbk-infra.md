# P0 · #1 feat/gwbk-infra Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `gwbk.example.com` 从单进程老版本（只有网关）升成完整的三件套栈（gateway-bk + api-server-bk + 前端静态），并和生产 `gw.example.com` 做数据软隔离。所有后续分支的部署都依赖本分支完成。

**Architecture:** 不新增任何业务逻辑。只做：复用现有代码库，在 `/home/ubuntu/gwbk/` 重建完整目录；新增 PM2 `api-server-bk` 进程（端口 `3001`）+ 保留 `gateway-bk`（端口 `8444`）；OpenResty `gwbk.example.com.conf` 追加 `/api/` 与 `/v1/` 反代；同库 `cc_gateway` 下所有 `users` / `clients` / `oauth_accounts` 加 `deployment VARCHAR(16) DEFAULT 'gw'` 软隔离列；写一条 `scripts/deploy-gwbk.sh` 一键脚本。

**Tech Stack:** bash / SSH / rsync / PM2 / OpenResty (Nginx) / PostgreSQL / 1Panel。

**Prereqs:** 能 SSH 到 `root@1.2.3.4`（已配置 pubkey）；1Panel 管理 OpenResty；`gwbk.example.com` 站点和 TLS 已经在 1Panel 侧就绪。

---

## File Structure

**Create:**
- `scripts/deploy-gwbk.sh` — 一键 rsync + 远程 build + 复制静态 + 重启 PM2
- `scripts/gwbk-ecosystem.config.cjs` — 生产 gwbk 使用的 PM2 配置（两个进程）
- `migrations/013_deployment_tag.sql` — 加 `deployment` 列
- `docs/superpowers/plans/redesign-2026-04-17/p0-01-NOTES.md` — 部署过程笔记（SSH 操作清单）

**Modify:**
- `server/src/db.ts`（或 `server/src/middleware/*`）— 加一条 `DEPLOYMENT` 常量，所有写入 `users` / `clients` / `oauth_accounts` 自动填
- `server/src/app.ts` — 注入一条 `whereDeployment()` helper 的 SELECT 过滤，应用到所有用户/账号/客户端查询
- `.env.example` — 加 `DEPLOYMENT=gw`（默认）/`DEPLOYMENT=gwbk`

**Remote (via SSH, not in git):**
- `/home/ubuntu/gwbk/` — 完整目录（rsync 推送）。约定对齐 prod `/home/ubuntu/gw`；`scripts/deploy-gwbk.sh` 和 `scripts/gwbk-ecosystem.config.cjs` 都 hardcode 这个路径，且 deploy 脚本启动前会做 `case` 白名单校验，不允许指向其他路径。
- `/opt/1panel/www/sites/gwbk.example.com/proxy/app.conf` — OpenResty 反代片段
- PM2：新增 `api-server-bk`，保留 `gateway-bk`

---

## Tasks

### Task 1 · 侦察远程当前状态并落笔记

**Files:**
- Create: `docs/superpowers/plans/redesign-2026-04-17/p0-01-NOTES.md`

- [ ] **Step 1: SSH 上服务器摸家底**

Run:
```bash
ssh root@1.2.3.4 "ls /home/ubuntu/gwbk/; pm2 list; cat /opt/1panel/www/conf.d/gwbk.example.com.conf; ls /opt/1panel/www/sites/gwbk.example.com/"
```

Expected：看到 gwbk 目录只有网关（没有 `server/` 和 `web/`），PM2 只有 `gateway-bk`，nginx conf `include /www/sites/gwbk.example.com/proxy/*.conf` 指向的目录为空。

- [ ] **Step 2: 把现状写进 NOTES.md**

文件内容骨架：

```markdown
# gwbk 部署现状（2026-04-17 摸底）

## 已就绪
- 1Panel 站点 `gwbk.example.com` + TLS（`/www/sites/gwbk.example.com/ssl/`）
- 代码目录 `/home/ubuntu/gwbk/` 有老版网关（仅 `src/`）
- PM2 `gateway-bk` 正在运行
- OpenResty conf `/opt/1panel/www/conf.d/gwbk.example.com.conf` 反代 include 目录 `/www/sites/gwbk.example.com/proxy/*.conf`（空）

## 需要补齐
- `server/` 子目录（API server）
- `web/` 子目录（前端源码）+ 构建到 `/www/sites/gwbk.example.com/index/`
- PM2 新增 `api-server-bk` :3001
- gateway-bk 端口从当前确认后改成 `8444`（避免与 `gw` 的 `8443` 冲突）
- OpenResty 反代配置片段
```

- [ ] **Step 3: Commit 笔记**

```bash
git add docs/superpowers/plans/redesign-2026-04-17/p0-01-NOTES.md
git commit -m "docs: gwbk deployment recon notes"
```

---

### Task 2 · 新增 `deployment` 软隔离列

**Files:**
- Create: `migrations/013_deployment_tag.sql`

- [ ] **Step 1: 写 migration**

```sql
-- 013_deployment_tag.sql — 为 users/clients/oauth_accounts 加 deployment 软隔离列

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deployment VARCHAR(16) NOT NULL DEFAULT 'gw';
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS deployment VARCHAR(16) NOT NULL DEFAULT 'gw';
ALTER TABLE oauth_accounts
  ADD COLUMN IF NOT EXISTS deployment VARCHAR(16) NOT NULL DEFAULT 'gw';

CREATE INDEX IF NOT EXISTS idx_users_deployment         ON users (deployment);
CREATE INDEX IF NOT EXISTS idx_clients_deployment       ON clients (deployment);
CREATE INDEX IF NOT EXISTS idx_oauth_accounts_deploy    ON oauth_accounts (deployment);

COMMIT;
```

- [ ] **Step 2: 本地 dev 库跑一次**

```bash
psql -h 127.0.0.1 -U cc_gateway -d cc_gateway -f migrations/013_deployment_tag.sql
```

Expected：`COMMIT` 无报错；`\d users` 看到 `deployment` 列。

- [ ] **Step 3: Commit**

```bash
git add migrations/013_deployment_tag.sql
git commit -m "feat(db): add deployment column for gwbk soft isolation"
```

---

### Task 3 · 后端读 `DEPLOYMENT` 环境变量 + 写入自动填

**Files:**
- Modify: `server/src/db.ts`（或其他合适的顶层配置）

- [ ] **Step 1: 在 db.ts 导出常量**

在 `server/src/db.ts` 顶部追加：

```ts
export const DEPLOYMENT = (process.env.DEPLOYMENT ?? 'gw').trim()
if (!['gw', 'gwbk'].includes(DEPLOYMENT)) {
  throw new Error(`Invalid DEPLOYMENT="${DEPLOYMENT}"; must be 'gw' or 'gwbk'`)
}
console.log(`[db] deployment tag: ${DEPLOYMENT}`)
```

- [ ] **Step 2: 改所有 INSERT 语句带上 deployment**

Grep 定位：

```bash
grep -rn "INSERT INTO users\|INSERT INTO clients\|INSERT INTO oauth_accounts" server/src/
```

对每一处：

- `INSERT INTO users (...)` → 在列清单追加 `deployment`；VALUES 追加 `$N`；参数追加 `DEPLOYMENT`
- 同样改 `clients` 和 `oauth_accounts`

示例（server/src/routes/auth.ts 注册用户时）：

```ts
// before
await query(
  `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id`,
  [email, hash, 'user']
)

// after
import { DEPLOYMENT } from '../db.js'
await query(
  `INSERT INTO users (email, password_hash, role, deployment) VALUES ($1, $2, $3, $4) RETURNING id`,
  [email, hash, 'user', DEPLOYMENT]
)
```

- [ ] **Step 3: 所有 SELECT 加 `WHERE deployment = $X`**

不要做一个全局中间件（容易漏）。逐个 route 修：

```bash
grep -rn "FROM users\|FROM clients\|FROM oauth_accounts" server/src/routes/ server/src/services/
```

对每一处，在 `WHERE` 子句加 `AND deployment = $N`（最前面的参数），用 `DEPLOYMENT` 传入。

例：

```ts
// before
await query(`SELECT id FROM users WHERE email = $1`, [email])

// after
import { DEPLOYMENT } from '../db.js'
await query(`SELECT id FROM users WHERE email = $1 AND deployment = $2`, [email, DEPLOYMENT])
```

- [ ] **Step 4: 跑现有测试，确认无回归**

```bash
cd server && npx tsx --test src/**/*.test.ts 2>&1 | tail -20
```

（如果 server 没有测试文件，跳过这步。）

- [ ] **Step 5: 本地启动 API，curl 一次 `/api/me` 确认能过**

```bash
cd server && DEPLOYMENT=gw npm run dev &
sleep 3
curl -s http://localhost:3000/api/health | jq
kill %1
```

Expected：`{"ok": true}` 或类似健康响应，无 500 报错。

- [ ] **Step 6: Commit**

```bash
git add server/src
git commit -m "feat(server): DEPLOYMENT env tag, auto-fill and filter on users/clients/oauth_accounts"
```

---

### Task 4 · 网关侧同样过滤 `deployment`

**Files:**
- Modify: `src/db.ts`（gateway 侧；复用 server 的模式，但 gateway 是独立包）
- Modify: `src/account-pool.ts`（SELECT 加 WHERE）

- [ ] **Step 1: gateway 的 `src/db.ts` 追加 DEPLOYMENT 常量**

```ts
export const DEPLOYMENT = (process.env.DEPLOYMENT ?? 'gw').trim()
```

- [ ] **Step 2: `src/account-pool.ts` 的 account 加载查询加 WHERE**

Grep：

```bash
grep -n "FROM oauth_accounts" src/*.ts
```

对每一处在 WHERE 追加 `AND deployment = $N` 并传参 `DEPLOYMENT`。

- [ ] **Step 3: 跑网关测试**

```bash
npm test
```

Expected：所有测试通过。

- [ ] **Step 4: Commit**

```bash
git add src
git commit -m "feat(gateway): honor DEPLOYMENT tag in account-pool queries"
```

---

### Task 5 · `.env.example` 记录新变量

**Files:**
- Modify: `.env.example` 或 `config.example.yaml`（看现有约定）

- [ ] **Step 1: 加 DEPLOYMENT**

在 `.env.example` 顶部加：

```
# 部署标签，必须是 'gw'（生产）或 'gwbk'（预览）
# 控制 users/clients/oauth_accounts 的软隔离
DEPLOYMENT=gw
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs(env): document DEPLOYMENT tag"
```

---

### Task 6 · 写 `scripts/gwbk-ecosystem.config.cjs`

**Files:**
- Create: `scripts/gwbk-ecosystem.config.cjs`

- [ ] **Step 1: 新文件内容**

```js
module.exports = {
  apps: [
    {
      name: 'gateway-bk',
      cwd: '/home/ubuntu/gwbk',
      script: 'node_modules/.bin/tsx',
      args: 'src/index.ts',
      env: {
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        NODE_ENV: 'production',
        PORT: '8444',
        DEPLOYMENT: 'gwbk',
      },
      watch: false,
      max_memory_restart: '500M',
      error_file: '/home/ubuntu/gwbk/logs/gateway-bk-error.log',
      out_file:   '/home/ubuntu/gwbk/logs/gateway-bk-out.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'api-server-bk',
      cwd: '/home/ubuntu/gwbk/server',
      script: 'node_modules/.bin/tsx',
      args: 'src/index.ts',
      env: {
        NODE_ENV: 'production',
        PORT: '3001',
        DEPLOYMENT: 'gwbk',
        CORS_ORIGIN: 'https://gwbk.example.com',
        // 其余 DB_*/JWT_* 从 /home/ubuntu/gwbk/server/.env 读（pm2 会自动 source）
      },
      watch: false,
      max_memory_restart: '300M',
      error_file: '/home/ubuntu/gwbk/logs/api-server-bk-error.log',
      out_file:   '/home/ubuntu/gwbk/logs/api-server-bk-out.log',
      merge_logs: true,
      time: true,
    },
  ],
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/gwbk-ecosystem.config.cjs
git commit -m "feat(deploy): PM2 ecosystem for gwbk (gateway-bk + api-server-bk)"
```

---

### Task 7 · 写 `scripts/deploy-gwbk.sh` 一键脚本

**Files:**
- Create: `scripts/deploy-gwbk.sh`

- [ ] **Step 1: 脚本内容**

```bash
#!/usr/bin/env bash
# scripts/deploy-gwbk.sh — 一键把当前分支部署到 gwbk.example.com
set -euo pipefail

REMOTE=root@1.2.3.4
REMOTE_DIR=/home/ubuntu/gwbk
WEB_ROOT=/www/sites/gwbk.example.com/index

echo "[1/6] rsync source → $REMOTE:$REMOTE_DIR"
rsync -avz \
  --exclude='config.yaml' \
  --exclude='fullchain.pem' \
  --exclude='privkey.pem' \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='.superpowers/' \
  --exclude='server/node_modules/' \
  --exclude='server/dist/' \
  --exclude='web/node_modules/' \
  --exclude='web/dist/' \
  --exclude='/clients/' \
  --exclude='.DS_Store' \
  --exclude='.claude/' \
  --exclude='logs/' \
  -e "ssh -o StrictHostKeyChecking=no" \
  ./ "$REMOTE:$REMOTE_DIR/"

echo "[2/6] remote npm install + build"
ssh "$REMOTE" "cd $REMOTE_DIR && npm install && cd server && npm install && cd ../web && npm install && npm run build"

echo "[3/6] copy frontend static to OpenResty root"
ssh "$REMOTE" "rm -rf $WEB_ROOT/* && cp -r $REMOTE_DIR/web/dist/* $WEB_ROOT/"

echo "[4/6] install PM2 ecosystem"
ssh "$REMOTE" "cp $REMOTE_DIR/scripts/gwbk-ecosystem.config.cjs $REMOTE_DIR/ecosystem.config.cjs"

echo "[5/6] run DB migrations (idempotent)"
ssh "$REMOTE" "cd $REMOTE_DIR && for f in migrations/*.sql; do echo \"  apply \$f\"; PGPASSWORD=change-me-password psql -h 127.0.0.1 -U cc_gateway -d cc_gateway -f \"\$f\" >/dev/null; done"

echo "[6/6] PM2 restart (or start if first time)"
ssh "$REMOTE" "cd $REMOTE_DIR && pm2 startOrReload ecosystem.config.cjs && pm2 save"

echo ""
echo "✓ deployed to https://gwbk.example.com"
ssh "$REMOTE" "pm2 list | grep -E 'gateway-bk|api-server-bk'"
```

- [ ] **Step 2: 加执行权限**

```bash
chmod +x scripts/deploy-gwbk.sh
```

- [ ] **Step 3: Commit**

```bash
git add scripts/deploy-gwbk.sh
git commit -m "feat(deploy): one-shot deploy-gwbk.sh"
```

---

### Task 8 · OpenResty 反代片段 + 部署一次

**Files:**
- 远端文件（非 git 跟踪）：`/www/sites/gwbk.example.com/proxy/app.conf`

- [ ] **Step 1: 在服务器上创建反代片段**

```bash
ssh root@1.2.3.4 'cat > /www/sites/gwbk.example.com/proxy/app.conf <<EOF
# API Server (gwbk)
location ^~ /api/event_logging/ {
    proxy_pass https://127.0.0.1:8444;
    proxy_ssl_verify off;
    proxy_buffering off;
}
location ^~ /api/ {
    proxy_pass http://127.0.0.1:3001;
}

# Gateway proxy
location ^~ /v1/ {
    proxy_pass https://127.0.0.1:8444;
    proxy_ssl_verify off;
    proxy_buffering off;
    proxy_read_timeout 600s;
}
location = /_health { proxy_pass https://127.0.0.1:8444; proxy_ssl_verify off; }
location = /_verify { proxy_pass https://127.0.0.1:8444; proxy_ssl_verify off; }
location ^~ /policy_limits { proxy_pass https://127.0.0.1:8444; proxy_ssl_verify off; }
location ^~ /settings { proxy_pass https://127.0.0.1:8444; proxy_ssl_verify off; }
EOF'
```

- [ ] **Step 2: 重载 OpenResty**

```bash
ssh root@1.2.3.4 "docker exec 1Panel-openresty openresty -t && docker exec 1Panel-openresty openresty -s reload"
```

Expected：`nginx: configuration file /usr/local/openresty/nginx/conf/nginx.conf test is successful`

（容器名不确定的话先 `ssh ... "docker ps | grep openresty"` 拿到。）

- [ ] **Step 3: 记录进 NOTES.md**

在 `p0-01-NOTES.md` 追加：

```markdown
## OpenResty 反代（已配置）
- 片段路径 `/www/sites/gwbk.example.com/proxy/app.conf`
- 重载命令：`docker exec <openresty-container> openresty -s reload`
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/redesign-2026-04-17/p0-01-NOTES.md
git commit -m "docs: openresty reverse-proxy for gwbk documented"
```

---

### Task 9 · 第一次部署到 gwbk + 冒烟

**Files:** 无新增，只跑脚本

- [ ] **Step 1: 执行部署脚本**

```bash
./scripts/deploy-gwbk.sh
```

Expected：6 步全绿；末尾 `pm2 list` 显示 `gateway-bk` + `api-server-bk` 都是 `online`。

- [ ] **Step 2: 冒烟 API**

```bash
curl -s https://gwbk.example.com/api/health | jq
curl -sI https://gwbk.example.com/
```

Expected：`/api/health` 返回 JSON；`/` 返回 200 + `text/html`。

- [ ] **Step 3: 冒烟 gateway**

```bash
curl -s https://gwbk.example.com/_health | jq
```

Expected：`{"pool_enabled": true, "accounts": 0, ...}` —— accounts 为 0 是对的（gwbk 还没录账号）。

- [ ] **Step 4: 浏览器打开 `https://gwbk.example.com` 肉眼确认**

前端页面能渲染登录页（现有未重构的老前端也 OK；重构后的会在 #3 `feat/nav-shell` 合并后出现）。

- [ ] **Step 5: 把冒烟结果记入 NOTES.md**

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/redesign-2026-04-17/p0-01-NOTES.md
git commit -m "docs: gwbk first deployment smoke test results"
```

---

### Task 10 · 合并到 main（或本地 fast-forward）

**Files:** 无

- [ ] **Step 1: 本地 merge**

```bash
git checkout main
git merge --no-ff feat/gwbk-infra -m "merge: feat/gwbk-infra"
```

（user 要求不创建 PR，所以直接本地合并。）

- [ ] **Step 2: 删除分支**

```bash
git branch -d feat/gwbk-infra
```

- [ ] **Step 3: 跑一次部署验证 main 分支无异常**

```bash
./scripts/deploy-gwbk.sh
```

Expected：成功。

---

## Self-Review Checklist

- ✅ Spec `Phase 0 · 基础设施` 要求全部覆盖（目录重建、PM2 双进程、反代、数据隔离、deploy 脚本）
- ✅ Migration `013_deployment_tag.sql` 编号不冲突（当前最高 012）
- ✅ `DEPLOYMENT` 环境变量在 gateway 和 server 两侧都读
- ✅ 部署脚本幂等（用 `pm2 startOrReload`，migration 用 IF NOT EXISTS）
- ✅ 端口选用 8444 / 3001 避免和 gw 的 8443 / 3000 撞

## Acceptance

1. `https://gwbk.example.com/` 返回 200（即便是空白前端也 OK）
2. `https://gwbk.example.com/api/health` 返回 JSON
3. `https://gwbk.example.com/_health` 返回 JSON（gateway）
4. `pm2 list` 在远端同时显示 `gateway`、`api-server`（gw 侧）和 `gateway-bk`、`api-server-bk`（gwbk 侧）四个进程全 online
5. 在 `gw` 库里查 `SELECT DISTINCT deployment FROM users` 只看到 `gw`（因为默认值是 gw）
6. 本分支所有 commit 已 merge 回 main
