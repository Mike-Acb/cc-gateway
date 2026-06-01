import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Button, Field, FilterBar, Input } from '../../ui'
import UserRow, { type UserGroupOption, type UserRowData } from './_users/UserRow'

interface UsersResponse {
  users: UserRowData[]
  total: number
  page: number
  limit: number
}

interface GroupsResponse {
  items: UserGroupOption[]
}

type ToastState = { message: string; tone: 'ok' | 'err' } | null

function Toast({ toast, onClose }: { toast: ToastState; onClose: () => void }) {
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(onClose, 3500)
    return () => clearTimeout(t)
  }, [toast, onClose])
  if (!toast) return null
  const color = toast.tone === 'err' ? 'var(--err)' : 'var(--ok)'
  return (
    <div className="fixed top-6 right-6 z-[60]">
      <div
        className="flex items-center gap-3 bg-[var(--surface)] border px-4 py-2.5 rounded text-[12px]"
        style={{ borderColor: color, color }}
      >
        <span>{toast.message}</span>
        <button onClick={onClose} className="text-[var(--ink-3)] hover:text-[var(--ink)]">×</button>
      </div>
    </div>
  )
}

const PAGE_SIZE = 50

export default function AdminUsersPage() {
  const [items, setItems] = useState<UserRowData[]>([])
  const [groups, setGroups] = useState<UserGroupOption[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<ToastState>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams({
        expand: 'clients',
        page: String(page),
        limit: String(PAGE_SIZE),
      })
      if (q.trim()) qs.set('search', q.trim())
      const [users, g] = await Promise.all([
        api<UsersResponse>(`/admin/users?${qs.toString()}`),
        api<GroupsResponse>('/admin/groups'),
      ])
      setItems(users.users ?? [])
      setTotal(users.total ?? 0)
      setGroups(g.items ?? [])
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : '加载失败',
        tone: 'err',
      })
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [page, q])

  useEffect(() => { load() }, [load])

  // Reset to page 1 when the search term changes.
  useEffect(() => { setPage(1) }, [q])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <header>
        <h1 className="text-[26px] font-serif">用户与客户端</h1>
        <p className="text-[13px] text-[var(--mute)] mt-1">
          管理账号状态、角色与 client 分组 · 共 {total} 个用户
        </p>
      </header>

      <FilterBar>
        <Field label="搜索">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="邮箱或用户名…"
            className="w-[240px]"
          />
        </Field>
      </FilterBar>

      <div className="border border-[var(--rule)] rounded bg-[var(--surface)] overflow-x-auto">
        <table className="w-full border-collapse text-[12px] min-w-[720px]">
          <thead>
            <tr className="border-b border-[var(--rule)] text-left font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">
              <th className="px-3 py-2">邮箱</th>
              <th className="px-3 py-2">用户名</th>
              <th className="px-3 py-2">角色</th>
              <th className="px-3 py-2">状态</th>
              <th className="px-3 py-2">Clients</th>
              <th className="px-3 py-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((u) => (
              <UserRow
                key={u.id}
                user={u}
                groups={groups}
                onChange={load}
                onError={(message) => setToast({ message, tone: 'err' })}
              />
            ))}
            {items.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-[var(--ink-3)]">
                  没有用户。
                </td>
              </tr>
            )}
            {items.length === 0 && loading && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-[var(--ink-3)]">
                  加载中…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button
            size="sm"
            variant="default"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            上一页
          </Button>
          <span className="text-[12px] text-[var(--ink-3)] tabular-nums">
            {page} / {totalPages}
          </span>
          <Button
            size="sm"
            variant="default"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            下一页
          </Button>
        </div>
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  )
}
