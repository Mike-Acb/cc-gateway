# Nav Shell Implementation Plan — `feat/nav-shell`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 替换现有 `DashboardLayout` 为 prototype 风格的 AppShell — 左侧分组导航、顶部角色切换、路由重组为"用户 6 页 / 管理员 11 页 / /dev/kit"。

**Architecture:**
- 新建 `AppShell.tsx`（取代 `DashboardLayout.tsx`），内部按 `useAuthStore().user.role` 渲染用户/管理员导航。
- 路由表重写：把 Phase 2/3 要实现的 17 个页面先用占位页（`<div className="page-stub">TODO: <name></div>`）挂上去，保证分支可构建、可部署、可被后续分支增量替换。
- 角色切换：管理员可以在顶部点一个 `Segmented` 切换"用户视角/管理员视角"，存入 Zustand `useUiStore().viewAs`。普通用户没有这个切换。

**Tech Stack:** React 19 + React Router 7 + Zustand + `feat/ui-kit` 提供的组件（`Segmented`、`Button`、`Pill`）。

---

## 约束

1. **不要实现任何业务页面** — 所有被路由引用的新页面全部用 placeholder，内容只显示 `"TODO — <page-id>"`。
2. **保留 /auth 与 /auth/callback** — 登录流程不在本分支改动。
3. **禁止渐变色、禁止 emoji**（已有 Unicode 符号除外）。
4. **LanguageSwitcher 保留但移到左下角 footer**，与原实现一致。
5. **全程使用 `feat/ui-kit` 提供的 `@/ui` 组件**，不要自行发明样式。

---

## 文件结构

**Create:**
- `web/src/layouts/AppShell.tsx` — 新 shell
- `web/src/stores/ui.ts` — UI 状态（viewAs、sidebarOpen）
- `web/src/pages/_stub.tsx` — 占位页组件 `<PageStub name="..."/>`
- `web/src/pages/dev/DevKitPreview.tsx`（若 p1-02-ui-kit 未创建则此处创建，见 Task 3）

**Modify:**
- `web/src/router.tsx` — 整体重写路由表
- `web/src/App.tsx` — 无变动（保留 `I18nProvider + AppRouter`）

**Delete:**
- `web/src/layouts/DashboardLayout.tsx` — 被 `AppShell.tsx` 替换
- `web/src/pages/auth/LoginPage.tsx`、`web/src/pages/auth/RegisterPage.tsx` — 当前 git status 里已标记为 deleted，这里要正式从仓库移除

---

## Task 1: 切分支 + 基础状态

**Files:**
- Create: `web/src/stores/ui.ts`

- [ ] **Step 1: 从 main 切分支**

```bash
cd /path/to/cc-gateway
git checkout main && git pull
git checkout -b feat/nav-shell
```

- [ ] **Step 2: 写 UI 状态 store**

```typescript
// web/src/stores/ui.ts
import { create } from 'zustand'

type ViewAs = 'user' | 'admin'

type UiState = {
  viewAs: ViewAs
  sidebarOpen: boolean
  setViewAs: (v: ViewAs) => void
  setSidebarOpen: (o: boolean) => void
  toggleSidebar: () => void
}

export const useUiStore = create<UiState>((set) => ({
  viewAs: (localStorage.getItem('cc.viewAs') as ViewAs) || 'user',
  sidebarOpen: false,
  setViewAs: (v) => {
    localStorage.setItem('cc.viewAs', v)
    set({ viewAs: v })
  },
  setSidebarOpen: (o) => set({ sidebarOpen: o }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
}))
```

- [ ] **Step 3: 提交**

```bash
git add web/src/stores/ui.ts
git commit -m "feat(shell): add UI store for view-as and sidebar state"
```

---

## Task 2: 写 PageStub 占位组件

**Files:**
- Create: `web/src/pages/_stub.tsx`

- [ ] **Step 1: 占位页**

```tsx
// web/src/pages/_stub.tsx
type Props = { name: string; note?: string }

export function PageStub({ name, note }: Props) {
  return (
    <section className="max-w-[880px]">
      <h1 className="text-[26px] font-serif mb-2">{name}</h1>
      <p className="text-[13px] text-[var(--mute)] mb-6">占位页 — 由后续分支实现。</p>
      {note && <p className="text-[13px] text-[var(--ink-2)]">{note}</p>}
      <div className="mt-8 p-4 rounded-[6px] bg-[var(--surface-2)] border border-[var(--line)] text-[12px] text-[var(--mute)] font-mono">
        TODO — {name}
      </div>
    </section>
  )
}
```

