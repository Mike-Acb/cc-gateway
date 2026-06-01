# cc-gateway Redesign · Master Plan Index

**Spec**: [docs/superpowers/specs/2026-04-17-admin-redesign-design.md](../../specs/2026-04-17-admin-redesign-design.md)
**Deploy target**: `gwbk.example.com`（与线上 `gw.example.com` 并行）
**Prototype**: `.superpowers/brainstorm/96985-1776356290/content/04-full-prototype.html`

> 23 条分支，每条一个 plan。每条可以独立 merge，PR diff ≤ 500 行，合并前在 gwbk 验证一次。

## 执行顺序

```
Phase 0: #1 (阻塞一切)
   ↓
Phase 1: #2 #3 #4 #5 #6 (#2 必须最先合)
   ↓
Phase 2 (user): #7 #8 #9 #10 #11 #12    ┐
Phase 3 (admin): #13 #14 #15 #16 #17 #18 #19 #20 #21 #22  } 两路并行
   ↓
Phase 4: #23 (清理，最后)
```

## 分支清单

### Phase 0 · 基础设施

| # | 分支 | 估时 | Plan |
|---|---|---|---|
| 1 | `feat/gwbk-infra` | 1d | [p0-01-gwbk-infra.md](p0-01-gwbk-infra.md) |

### Phase 1 · 地基

| # | 分支 | 依赖 | 估时 | Plan |
|---|---|---|---|---|
| 2 | `feat/ui-kit` | #1 | 1.5d | [p1-02-ui-kit.md](p1-02-ui-kit.md) |
| 3 | `feat/nav-shell` | #1 #2 | 0.5d | [p1-03-nav-shell.md](p1-03-nav-shell.md) |
| 4 | `feat/request-log-fields` | #1 | 1d | [p1-04-request-log-fields.md](p1-04-request-log-fields.md) |
| 5 | `feat/account-groups-backend` | #1 | 1.5d | [p1-05-account-groups-backend.md](p1-05-account-groups-backend.md) |
| 6 | `feat/audit-log-backend` | #1 | 1.5d | [p1-06-audit-log-backend.md](p1-06-audit-log-backend.md) |

### Phase 2 · 用户视角

| # | 分支 | 依赖 | 估时 | Plan |
|---|---|---|---|---|
| 7 | `feat/user-dashboard` | #2 #3 #4 #5 | 1.5d | [p2-07-user-dashboard.md](p2-07-user-dashboard.md) |
| 8 | `feat/user-usage` | #2 #3 #4 | 1d | [p2-08-user-usage.md](p2-08-user-usage.md) |
| 9 | `feat/user-logs` | #2 #3 #4 | 1d | [p2-09-user-logs.md](p2-09-user-logs.md) |
| 10 | `feat/user-clients` | #2 #3 #5 | 1d | [p2-10-user-clients.md](p2-10-user-clients.md) |
| 11 | `feat/user-billing` | #2 #3 | 1d | [p2-11-user-billing.md](p2-11-user-billing.md) |
| 12 | `feat/user-settings` | #2 #3 | 0.5d | [p2-12-user-settings.md](p2-12-user-settings.md) |

### Phase 3 · 管理员视角

| # | 分支 | 依赖 | 估时 | Plan |
|---|---|---|---|---|
| 13 | `feat/admin-dashboard` | #2 #3 #4 #5 | 1d | [p3-13-admin-dashboard.md](p3-13-admin-dashboard.md) |
| 14 | `feat/admin-accounts-drawer` | #2 #3 #5 | 2d | [p3-14-admin-accounts-drawer.md](p3-14-admin-accounts-drawer.md) |
| 15 | `feat/admin-groups-ui` | #2 #3 #5 | 1d | [p3-15-admin-groups-ui.md](p3-15-admin-groups-ui.md) |
| 16 | `feat/admin-users-clients` | #2 #3 #6 | 1.5d | [p3-16-admin-users-clients.md](p3-16-admin-users-clients.md) |
| 17 | `feat/admin-plans-and-pricing` | #2 #3 #5 | 1.5d | [p3-17-admin-plans-and-pricing.md](p3-17-admin-plans-and-pricing.md) |
| 18 | `feat/admin-campaigns` | #2 #3 | 1d | [p3-18-admin-campaigns.md](p3-18-admin-campaigns.md) |
| 19 | `feat/admin-request-logs-v2` | #2 #3 #4 | 1.5d | [p3-19-admin-request-logs-v2.md](p3-19-admin-request-logs-v2.md) |
| 20 | `feat/admin-metrics` | #2 #3 #4 | 2d | [p3-20-admin-metrics.md](p3-20-admin-metrics.md) |
| 21 | `feat/admin-audit-log-ui` | #2 #3 #6 | 1d | [p3-21-admin-audit-log-ui.md](p3-21-admin-audit-log-ui.md) |
| 22 | `feat/admin-system` | #2 #3 | 0.5d | [p3-22-admin-system.md](p3-22-admin-system.md) |

### Phase 4 · 清理

| # | 分支 | 依赖 | 估时 | Plan |
|---|---|---|---|---|
| 23 | `feat/remove-daily-cost` | #7 #13 | 0.5d | [p4-23-remove-daily-cost.md](p4-23-remove-daily-cost.md) |

## 每条支线的通用约束

1. **从 main 切分支**：`git checkout main && git pull && git checkout -b feat/<name>`
2. **migration 编号**：从 `013_*` 开始顺次递增，避免与 main 冲突（当前最高 `012_opus_4_7_pricing.sql`）
3. **UI 改动只碰本分支的页面**：禁止顺手修别的
4. **合并前跑 `scripts/deploy-gwbk.sh`** 在 gwbk 上验证
5. **不创建 Pull Request**（按 user 要求）— 直接在本地 merge 或走内部流程
6. **禁止渐变色**（user 要求）
7. **禁止 emoji**，除非已有 Unicode 符号（↗ ● × › ✓）
