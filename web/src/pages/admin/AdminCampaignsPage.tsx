import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api/client'
import {
  Button,
  Checkbox,
  Field,
  Input,
  Modal,
  Pill,
  Segmented,
  Select,
  Table,
} from '../../ui'
import type { Column } from '../../ui/Table'

type CampaignType = 'invite' | 'promotion' | 'referral' | 'other'
type CampaignStatus = 'active' | 'paused' | 'ended'

interface Campaign {
  id: string
  name: string
  type: string
  status: string
  start_at: string | null
  end_at: string | null
  max_uses: number | null
  current_uses: number
  invite_required: boolean
  code_prefix: string | null
  codes_per_user: number
  bind_window: string | null
  inviter_rewards: Record<string, unknown> | null
  invitee_rewards: Record<string, unknown> | null
  created_at: string
}

interface CampaignStats {
  total_codes: number
  total_uses: number
  total_rewards_issued: number
  top_inviters: Array<{ user: string; count: number }>
}

type Tab = 'list' | 'stats'
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

function toDateInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('zh-CN')
}

function statusTone(s: string): 'ok' | 'warn' | 'mute' | 'err' {
  switch (s) {
    case 'active': return 'ok'
    case 'paused': return 'warn'
    case 'ended': return 'mute'
    default: return 'mute'
  }
}

interface FormState {
  name: string
  type: CampaignType
  status: CampaignStatus
  start_at: string
  end_at: string
  max_uses: number
  invite_required: boolean
  code_prefix: string
  codes_per_user: number
  bind_window: string
  inviter_rewards_text: string
  invitee_rewards_text: string
}

function emptyForm(): FormState {
  return {
    name: '',
    type: 'invite',
    status: 'active',
    start_at: '',
    end_at: '',
    max_uses: 100,
    invite_required: true,
    code_prefix: '',
    codes_per_user: 5,
    bind_window: '5 days',
    inviter_rewards_text: '',
    invitee_rewards_text: '',
  }
}

function formFromCampaign(c: Campaign): FormState {
  return {
    name: c.name,
    type: (c.type as CampaignType) ?? 'invite',
    status: (c.status as CampaignStatus) ?? 'active',
    start_at: toDateInput(c.start_at),
    end_at: toDateInput(c.end_at),
    max_uses: c.max_uses ?? 0,
    invite_required: c.invite_required,
    code_prefix: c.code_prefix ?? '',
    codes_per_user: c.codes_per_user,
    bind_window: c.bind_window ?? '5 days',
    inviter_rewards_text: c.inviter_rewards ? JSON.stringify(c.inviter_rewards, null, 2) : '',
    invitee_rewards_text: c.invitee_rewards ? JSON.stringify(c.invitee_rewards, null, 2) : '',
  }
}