- [ ] **Step 2: 提交**

```bash
git add web/src/pages/_stub.tsx
git commit -m "feat(shell): add PageStub placeholder for staged page rollout"
```

---

## Task 3: DevKit 预览页（若 p1-02 未落，这里兜底创建一个空 stub）

**Files:**
- Check: `web/src/pages/dev/DevKitPreview.tsx`

- [ ] **Step 1: 检查是否已存在**

```bash
ls web/src/pages/dev/DevKitPreview.tsx 2>/dev/null
```

- [ ] **Step 2: 若不存在，创建占位**

```tsx
// web/src/pages/dev/DevKitPreview.tsx
import { PageStub } from '../_stub'
export default function DevKitPreview() {
  return <PageStub name="Dev Kit 预览" note="由 feat/ui-kit 分支实现。" />
}
```

- [ ] **Step 3: 若存在则跳过此 task（说明 p1-02 已 merge，保留其实现）**

- [ ] **Step 4: 提交（若有新增）**

```bash
git add web/src/pages/dev/DevKitPreview.tsx
git commit -m "feat(shell): add DevKit preview stub fallback"
```

---

## Task 4: AppShell — 导航配置

**Files:**
- Create: `web/src/layouts/AppShell.tsx`

- [ ] **Step 1: 定义导航数据**

```tsx
// web/src/layouts/AppShell.tsx
import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/auth'
import { useUiStore } from '../stores/ui'
import { LanguageSwitcher } from '../i18n'
import { Segmented } from '../ui'

type NavEntry = { label: string; path: string }
type NavSection = { title: string; items: NavEntry[] }

const USER_NAV: NavSection[] = [
  { title: '概览', items: [
    { label: '总览', path: '/' },
    { label: '用量', path: '/usage' },
  ] },
  { title: '接入', items: [
    { label: '客户端', path: '/clients' },
  ] },
  { title: '账户', items: [
    { label: '账单', path: '/billing' },
    { label: '设置', path: '/settings' },
  ] },
]

const ADMIN_NAV: NavSection[] = [
  { title: '运营', items: [
    { label: '总览', path: '/admin' },
    { label: '账号池', path: '/admin/accounts' },
    { label: '账号组', path: '/admin/groups' },
    { label: '用户与客户端', path: '/admin/users' },
  ] },
  { title: '计费', items: [
    { label: '套餐与价格', path: '/admin/plans' },
    { label: '推广活动', path: '/admin/campaigns' },
  ] },
  { title: '观测', items: [
    { label: '请求日志', path: '/admin/logs' },
    { label: '指标', path: '/admin/metrics' },
    { label: '审计日志', path: '/admin/audit' },
  ] },
  { title: '系统', items: [
    { label: '系统', path: '/admin/system' },
  ] },
]
```

- [ ] **Step 2: Shell 组件骨架**

