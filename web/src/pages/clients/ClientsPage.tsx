import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { useAuthStore } from '../../stores/auth'
import {
  Button, Field, Input, Modal, Pill, Segmented, Table,
} from '../../ui'
import type { Column } from '../../ui/Table'

/* ---------- types ---------- */

interface Client {
  id: string
  name: string
  token: string
  status: 'active' | 'pending' | 'suspended' | string
  group_id?: string | null
  group_name?: string | null
  created_at: string
  owner_username?: string | null
  owner_email?: string | null
}

type Tab = 'mine' | 'pending'

type ToastState = { message: string; tone: 'ok' | 'err' } | null

/* ---------- helpers ---------- */

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function statusPill(status: string) {
  if (status === 'active') return <Pill tone="ok">active</Pill>
  if (status === 'pending') return <Pill tone="warn">pending</Pill>
  if (status === 'suspended') return <Pill tone="err">suspended</Pill>
  return <Pill tone="mute">{status}</Pill>
}


/* ---------- toast ---------- */

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

/* ---------- download menu ---------- */


/* ---------- token-shown modal ---------- */

interface TokenShownState {
  title: string
  description: string
  token: string
}

function TokenShownModal({
  state, onClose,
}: { state: TokenShownState | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => { setCopied(false) }, [state])
  if (!state) return null
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(state.token)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { /* ignore */ }
  }
  return (
    <Modal
      open
      title={state.title}
      onClose={onClose}
      footer={<Button variant="primary" onClick={onClose}>我已保存</Button>}
    >
      <p className="text-[12px] text-[var(--ink-2)] leading-relaxed">
        {state.description}
      </p>
      <div className="mt-4 relative bg-[var(--surface-2)] border border-[var(--rule)] rounded p-3">
        <pre className="font-mono text-[11px] text-[var(--ink)] break-all whitespace-pre-wrap leading-relaxed pr-14 select-all m-0">
{state.token}
        </pre>
        <button
          onClick={copy}
          className="absolute top-2 right-2 px-2 py-1 text-[10px] font-mono uppercase tracking-wider border border-[var(--rule)] bg-[var(--surface)] text-[var(--ink-2)] hover:bg-[var(--rule-2)] rounded"
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <p className="mt-3 text-[11px] text-[var(--ink-3)]">
        关闭后将无法再次查看此 Token，请立即保存。
      </p>
    </Modal>
  )
}

/* ---------- action cell for "my clients" row ---------- */

function RowActions({
  client, onRotate, onDelete, onShowToken,
}: {
  client: Client
  onRotate: (c: Client) => void
  onDelete: (c: Client) => void
  onShowToken: (c: Client) => void
}) {
  const canLaunch = client.status === 'active'
  return (
    <div className="flex items-center gap-1.5 justify-end">
      {canLaunch && (
        <Button
          size="sm"
          variant="default"
          onClick={() => onShowToken(client)}
        >
          查看 Token
        </Button>
      )}
      <Button
        size="sm"
        variant="default"
        onClick={() => onRotate(client)}
        disabled={client.status === 'suspended'}
      >
        轮换 key
      </Button>
      <Button
        size="sm"
        variant="danger"
        onClick={() => onDelete(client)}
      >
        删除
      </Button>
    </div>
  )
}

/* ---------- main ---------- */