export default function AdminCampaignsPage() {
  const [tab, setTab] = useState<Tab>('list')
  const [items, setItems] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<ToastState>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Campaign | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const [toDelete, setToDelete] = useState<Campaign | null>(null)
  const [deleting, setDeleting] = useState(false)

  const [selectedId, setSelectedId] = useState<string>('')
  const [stats, setStats] = useState<CampaignStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api<{ campaigns: Campaign[] }>('/admin/campaigns')
      setItems(Array.isArray(data?.campaigns) ? data.campaigns : [])
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : '加载失败', tone: 'err' })
      setItems([])
    }
  }, [])

  useEffect(() => {
    load().finally(() => setLoading(false))
  }, [load])

  useEffect(() => {
    if (tab !== 'stats') return
    if (!selectedId && items.length > 0) {
      setSelectedId(items[0].id)
    }
  }, [tab, items, selectedId])

  useEffect(() => {
    if (tab !== 'stats' || !selectedId) {
      setStats(null)
      return
    }
    let cancelled = false
    setStatsLoading(true)
    api<CampaignStats>(`/admin/campaigns/${selectedId}/stats`)
      .then(r => { if (!cancelled) setStats(r) })
      .catch(e => {
        if (cancelled) return
        setStats(null)
        setToast({ message: e instanceof Error ? e.message : '加载统计失败', tone: 'err' })
      })
      .finally(() => { if (!cancelled) setStatsLoading(false) })
    return () => { cancelled = true }
  }, [tab, selectedId])

  const openCreate = () => {
    setEditing(null)
    setForm(emptyForm())
    setFormError('')
    setFormOpen(true)
  }

  const openEdit = (c: Campaign) => {
    setEditing(c)
    setForm(formFromCampaign(c))
    setFormError('')
    setFormOpen(true)
  }

  const submitForm = async () => {
    const name = form.name.trim()
    if (!name) { setFormError('请填写活动名称'); return }
    if (!form.end_at) { setFormError('必须设置截止时间'); return }
    if (!form.max_uses || form.max_uses <= 0) { setFormError('必须设置名额上限（> 0）'); return }

    let inviter_rewards: unknown = null
    let invitee_rewards: unknown = null
    try {
      if (form.inviter_rewards_text.trim()) inviter_rewards = JSON.parse(form.inviter_rewards_text)
    } catch {
      setFormError('邀请人奖励 JSON 解析失败')
      return
    }
    try {
      if (form.invitee_rewards_text.trim()) invitee_rewards = JSON.parse(form.invitee_rewards_text)
    } catch {
      setFormError('被邀请人奖励 JSON 解析失败')
      return
    }

    const endIso = new Date(form.end_at).toISOString()
    const startIso = form.start_at ? new Date(form.start_at).toISOString() : null

    const payload = {
      name,
      type: form.type,
      status: form.status,
      start_at: startIso,
      end_at: endIso,
      max_uses: form.max_uses,
      invite_required: form.invite_required,
      code_prefix: form.code_prefix.trim() || null,
      codes_per_user: form.codes_per_user,
      bind_window: form.bind_window.trim() || '5 days',
      inviter_rewards,
      invitee_rewards,
    }

    setSubmitting(true)
    setFormError('')
    try {
      if (editing) {
        await api(`/admin/campaigns/${editing.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
        setToast({ message: `已更新 ${name}`, tone: 'ok' })
      } else {
        await api('/admin/campaigns', { method: 'POST', body: JSON.stringify(payload) })
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
      await api(`/admin/campaigns/${toDelete.id}`, { method: 'DELETE' })
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

  const columns: Column<Campaign>[] = useMemo(() => [
    {
      key: 'name',
      header: '活动',
      render: (r) => (
        <span className="inline-flex items-center gap-2">
          <span className="text-[13px] text-[var(--ink)]">{r.name}</span>
          <Pill tone="info">{r.type}</Pill>
        </span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      render: (r) => <Pill tone={statusTone(r.status)}>{r.status}</Pill>,
    },
    {
      key: 'uses',
      header: '已用 / 名额',
      render: (r) => (
        <span className="tabular-nums text-[var(--ink-2)]">
          {r.current_uses} / {r.max_uses ?? '—'}
        </span>
      ),
    },
    {
      key: 'codes_per_user',
      header: '每人码数',
      render: (r) => <span className="tabular-nums text-[var(--ink-2)]">{r.codes_per_user}</span>,
    },
    {
      key: 'start_at',
      header: '开始',
      render: (r) => <span className="text-[var(--ink-2)]">{fmtDate(r.start_at)}</span>,
    },
    {
      key: 'end_at',
      header: '截止',
      render: (r) => <span className="text-[var(--ink-2)]">{fmtDate(r.end_at)}</span>,
    },
    {
      key: 'actions',
      header: <span className="block text-right">操作</span>,
      render: (r) => (
        <div className="flex items-center gap-1.5 justify-end">
          <Button size="sm" variant="default" onClick={() => { setSelectedId(r.id); setTab('stats') }}>统计</Button>
          <Button size="sm" variant="default" onClick={() => openEdit(r)}>编辑</Button>
          <Button size="sm" variant="danger" onClick={() => setToDelete(r)}>删除</Button>
        </div>
      ),
      className: 'text-right',
    },
  ], [])

  const selectedCampaign = items.find(c => c.id === selectedId) ?? null

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <Toast toast={toast} onClose={() => setToast(null)} />

      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-serif">推广活动</h1>
          <p className="text-[13px] text-[var(--mute)] mt-1">邀请 / 奖励活动配置与统计。创建活动必须设定截止时间与名额上限。</p>
        </div>
        <div className="flex items-center gap-2">
          <Segmented<Tab>
            value={tab}
            onChange={setTab}
            options={[
              { value: 'list', label: '活动' },
              { value: 'stats', label: '统计' },
            ]}
          />
          <Button variant="primary" onClick={openCreate}>新建活动</Button>
        </div>
      </header>

      {loading ? (
        <div className="text-[13px] text-[var(--mute)]">Loading…</div>
      ) : tab === 'list' ? (
        <div className="border border-[var(--rule)] rounded overflow-hidden bg-[var(--surface)]">
          <Table<Campaign>
            rows={items}
            columns={columns}
            emptyLabel="暂无活动。点击右上角新建。"
          />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Field label="选择活动" className="min-w-[280px]">
              <Select
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
              >
                <option value="">—</option>
                {items.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            </Field>
            {selectedCampaign && (
              <div className="text-[11px] font-mono text-[var(--ink-3)] flex items-center gap-2">
                <Pill tone={statusTone(selectedCampaign.status)}>{selectedCampaign.status}</Pill>
                <span>截止 {fmtDate(selectedCampaign.end_at)}</span>
              </div>
            )}
          </div>

          {!selectedId ? (
            <div className="p-6 text-[12px] text-[var(--ink-3)] border border-[var(--rule)] rounded bg-[var(--surface)]">
              请选择活动查看统计。
            </div>
          ) : statsLoading ? (
            <div className="text-[13px] text-[var(--mute)]">Loading…</div>
          ) : stats ? (
            <>
              <div className="grid grid-cols-3 gap-3">
                <StatTile label="邀请码总数" value={stats.total_codes} />
                <StatTile label="总使用次数" value={stats.total_uses} />
                <StatTile label="已发放奖励" value={stats.total_rewards_issued} />
              </div>

              <div className="border border-[var(--rule)] rounded overflow-hidden bg-[var(--surface)]">
                <div className="px-3 py-2 border-b border-[var(--rule)] text-[10px] font-mono uppercase tracking-wider text-[var(--ink-3)]">
                  Top 邀请人
                </div>
                <Table<{ id: string; user: string; count: number }>
                  rows={stats.top_inviters.map((r, i) => ({ id: `${i}-${r.user}`, ...r }))}
                  columns={[
                    { key: 'user', header: '用户', render: (r) => <span className="text-[var(--ink)]">{r.user}</span> },
                    { key: 'count', header: <span className="block text-right">绑定数</span>, render: (r) => <span className="tabular-nums text-[var(--ink-2)] block text-right">{r.count}</span>, className: 'text-right' },
                  ]}
                  emptyLabel="暂无邀请记录。"
                />
              </div>
            </>
          ) : (
            <div className="p-6 text-[12px] text-[var(--err)] border border-[var(--rule)] rounded bg-[var(--surface)]">
              统计加载失败。
            </div>
          )}
        </div>
      )}

      {/* create / edit modal */}
      <Modal
        open={formOpen}
        title={editing ? `编辑 ${editing.name}` : '新建活动'}
        onClose={() => setFormOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setFormOpen(false)}>取消</Button>
            <Button
              variant="primary"
              onClick={submitForm}
              disabled={submitting || !form.name.trim() || !form.end_at}
            >
              {submitting ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="名称">
              <Input
                autoFocus
                value={form.name}
                onChange={e => { setForm(f => ({ ...f, name: e.target.value })); setFormError('') }}
                placeholder="春季邀请活动"
              />
            </Field>
            <Field label="类型">
              <Select
                value={form.type}
                onChange={e => setForm(f => ({ ...f, type: e.target.value as CampaignType }))}
              >
                <option value="invite">邀请</option>
                <option value="promotion">推广</option>
                <option value="referral">推荐</option>
                <option value="other">其他</option>
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="状态">
              <Select
                value={form.status}
                onChange={e => setForm(f => ({ ...f, status: e.target.value as CampaignStatus }))}
              >
                <option value="active">active</option>
                <option value="paused">paused</option>
                <option value="ended">ended</option>
              </Select>
            </Field>
            <Field label="名额上限 (max_uses)" hint="不允许无上限">
              <Input
                type="number"
                min={1}
                value={form.max_uses}
                onChange={e => setForm(f => ({ ...f, max_uses: Number(e.target.value) }))}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="开始日期">
              <Input
                type="date"
                value={form.start_at}
                onChange={e => setForm(f => ({ ...f, start_at: e.target.value }))}
              />
            </Field>
            <Field label="截止日期" hint="必填">
              <Input
                type="date"
                value={form.end_at}
                onChange={e => { setForm(f => ({ ...f, end_at: e.target.value })); setFormError('') }}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="邀请码前缀">
              <Input
                value={form.code_prefix}
                onChange={e => setForm(f => ({ ...f, code_prefix: e.target.value }))}
                placeholder="SPR"
              />
            </Field>
            <Field label="每人码数 (codes_per_user)">
              <Input
                type="number"
                min={1}
                value={form.codes_per_user}
                onChange={e => setForm(f => ({ ...f, codes_per_user: Number(e.target.value) }))}
              />
            </Field>
          </div>

          <Field label="绑定窗口 (bind_window)" hint="PostgreSQL interval, 默认 5 days">
            <Input
              value={form.bind_window}
              onChange={e => setForm(f => ({ ...f, bind_window: e.target.value }))}
              placeholder="5 days"
            />
          </Field>

          <Checkbox
            label="需要邀请码"
            checked={form.invite_required}
            onChange={e => setForm(f => ({ ...f, invite_required: e.target.checked }))}
          />

          <Field label="邀请人奖励 (JSON)" hint="可选，例如 {&quot;type&quot;:&quot;balance&quot;,&quot;amount&quot;:10}">
            <textarea
              value={form.inviter_rewards_text}
              onChange={e => setForm(f => ({ ...f, inviter_rewards_text: e.target.value }))}
              rows={3}
              className="border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--ink)] rounded focus:outline-none focus:border-[var(--ink)] transition-shadow resize-y"
            />
          </Field>

          <Field label="被邀请人奖励 (JSON)" hint="可选">
            <textarea
              value={form.invitee_rewards_text}
              onChange={e => setForm(f => ({ ...f, invitee_rewards_text: e.target.value }))}
              rows={3}
              className="border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--ink)] rounded focus:outline-none focus:border-[var(--ink)] transition-shadow resize-y"
            />
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
        title="删除活动"
        onClose={() => setToDelete(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setToDelete(null)}>取消</Button>
            <Button variant="danger" onClick={submitDelete} disabled={deleting}>
              {deleting ? '删除中…' : '删除'}
            </Button>
          </>
        }
      >
        {toDelete && (
          <p className="text-[12px] text-[var(--ink-2)] leading-relaxed">
            确定删除活动「<span className="text-[var(--ink)]">{toDelete.name}</span>」？
            如该活动已生成邀请码，需先撤销全部邀请码后才能删除。
          </p>
        )}
      </Modal>
    </div>
  )
}

function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="border border-[var(--rule)] rounded bg-[var(--surface)] px-4 py-3">
      <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--ink-3)]">{label}</div>
      <div className="mt-1 text-[22px] font-serif tabular-nums text-[var(--ink)]">{value}</div>
    </div>
  )
}