```tsx
export default function AppShell() {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()
  const { viewAs, setViewAs, sidebarOpen, toggleSidebar, setSidebarOpen } = useUiStore()
  const isAdmin = user?.role === 'admin'
  const nav = isAdmin && viewAs === 'admin' ? ADMIN_NAV : USER_NAV

  const closeSidebar = () => setSidebarOpen(false)

  return (
    <div className="flex min-h-screen bg-[var(--bg)] text-[var(--ink)]">
      {/* Mobile topbar */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-4 py-3 bg-[var(--surface)] border-b border-[var(--line)]">
        <button onClick={toggleSidebar} className="w-6 h-6 text-[18px]">&#9776;</button>
        <span className="text-[14px] font-semibold">2Coding Gateway</span>
        <div className="w-6" />
      </div>

      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/25 z-30 md:hidden" onClick={closeSidebar} />
      )}

      <aside className={`${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0 md:relative fixed inset-y-0 left-0 z-40 w-[220px] transition-transform duration-200 bg-[var(--surface)] border-r border-[var(--line)] flex flex-col shrink-0`}>
        <div className="px-5 pt-5 pb-3">
          <div className="text-[15px] font-semibold tracking-tight">2Coding Gateway</div>
          <div className="text-[11px] text-[var(--mute)] mt-1">{isAdmin ? '管理员控制台' : '用户控制台'}</div>
        </div>
        {isAdmin && (
          <div className="px-5 pb-3">
            <Segmented
              value={viewAs}
              options={[{ value: 'user', label: '用户视角' }, { value: 'admin', label: '管理视角' }]}
              onChange={(v) => setViewAs(v as 'user' | 'admin')}
            />
          </div>
        )}
        <nav className="flex-1 overflow-y-auto pb-4">
          {nav.map((section) => (
            <div key={section.title} className="mb-1">
              <div className="px-5 pt-3 pb-1 text-[10px] text-[var(--mute)] uppercase tracking-[0.14em] font-medium">{section.title}</div>
              {section.items.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === '/' || item.path === '/admin'}
                  onClick={closeSidebar}
                  className={({ isActive }) =>
                    `block px-5 py-1.5 text-[13px] border-l-[2.5px] transition-colors ${
                      isActive
                        ? 'border-[var(--accent)] bg-[var(--accent-weak)] text-[var(--accent)] font-medium'
                        : 'border-transparent text-[var(--ink-2)] hover:text-[var(--ink)]'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="px-5 py-4 border-t border-[var(--line)]">
          <div className="text-[13px] font-medium truncate">{user?.username}</div>
          <div className="text-[11px] text-[var(--mute)] truncate">{user?.email}</div>
          <div className="flex items-center gap-3 mt-2">
            <button
              onClick={async () => { await logout(); navigate('/auth') }}
              className="text-[12px] text-[var(--mute)] hover:text-[var(--err)]"
            >
              退出
            </button>
            <LanguageSwitcher />
          </div>
        </div>
      </aside>

      <main className="flex-1 p-4 sm:p-7 overflow-auto pt-16 md:pt-7">
        <Outlet />
      </main>
    </div>
  )
}
```

- [ ] **Step 3: 提交**

```bash
git add web/src/layouts/AppShell.tsx
git commit -m "feat(shell): implement AppShell with role-aware grouped nav"
```

---

## Task 5: 重写路由表

**Files:**
- Modify: `web/src/router.tsx`

- [ ] **Step 1: 写新路由（整体替换）**

```tsx
// web/src/router.tsx
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { useEffect } from 'react'
import { useAuthStore } from './stores/auth'

import AppShell from './layouts/AppShell'
import AuthPage from './pages/auth/AuthPage'
import CallbackPage from './pages/auth/CallbackPage'
import { PageStub } from './pages/_stub'
import DevKitPreview from './pages/dev/DevKitPreview'

function ProtectedRoute() {
  const { user, loading } = useAuthStore()
  if (loading) return <div className="flex items-center justify-center h-screen text-[13px] text-[var(--mute)]">Loading…</div>
  if (!user) return <Navigate to="/auth" replace />
  return <Outlet />
}

function GuestRoute() {
  const { user, loading } = useAuthStore()
  if (loading) return <div className="flex items-center justify-center h-screen text-[13px] text-[var(--mute)]">Loading…</div>
  if (user) return <Navigate to="/" replace />
  return <Outlet />
}

function AdminRoute() {
  const { user } = useAuthStore()
  if (user?.role !== 'admin') return <Navigate to="/" replace />
  return <Outlet />
}

