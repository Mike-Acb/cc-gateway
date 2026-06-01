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
    { label: '请求日志', path: '/logs' },
  ] },
  { title: '接入', items: [
    { label: '令牌管理', path: '/clients' },
  ] },
  { title: '账户', items: [
    { label: '套餐', path: '/plans' },
    { label: '账单', path: '/billing' },
    { label: '设置', path: '/settings' },
  ] },
]

const ADMIN_NAV: NavSection[] = [
  { title: '运营', items: [
    { label: '总览', path: '/admin' },
    { label: '账号池', path: '/admin/accounts' },
    { label: 'CC 伪装模板', path: '/admin/cc-disguise' },
    { label: '账号组', path: '/admin/groups' },
    { label: '出站代理', path: '/admin/proxies' },
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
            <Segmented<'user' | 'admin'>
              value={viewAs}
              options={[{ value: 'user', label: '用户视角' }, { value: 'admin', label: '管理视角' }]}
              onChange={(v) => setViewAs(v)}
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