export default function ClientsPage() {
  const user = useAuthStore(s => s.user)
  const isAdmin = user?.role === 'admin'

  const [clients, setClients] = useState<Client[]>([])
  const [pendingClients, setPendingClients] = useState<Client[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('mine')

  const [toast, setToast] = useState<ToastState>(null)

  // create modal
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createError, setCreateError] = useState('')
  const [creating, setCreating] = useState(false)

  // token-shown modal (used for create-success and rotate-success)
  const [tokenShown, setTokenShown] = useState<TokenShownState | null>(null)

  // delete confirm modal
  const [toDelete, setToDelete] = useState<Client | null>(null)
  const [deleting, setDeleting] = useState(false)

  // rotate confirm modal
  const [toRotate, setToRotate] = useState<Client | null>(null)
  const [rotating, setRotating] = useState(false)

  const firstLoad = useRef(true)

  const fetchMine = useCallback(async () => {
    try {
      const data = await api<Client[]>('/clients')
      setClients(Array.isArray(data) ? data : [])
    } catch {
      setClients([])
    }
  }, [])

  const fetchPending = useCallback(async () => {
    if (!isAdmin) return
    try {
      const data = await api<Client[]>('/admin/clients/pending')
      setPendingClients(Array.isArray(data) ? data : [])
    } catch {
      setPendingClients([])
    }
  }, [isAdmin])

  useEffect(() => {
    Promise.all([fetchMine(), fetchPending()]).finally(() => {
      setLoading(false)
      firstLoad.current = false
    })
  }, [fetchMine, fetchPending])

  /* create */
  const openCreate = () => {
    setCreateName('')
    setCreateError('')
    setCreateOpen(true)
  }
  const submitCreate = async () => {
    const name = createName.trim()
    if (!name) { setCreateError('请填写客户端名称'); return }
    setCreating(true)
    setCreateError('')
    try {
      const data = await api<Client>('/clients', {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
      setCreateOpen(false)
      setTokenShown({
        title: '客户端创建成功',
        description:
          '请立即保存下方 Token，这是唯一一次明文展示的机会。新客户端状态为 pending，需管理员审核通过后才能使用。',
        token: data.token,
      })
      await fetchMine()
      await fetchPending()
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : '创建失败')
    } finally {
      setCreating(false)
    }
  }

  /* delete */
  const submitDelete = async () => {
    if (!toDelete) return
    setDeleting(true)
    try {
      await api(`/clients/${toDelete.id}`, { method: 'DELETE' })
      setToast({ message: `已删除 ${toDelete.name}`, tone: 'ok' })
      setToDelete(null)
      await fetchMine()
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : '删除失败', tone: 'err' })
      setToDelete(null)
    } finally {
      setDeleting(false)
    }
  }

  /* rotate */
  const submitRotate = async () => {
    if (!toRotate) return
    setRotating(true)
    try {
      const data = await api<{ token: string; name: string }>(`/clients/${toRotate.id}/rotate`, {
        method: 'POST',
      })
      const name = toRotate.name
      setToRotate(null)
      setTokenShown({
        title: 'Token 轮换成功',
        description: `客户端 ${name} 的旧 Token 已立即失效。请立即保存下方新 Token，关闭后将无法再次查看。`,
        token: data.token,
      })
      await fetchMine()
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : '轮换失败', tone: 'err' })
      setToRotate(null)
    } finally {
      setRotating(false)
    }
  }

  /* admin approve / reject */
  const handleApprove = async (id: string) => {
    try {
      await api(`/admin/clients/${id}/approve`, { method: 'POST' })
      setToast({ message: '已通过审核', tone: 'ok' })
      await Promise.all([fetchMine(), fetchPending()])
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : '操作失败', tone: 'err' })
    }
  }
  const handleReject = async (id: string) => {
    try {
      await api(`/admin/clients/${id}/reject`, { method: 'POST' })
      setToast({ message: '已拒绝申请', tone: 'ok' })
      await fetchPending()
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : '操作失败', tone: 'err' })
    }
  }

  /* columns */

  const mineColumns: Column<Client>[] = [
    {
      key: 'name',
      header: '名称',
      render: (r) => (
        <div>
          <div className="text-[13px] text-[var(--ink)]">{r.name}</div>
          {isAdmin && r.owner_username && (
            <div className="text-[11px] text-[var(--ink-3)] mt-0.5">
              {r.owner_username}
              {r.owner_email && <span className="ml-1">({r.owner_email})</span>}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'group',
      header: '调度组',
      render: (r) => r.group_name
        ? <Pill tone="info">{r.group_name}</Pill>
        : <span className="text-[var(--ink-3)]">—</span>,
    },
    {
      key: 'created_at',
      header: '创建时间',
      render: (r) => <span className="text-[var(--ink-2)] tabular-nums">{fmtDate(r.created_at)}</span>,
    },
    {
      key: 'status',
      header: '状态',
      render: (r) => statusPill(r.status),
    },
    {
      key: 'actions',
      header: <span className="block text-right">操作</span>,
      render: (r) => (
        <RowActions
          client={r}
          onRotate={setToRotate}
          onDelete={setToDelete}
          onShowToken={(c) => setTokenShown({
            title: `客户端 ${c.name} 的 Token`,
            description: '使用此 Token 配置 Claude Code 客户端 (ANTHROPIC_API_KEY)，或拷给团队成员。',
            token: c.token,
          })}
        />
      ),
      className: 'text-right',
    },
  ]

  const pendingColumns: Column<Client>[] = [
    {
      key: 'name',
      header: '名称',
      render: (r) => (
        <div>
          <div className="text-[13px] text-[var(--ink)]">{r.name}</div>
          {r.owner_username && (
            <div className="text-[11px] text-[var(--ink-3)] mt-0.5">
              {r.owner_username}
              {r.owner_email && <span className="ml-1">({r.owner_email})</span>}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'group',
      header: '调度组',
      render: (r) => r.group_name
        ? <Pill tone="info">{r.group_name}</Pill>
        : <span className="text-[var(--ink-3)]">—</span>,
    },
    {
      key: 'created_at',
      header: '申请时间',
      render: (r) => <span className="text-[var(--ink-2)] tabular-nums">{fmtDate(r.created_at)}</span>,
    },
    {
      key: 'actions',
      header: <span className="block text-right">操作</span>,
      render: (r) => (
        <div className="flex items-center gap-1.5 justify-end">
          <Button size="sm" variant="primary" onClick={() => handleApprove(r.id)}>通过</Button>
          <Button size="sm" variant="danger" onClick={() => handleReject(r.id)}>拒绝</Button>
        </div>
      ),
      className: 'text-right',
    },
  ]

  /* render */

  return (
    <div className="max-w-[1280px] mx-auto space-y-6">
      <Toast toast={toast} onClose={() => setToast(null)} />

      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-serif">我的 Token</h1>
          <p className="text-[13px] text-[var(--mute)] mt-1">管理接入网关的 API Token</p>
        </div>
        <Button variant="primary" onClick={openCreate}>新建 client</Button>
      </header>

      {isAdmin && (
        <div className="flex items-center gap-3">
          <Segmented<Tab>
            value={tab}
            onChange={setTab}
            options={[
              { value: 'mine', label: '我的' },
              {
                value: 'pending',
                label: pendingClients.length > 0
                  ? `待审核 (${pendingClients.length})`
                  : '待审核',
              },
            ]}
          />
        </div>
      )}

      {loading ? (
        <div className="text-[13px] text-[var(--mute)]">Loading…</div>
      ) : tab === 'pending' && isAdmin ? (
        <div className="border border-[var(--rule)] rounded overflow-hidden bg-[var(--surface)]">
          <Table<Client>
            rows={pendingClients}
            columns={pendingColumns}
            emptyLabel="没有待审核的客户端。"
          />
        </div>
      ) : (
        <div className="border border-[var(--rule)] rounded overflow-hidden bg-[var(--surface)]">
          <Table<Client>
            rows={clients}
            columns={mineColumns}
            emptyLabel="还没有客户端，点击右上角创建。"
          />
        </div>
      )}

      {/* create modal */}
      <Modal
        open={createOpen}
        title="新建 client"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button
              variant="primary"
              onClick={submitCreate}
              disabled={creating || !createName.trim()}
            >
              {creating ? '创建中…' : '创建'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-[12px] text-[var(--ink-2)] leading-relaxed">
            每个 client 代表一台设备的凭证。创建后初始为 pending 状态，需管理员审核通过后方可使用。
          </p>
          <Field label="名称" hint="建议使用设备名，如 alice-macbook">
            <Input
              autoFocus
              value={createName}
              onChange={e => { setCreateName(e.target.value); setCreateError('') }}
              onKeyDown={e => { if (e.key === 'Enter') submitCreate() }}
              placeholder="my-macbook"
            />
          </Field>
          {createError && (
            <div className="text-[11px]" style={{ color: 'var(--err)' }}>
              {createError}
            </div>
          )}
        </div>
      </Modal>

      {/* token shown modal (create + rotate) */}
      <TokenShownModal state={tokenShown} onClose={() => setTokenShown(null)} />

      {/* delete confirm */}
      <Modal
        open={!!toDelete}
        title="删除客户端"
        onClose={() => setToDelete(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setToDelete(null)}>取消</Button>
            <Button
              variant="danger"
              onClick={submitDelete}
              disabled={deleting}
            >
              {deleting ? '删除中…' : '删除'}
            </Button>
          </>
        }
      >
        <p className="text-[12px] text-[var(--ink-2)] leading-relaxed">
          确定删除客户端「<span className="text-[var(--ink)]">{toDelete?.name}</span>」？
          该客户端的 Token 将立即失效，此操作不可撤销。
        </p>
      </Modal>

      {/* rotate confirm */}
      <Modal
        open={!!toRotate}
        title="轮换 Token"
        onClose={() => setToRotate(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setToRotate(null)}>取消</Button>
            <Button
              variant="primary"
              onClick={submitRotate}
              disabled={rotating}
            >
              {rotating ? '轮换中…' : '确认轮换'}
            </Button>
          </>
        }
      >
        <p className="text-[12px] text-[var(--ink-2)] leading-relaxed">
          将为客户端「<span className="text-[var(--ink)]">{toRotate?.name}</span>」生成一条新的 Token，
          旧 Token 立即失效。轮换后请重新下载启动器或手动替换 Token。
        </p>
      </Modal>
    </div>
  )
}
