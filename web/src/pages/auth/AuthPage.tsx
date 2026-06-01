import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../stores/auth'
import { setAccessToken } from '../../api/client'

export default function AuthPage() {
  const navigate = useNavigate()
  const fetchMe = useAuthStore((s) => s.fetchMe)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Login failed (${res.status})`)
      }
      const data = await res.json()
      setAccessToken(data.accessToken)
      await fetchMe()
      navigate('/', { replace: true })
    } catch (err: any) {
      setError(err.message || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--color-gray-7, #f5f5f5)' }}>
      <div className="w-full max-w-sm px-8 py-10 rounded-2xl shadow-lg" style={{ background: 'var(--surface, #fff)' }}>
        <div className="flex items-center gap-2 mb-8">
          <span
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg"
            style={{ background: 'var(--color-blue, #2563eb)' }}
          >
            <span className="text-[14px] font-semibold text-white tracking-tight">2C</span>
          </span>
          <span className="text-[16px] font-semibold tracking-tight">2Coding Gateway</span>
        </div>
        <h1 className="text-[22px] font-semibold mb-1">登录后台</h1>
        <p className="text-[13px] mb-6" style={{ color: 'var(--ink-3, #6b7280)' }}>
          Sign in to your account
        </p>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wider font-mono" style={{ color: 'var(--ink-3, #6b7280)' }}>
              用户名 / Username
            </span>
            <input
              autoFocus
              autoComplete="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              className="border rounded-lg px-3 py-2 font-mono text-[13px] focus:outline-none focus:ring-2"
              style={{
                borderColor: 'var(--rule, #e5e7eb)',
                background: 'var(--surface, #fff)',
                color: 'var(--ink, #111)',
              }}
              required
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wider font-mono" style={{ color: 'var(--ink-3, #6b7280)' }}>
              密码 / Password
            </span>
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="border rounded-lg px-3 py-2 font-mono text-[13px] focus:outline-none focus:ring-2"
              style={{
                borderColor: 'var(--rule, #e5e7eb)',
                background: 'var(--surface, #fff)',
                color: 'var(--ink, #111)',
              }}
              required
            />
          </label>

          {error && (
            <div
              className="text-[12px] px-3 py-2 rounded-lg"
              style={{ background: '#fee2e2', color: '#991b1b' }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !username || !password}
            className="mt-2 px-4 py-2.5 rounded-lg font-medium text-[13px] text-white disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
            style={{ background: 'var(--color-blue, #2563eb)' }}
          >
            {loading ? '登录中…' : '登录 / Sign In'}
          </button>
        </form>

        <p className="mt-8 text-[11px] text-center" style={{ color: 'var(--ink-3, #6b7280)' }}>
          管理员账号请联系系统管理员
        </p>
      </div>
    </div>
  )
}
