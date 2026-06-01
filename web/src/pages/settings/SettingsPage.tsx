import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../stores/auth'
import { api } from '../../api/client'
import { Button } from '../../ui/Button'
import { Field, Input } from '../../ui/Field'
import { LanguageSwitcher } from '../../i18n'

const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{4,32}$/

function roleLabel(role?: string): string {
  if (role === 'admin') return '管理员'
  if (role === 'user') return '用户'
  return role ?? '-'
}

function formatCreatedAt(value: unknown): string | null {
  if (!value || typeof value !== 'string') return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export default function SettingsPage() {
  const user = useAuthStore((s) => s.user)
  const fetchMe = useAuthStore((s) => s.fetchMe)
  const logout = useAuthStore((s) => s.logout)
  const navigate = useNavigate()

  const [username, setUsername] = useState<string>(user?.username ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const trimmed = username.trim()
  const usernameValid = USERNAME_RE.test(trimmed)
  const changed = trimmed !== (user?.username ?? '')
  const canSave = !saving && changed && usernameValid

  const createdAt = useMemo(() => formatCreatedAt((user as any)?.created_at), [user])

  const handleSave = async () => {
    setError(null)
    setSuccess(null)
    if (!usernameValid) {
      setError('用户名需为 4-32 个字符，仅限字母、数字、下划线或中文')
      return
    }
    setSaving(true)
    try {
      await api('/auth/me', {
        method: 'PATCH',
        body: JSON.stringify({ username: trimmed }),
      })
      await fetchMe()
      setSuccess('已保存')
    } catch (e: any) {
      setError(e?.message ?? '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleLogout = async () => {
    await logout()
    navigate('/auth')
  }

  return (
    <div className="max-w-[720px] mx-auto space-y-8">
      <div>
        <h1 className="text-[26px] font-serif text-[var(--ink)]">设置</h1>
        <p className="mt-1 text-[13px] text-[var(--mute)]">账户与偏好</p>
      </div>

      {/* Account panel */}
      <section className="border border-[var(--rule)] bg-[var(--surface)] rounded p-5 space-y-4">
        <div>
          <h2 className="text-[14px] font-mono uppercase tracking-wider text-[var(--ink-2)]">账户信息</h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="邮箱">
            <Input type="email" value={user?.email ?? ''} disabled />
          </Field>

          <Field label="角色">
            <Input type="text" value={roleLabel(user?.role)} disabled />
          </Field>

          <Field label="用户名" hint="4-32 字符，仅限字母、数字、下划线或中文">
            <Input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="输入新的用户名"
              autoComplete="off"
            />
          </Field>

          {createdAt && (
            <Field label="注册时间">
              <Input type="text" value={createdAt} disabled />
            </Field>
          )}
        </div>

        <div className="flex items-center gap-3 pt-1">
          <Button variant="primary" onClick={handleSave} disabled={!canSave}>
            {saving ? '保存中…' : '保存更改'}
          </Button>
          {success && (
            <span className="text-[12px] font-mono text-[var(--ok)]">{success}</span>
          )}
          {error && (
            <span className="text-[12px] font-mono text-[var(--err)]">{error}</span>
          )}
        </div>
      </section>

      {/* Preferences panel */}
      <section className="border border-[var(--rule)] bg-[var(--surface)] rounded p-5 space-y-4">
        <h2 className="text-[14px] font-mono uppercase tracking-wider text-[var(--ink-2)]">偏好</h2>
        <Field label="语言">
          <div className="flex items-center gap-2">
            <LanguageSwitcher className="border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-1.5 font-mono text-[12px] text-[var(--ink)] rounded hover:bg-[var(--rule-2)] transition-colors" />
            <span className="text-[11px] text-[var(--ink-3)]">点击切换中英文</span>
          </div>
        </Field>
      </section>

      {/* Danger zone */}
      <section className="border border-[var(--err)] bg-[var(--surface)] rounded p-5 space-y-4">
        <div>
          <h2 className="text-[14px] font-mono uppercase tracking-wider text-[var(--err)]">危险区域</h2>
          <p className="mt-1 text-[12px] text-[var(--mute)]">以下操作不可逆。如需处理请联系管理员。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" disabled>清空请求日志</Button>
          <Button variant="ghost" disabled>撤销所有 client</Button>
          <Button variant="ghost" disabled>注销账户</Button>
        </div>
      </section>

      {/* Logout */}
      <div className="pt-2">
        <Button variant="ghost" onClick={handleLogout}>退出登录</Button>
      </div>
    </div>
  )
}
