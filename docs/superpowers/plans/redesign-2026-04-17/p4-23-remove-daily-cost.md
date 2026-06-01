# Remove Daily Cost Implementation Plan — `feat/remove-daily-cost`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清理旧的"每日成本"页面、路由、后端 endpoint、Dashboard 中的 daily-cost 卡片 — 这些已由 `/admin/metrics` 与 `/admin/plans` tab B 全面替代。

**Architecture:**
- 前端：删除 `AdminCostsPage`（或在 `AdminPages.tsx` 中的 costs 相关导出）；移除旧 `/admin/costs` 路由；移除老 Dashboard 中的 daily-cost 组件。
- 后端：删除 `/admin/costs`、`/admin/daily-costs` 之类 endpoint；保留 `usage_records` 表不动（仍被 admin-metrics 使用）。
- i18n / 导航：清理孤立 key。

**Tech Stack:** 纯删除 + grep 穷尽。

---

## 约束

1. **穷尽 grep** — 所有 `daily_cost`, `DailyCost`, `AdminCosts`, `/admin/costs`, `/api/admin/costs` 的引用必须零残留。
2. **不动 `usage_records` 数据表**（metrics 和 usage 都还用）。
3. 禁 emoji、禁渐变色、禁 PR。

---

## 文件结构

**Delete:**
- `web/src/pages/admin/AdminPages.tsx` 中的 `AdminCostsPage` 导出（若独立文件则整文件删）
- `server/src/routes/` 下 costs 相关 handler（在 `admin.ts` 内则删对应 block）

**Modify:**
- `web/src/router.tsx` — 去掉 `/admin/costs` 路由
- `web/src/layouts/AppShell.tsx` — 去掉对应 nav 项（p1-03 已去，但 grep 确认）
- `web/src/i18n/*` — 清理 daily-cost 相关翻译

---

## Task 1: 清理前切分支 + 穷尽定位

- [ ] **Step 1**:

```bash
cd /path/to/cc-gateway
git checkout main && git pull && git checkout -b feat/remove-daily-cost
```

- [ ] **Step 2**: 列出所有需要处理的点

Run: `Grep` pattern `daily_cost|DailyCost|admin/costs|AdminCosts|/admin/costs|costs\.ts|\\bcosts\\b` in repo → 把结果列成 checklist（每一条一个 TODO）。

- [ ] **Step 3**: 按 checklist 逐条处理

对每一条：
- 前端组件：删除；如被引用，替换为 metrics/plans 的等价
- 后端 handler：删除整块 router.xxx
- i18n key：删除 entry
- 路由：删除 Route 和 import

- [ ] **Step 4**: 再次 grep 确认零残留

Run: `Grep` pattern `daily_cost|DailyCost|AdminCosts|/admin/costs` → Expected 空结果

- [ ] **Step 5**: 提交

```bash
git add -A
git commit -m "refactor: remove legacy daily-cost pages and endpoints"
```

---

## Task 2: 验证回归

- [ ] **Step 1**: 本地 build

```bash
cd web && npm run build
cd ../server && npx tsc --noEmit
```

Expected: 0 错误。

- [ ] **Step 2**: 跑现有测试

```bash
cd /path/to/cc-gateway
for t in tests/*.test.ts; do npx tsx "$t" || exit 1; done
```

Expected: 全部 OK。

- [ ] **Step 3**: 部署到 gwbk 并手测

```bash
./scripts/deploy-gwbk.sh
```

- 访问 `/admin` → OK
- 访问 `/admin/metrics` → 展示了之前 daily-cost 类似的数据
- 访问 `/admin/plans` 的 pricing tab → 单价编辑可用
- 搜索浏览器控制台 → 无 404 / 无 undefined import 警告

---

## Task 3: 合并到 main

```bash
git fetch origin main && git rebase origin/main
git checkout main && git merge --no-ff feat/remove-daily-cost -m "merge: feat/remove-daily-cost"
git push origin main
```

**这是 23 条分支里的最后一条。合并后，redesign-2026-04-17 的工作全部完成，`gwbk.example.com` 提供的就是最终的新 UI + 新数据模型；随后做一次 gw→gwbk 切换，或用 DNS 切到 gwbk 即可切流。**