export default function AppRouter() {
  const fetchMe = useAuthStore((s) => s.fetchMe)
  useEffect(() => { fetchMe() }, [fetchMe])

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<GuestRoute />}>
          <Route path="/auth" element={<AuthPage />} />
          <Route path="/auth/callback" element={<CallbackPage />} />
        </Route>

        {/* Legacy redirects */}
        <Route path="/login" element={<Navigate to="/auth" replace />} />
        <Route path="/register" element={<Navigate to="/auth" replace />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            {/* User pages */}
            <Route path="/" element={<PageStub name="总览 (用户)" />} />
            <Route path="/usage" element={<PageStub name="用量" />} />
            <Route path="/clients" element={<PageStub name="客户端" />} />
            <Route path="/billing" element={<PageStub name="账单" />} />
            <Route path="/settings" element={<PageStub name="设置" />} />

            {/* Dev-only kit preview */}
            <Route path="/dev/kit" element={<DevKitPreview />} />

            {/* Admin pages */}
            <Route element={<AdminRoute />}>
              <Route path="/admin" element={<PageStub name="总览 (管理员)" />} />
              <Route path="/admin/accounts" element={<PageStub name="账号池" />} />
              <Route path="/admin/groups" element={<PageStub name="账号组" />} />
              <Route path="/admin/users" element={<PageStub name="用户与客户端" />} />
              <Route path="/admin/plans" element={<PageStub name="套餐与价格" />} />
              <Route path="/admin/campaigns" element={<PageStub name="推广活动" />} />
              <Route path="/admin/logs" element={<PageStub name="请求日志" />} />
              <Route path="/admin/metrics" element={<PageStub name="指标" />} />
              <Route path="/admin/audit" element={<PageStub name="审计日志" />} />
              <Route path="/admin/system" element={<PageStub name="系统" />} />
            </Route>

            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
```

- [ ] **Step 2: 提交**

```bash
git add web/src/router.tsx
git commit -m "feat(shell): new route table with stubs for Phase 2/3 pages"
```

---

## Task 6: 移除旧 Shell + 旧登录页

**Files:**
- Delete: `web/src/layouts/DashboardLayout.tsx`
- Delete: `web/src/pages/auth/LoginPage.tsx`
- Delete: `web/src/pages/auth/RegisterPage.tsx`

- [ ] **Step 1: 删除文件**

```bash
rm web/src/layouts/DashboardLayout.tsx
git rm --cached web/src/pages/auth/LoginPage.tsx 2>/dev/null || true
git rm --cached web/src/pages/auth/RegisterPage.tsx 2>/dev/null || true
rm -f web/src/pages/auth/LoginPage.tsx web/src/pages/auth/RegisterPage.tsx
```

- [ ] **Step 2: 全局确认没有残留引用**

```bash
cd /path/to/cc-gateway
```

Run: `Grep` pattern `DashboardLayout|LoginPage|RegisterPage` in `web/src`
Expected: 空结果（零引用）。如果有残留，逐一清掉。

- [ ] **Step 3: 提交**

```bash
git add -A web/src/layouts web/src/pages/auth
git commit -m "feat(shell): remove legacy DashboardLayout and login/register pages"
```

---

## Task 7: 构建验证

- [ ] **Step 1: 本地构建**

```bash
cd /path/to/cc-gateway/web
npm run build
```

Expected: 构建成功，无 TS error。

- [ ] **Step 2: 本地跑 dev，验证路由**

```bash
npm run dev
```

人工验证：
1. 未登录访问 `/` → 302 `/auth`
2. 登录为普通用户 → 左侧显示 6 条（总览/用量/客户端/账单/设置），无角色切换
3. 登录为管理员 → 左侧多一个 `Segmented`，切换到"管理视角"后显示 11 条 admin 导航
4. 访问 `/admin/audit` 等 stub 路由 → 显示 `TODO — 审计日志`
5. 访问 `/dev/kit` → 显示 DevKit 预览或其 stub
6. 点退出 → 回到 `/auth`

- [ ] **Step 3: 若发现 bug，修复并 commit**

---

## Task 8: 部署到 gwbk 验证

- [ ] **Step 1: 运行部署脚本**

```bash
cd /path/to/cc-gateway
./scripts/deploy-gwbk.sh
```

Expected: 脚本成功，pm2 显示 `gateway-bk` / `api-server-bk` 在线。

- [ ] **Step 2: 浏览器访问 https://gwbk.example.com**

人工验证同 Task 7 Step 2。

- [ ] **Step 3: 如有回归，回到本地修复并重新部署**

---

## Task 9: 合并到 main

- [ ] **Step 1: rebase**

```bash
git fetch origin main
git rebase origin/main
```

- [ ] **Step 2: 合并**

```bash
git checkout main
git merge --no-ff feat/nav-shell -m "merge: feat/nav-shell"
git push origin main
```

- [ ] **Step 3: 通知：phase 2 & phase 3 分支现在可以从 main 起。**
