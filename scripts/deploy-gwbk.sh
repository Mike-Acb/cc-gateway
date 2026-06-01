#!/usr/bin/env bash
# scripts/deploy-gwbk.sh — one-shot deploy of the current branch to gwbk.example.com
#
# Steps:
#   1. rsync source tree to remote (excluding build artefacts, creds, node_modules)
#   2. remote npm install + web build
#   3. copy web/dist to OpenResty static root
#   4. install PM2 ecosystem config
#   5. apply all migrations (idempotent: IF NOT EXISTS)
#   6. pm2 startOrReload + save
#
# Requires pubkey SSH access to root@1.2.3.4.
set -euo pipefail

REMOTE=root@1.2.3.4
REMOTE_DIR=/home/ubuntu/gwbk
# Host-side path. OpenResty runs in docker with /opt/1panel/www mounted as /www,
# so the vhost's `root /www/sites/gwbk.example.com/index;` reads from here.
WEB_ROOT=/opt/1panel/www/sites/gwbk.example.com/index

# Safety guard: refuse to run against an unexpected remote dir. This is the
# last line of defence before `rm -rf "$WEB_ROOT"/*` and similar destructive
# ops run on the remote.
case "$REMOTE_DIR" in
  /home/ubuntu/gwbk|/home/ubuntu/gwbk/*) ;;
  *)
    echo "refusing to deploy: REMOTE_DIR='$REMOTE_DIR' is not under /home/ubuntu/gwbk" >&2
    exit 1
    ;;
esac
case "$WEB_ROOT" in
  /opt/1panel/www/sites/gwbk.example.com/*) ;;
  *)
    echo "refusing to deploy: WEB_ROOT='$WEB_ROOT' is not under /opt/1panel/www/sites/gwbk.example.com" >&2
    exit 1
    ;;
esac

echo "[0/6] kill stale ubuntu-owned tsx processes under /home/ubuntu/gwbk (NOT touching /gw, NOT touching root-owned PM2 procs)"
# 2026-05-11 踩坑:5/9 由 ubuntu 用户起的孤儿 tsx 进程占着 3001 端口持续 2 天,
# PM2 重启 root 进程显示 online 但实际 TCP 监听者仍是旧进程。
#
# 关键约束:
#   - 只杀 user=ubuntu 的进程(-u ubuntu),不动 root 的 PM2 受控进程
#   - 路径锁死 /home/ubuntu/gwbk/,prod 的 /home/ubuntu/gw/ 不动
#   - 用 pgrep 显式列 PID 再 kill,避免 pkill -f 误匹配到 ssh wrapper 自己
#     (上一版直接 pkill -9 -f 会 kill 掉远端 sshd 子进程,deploy 脚本立即中断)
# pgrep 没匹配会返回 1,|| true 保证脚本继续。
ssh "$REMOTE" '
  pids=$(pgrep -u ubuntu -f "/home/ubuntu/gwbk/.*tsx" 2>/dev/null || true)
  pids2=$(pgrep -u ubuntu -f "/home/ubuntu/gwbk/.*src/index.ts" 2>/dev/null || true)
  all=$(echo "$pids $pids2" | tr " " "\n" | sort -u | grep -E "^[0-9]+$" || true)
  if [ -n "$all" ]; then
    echo "  killing ubuntu-owned stale procs: $(echo $all | tr "\n" " ")"
    echo "$all" | xargs -r kill -9 2>/dev/null || true
    sleep 1
  else
    echo "  no stale ubuntu-owned procs found"
  fi
'

echo "[1/6] rsync source -> $REMOTE:$REMOTE_DIR"
# --no-owner/--no-group: 不要把本地 macOS 的 501:staff 推到服务器,
# 否则 ubuntu 用户无法写 logs/,PM2 起不来 (EACCES)。
rsync -avz --no-owner --no-group \
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
  --exclude='.worktrees/' \
  --exclude='/logs/' \
  -e "ssh -o StrictHostKeyChecking=no" \
  ./ "${REMOTE}:${REMOTE_DIR}/"

echo "[2/6] remote npm install + build"
ssh "$REMOTE" "cd \"${REMOTE_DIR}\" && npm install && cd server && npm install && cd ../web && npm install && npm run build"

echo "[3/6] copy frontend static to OpenResty root"
# ${WEB_ROOT:?...} expansion aborts if WEB_ROOT is somehow empty, so we
# never accidentally evaluate to `rm -rf /*`.
ssh "$REMOTE" "mkdir -p \"${WEB_ROOT:?WEB_ROOT must be set}\" && rm -rf \"${WEB_ROOT}\"/* && cp -r \"${REMOTE_DIR}\"/web/dist/* \"${WEB_ROOT}\"/"

echo "[4/6] install PM2 ecosystem"
ssh "$REMOTE" "cp \"${REMOTE_DIR}/scripts/gwbk-ecosystem.config.cjs\" \"${REMOTE_DIR}/ecosystem.config.cjs\""

echo "[5/6] run DB migrations (idempotent)"
ssh "$REMOTE" "cd \"${REMOTE_DIR}\" && for f in migrations/*.sql; do echo \"  apply \$f\"; PGPASSWORD=change-me-password psql -h 127.0.0.1 -U cc_gateway -d cc_gateway_bk -f \"\$f\" >/dev/null; done"

echo "[6/6] PM2 restart (or start if first time)"
# Hard restart: pm2 startOrReload 在某些场景下 reload 计数 +1 但 pid 不真换,
# 导致新代码不生效(实测多次:本地源码改了、deploy 输出"deployed to",但事故时
# log 显示跑的还是旧逻辑)。改用 delete+start 强制杀进程 + 起新,确保新代码上线。
# 副作用:in-flight 请求会被中断 — 配合 src/index.ts 的 SIGINT flushInflightLogs
# 把它们标 'gateway_shutdown:SIGINT' 防 db row 卡 NULL。
ssh "$REMOTE" "cd \"${REMOTE_DIR}\" && pm2 delete gateway-bk api-server-bk 2>/dev/null; pm2 start ecosystem.config.cjs && pm2 save"

echo ""
echo "deployed to https://gwbk.example.com"
ssh "$REMOTE" "pm2 list | grep -E 'gateway-bk|api-server-bk'"
