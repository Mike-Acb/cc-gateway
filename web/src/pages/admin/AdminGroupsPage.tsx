import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Button, Field, GROUP_COLORS, GroupPill, Input, Modal, Pill, Table } from '../../ui'
import type { Column } from '../../ui/Table'

interface Group {
  id: string
  name: string
  description: string | null
  is_default: boolean
  cost_multiplier: string | number | null
  color: string | null
  account_count: number
  client_count: number
  created_at: string
  updated_at: string
}

function fmtMultiplier(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '1.000'
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return '1.000'
  return n.toFixed(3)
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

export default function AdminGroupsPage() {
  const [items, setItems] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<ToastState>(null)

  // create / edit modal state
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Group | null>(null)
  const [formName, setFormName] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formMultiplier, setFormMultiplier] = useState('1.000')
  // '' = 自动(后端 NULL,前端按组名哈希)
  const [formColor, setFormColor] = useState<string>('')
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // delete confirm
  const [toDelete, setToDelete] = useState<Group | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api<{ items: Group[] }>('/admin/groups')
      setItems(Array.isArray(data?.items) ? data.items : [])
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : '加载失败', tone: 'err' })
      setItems([])
    }
  }, [])

  useEffect(() => {
    load().finally(() => setLoading(false))
  }, [load])

  const openCreate = () => {
    setEditing(null)
    setFormName('')
    setFormDescription('')
    setFormMultiplier('1.000')
    setFormColor('')
    setFormError('')
    setFormOpen(true)
  }

  const openEdit = (g: Group) => {
    setEditing(g)
    setFormName(g.name)
    setFormDescription(g.description ?? '')
    setFormMultiplier(fmtMultiplier(g.cost_multiplier))
    setFormColor(g.color ?? '')
    setFormError('')
    setFormOpen(true)
  }

  const submitForm = async () => {
    const name = formName.trim()
    if (!name) {
      setFormError('请填写名称')
      return
    }
    const multRaw = formMultiplier.trim()
    const multNum = multRaw === '' ? 1 : Number(multRaw)
    if (!Number.isFinite(multNum) || multNum < 0.1 || multNum > 10) {
      setFormError('倍率必须是 0.1 ~ 10 之间的数字')
      return
    }
    setSubmitting(true)
    setFormError('')
    try {
      const body = JSON.stringify({
        name,
        description: formDescription.trim() || null,
        cost_multiplier: multNum,
        // '' → 后端清空回自动哈希;非空字符串 → 后端白名单校验
        color: formColor === '' ? null : formColor,
      })
      if (editing) {
        await api(`/admin/groups/${editing.id}`, { method: 'PATCH', body })
        setToast({ message: `已更新 ${name}`, tone: 'ok' })
      } else {
        await api('/admin/groups', { method: 'POST', body })
        setToast({ message: `已创建 ${name}`, tone: 'ok' })
      }
      setFormOpen(false)
      await load()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSubmitting(false)
    }
  }

  const submitDelete = async () => {
    if (!toDelete) return
    setDeleting(true)
    try {
      await api(`/admin/groups/${toDelete.id}`, { method: 'DELETE' })
      setToast({ message: `已删除 ${toDelete.name}`, tone: 'ok' })
      setToDelete(null)
      await load()
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : '删除失败', tone: 'err' })
      setToDelete(null)
    } finally {
      setDeleting(false)
    }
  }

  const columns: Column<Group>[] = [
    {
      key: 'name',
      header: '名称',
      render: (r) => (
        <span className="inline-flex items-center gap-2">
          <GroupPill id={r.id} name={r.name} color={r.color} />
          {r.is_default && <Pill tone="info">默认</Pill>}
          <span className="font-mono text-[10px] text-[var(--ink-3)] tabular-nums">
            倍率 {fmtMultiplier(r.cost_multiplier)}
          </span>
        </span>
      ),
    },
    {
      key: 'description',
      header: '描述',
      render: (r) => r.description
        ? <span className="text-[var(--ink-2)]">{r.description}</span>
        : <span className="text-[var(--ink-3)]">—</span>,
    },
    {
      key: 'multiplier',
      header: '成本倍率',
      render: (r) => (
        <span className="font-mono tabular-nums text-[var(--ink)]">
          {fmtMultiplier(r.cost_multiplier)}
        </span>
      ),
    },
    {
      key: 'account_count',
      header: '成员账号',
      render: (r) => <span className="tabular-nums text-[var(--ink-2)]">{r.account_count}</span>,
    },
    {
      key: 'client_count',
      header: '绑定客户端',
      render: (r) => <span className="tabular-nums text-[var(--ink-2)]">{r.client_count}</span>,
    },
    {
      key: 'actions',
      header: <span className="block text-right">操作</span>,
      render: (r) => (
        <div className="flex items-center gap-1.5 justify-end">
          <Button size="sm" variant="default" onClick={() => openEdit(r)}>编辑</Button>
          <Button
            size="sm"
            variant="danger"
            disabled={r.is_default}
            onClick={() => setToDelete(r)}
          >
            删除
          </Button>
        </div>
      ),
      className: 'text-right',
    },
  ]

  return (
    <div className="max-w-[1040px] mx-auto space-y-6">
      <Toast toast={toast} onClose={() => setToast(null)} />

      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-serif">账号组</h1>
          <p className="text-[13px] text-[var(--mute)] mt-1">调度隔离单位 — 默认组由唯一索引保证，如需切换默认请先新建组再删除旧默认。</p>
        </div>
        <Button variant="primary" onClick={openCreate}>新建组</Button>
      </header>

      {loading ? (
        <div className="text-[13px] text-[var(--mute)]">Loading…</div>
      ) : (
        <div className="border border-[var(--rule)] rounded overflow-hidden bg-[var(--surface)]">
          <Table<Group>
            rows={items}
            columns={columns}
            emptyLabel="暂无账号组。"
          />
        </div>
      )}

      {/* create / edit modal */}
      <Modal
        open={formOpen}
        title={editing ? `编辑 ${editing.name}` : '新建账号组'}
        onClose={() => setFormOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setFormOpen(false)}>取消</Button>
            <Button
              variant="primary"
              onClick={submitForm}
              disabled={submitting || !formName.trim()}
            >
              {submitting ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="名称" hint="调度分组名，唯一">
            <Input
              autoFocus
              value={formName}
              onChange={e => { setFormName(e.target.value); setFormError('') }}
              placeholder="default / team-a / internal"
            />
          </Field>
          <Field label="描述">
            <Input
              value={formDescription}
              onChange={e => setFormDescription(e.target.value)}
              placeholder="用途说明（可选）"
            />
          </Field>
          <Field label="成本倍率 (cost_multiplier)" hint="用于计费的分组倍率；建议 0.1 ~ 10，默认 1.000">
            <Input
              type="number"
              step="0.001"
              min="0.1"
              max="10"
              value={formMultiplier}
              onChange={e => { setFormMultiplier(e.target.value); setFormError('') }}
              placeholder="1.000"
            />
          </Field>
          <Field label="颜色" hint="日志和列表里这个组用的 pill 颜色;选「自动」则按组名哈希分配。">
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setFormColor('')}
                className={`px-2 py-1 rounded text-[11px] font-mono border transition-colors ${
                  formColor === ''
                    ? 'border-[var(--ink)] text-[var(--ink)] bg-[var(--surface)]'
                    : 'border-[var(--rule)] text-[var(--ink-3)] hover:text-[var(--ink-2)]'
                }`}
              >
                自动
              </button>
              {GROUP_COLORS.map(c => {
                const active = formColor === c.key
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setFormColor(c.key)}
                    title={c.label}
                    className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-mono border transition-colors ${
                      active
                        ? 'border-[var(--ink)]'
                        : 'border-[var(--rule)] hover:border-[var(--ink-3)]'
                    }`}
                    style={{ background: c.bg, color: c.fg }}
                  >
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ background: c.dot }}
                    />
                    {c.label}
                  </button>
                )
              })}
            </div>
          </Field>
          {formError && (
            <div className="text-[11px]" style={{ color: 'var(--err)' }}>
              {formError}
            </div>
          )}
        </div>
      </Modal>

      {/* delete confirm */}
      <Modal
        open={!!toDelete}
        title="删除账号组"
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
        {toDelete && (
          <p className="text-[12px] text-[var(--ink-2)] leading-relaxed">
            确定删除账号组「<span className="text-[var(--ink)]">{toDelete.name}</span>」？
            其下 <span className="tabular-nums">{toDelete.client_count}</span> 个客户端会被迁回默认组，
            <span className="tabular-nums">{toDelete.account_count}</span> 个账号会被设为共享池（group_id = NULL）。
            此操作不可撤销。
          </p>
        )}
      </Modal>
    </div>
  )
}
