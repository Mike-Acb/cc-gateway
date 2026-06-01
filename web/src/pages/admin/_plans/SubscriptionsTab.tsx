import { useCallback, useEffect, useState } from 'react'
import { api } from '../../../api/client'
import {
  Button,
  Field,
  Input,
  Modal,
  Pill,
  Select,
  Table,
  dialog,
} from '../../../ui'
import type { Column } from '../../../ui/Table'
import type { Plan } from './PlanTab'

interface Subscription {
  id: string
  user_id: string
  plan_id: string
  status: string
  balance: string | null
  starts_at: string | null
  expires_at: string | null
  created_at: string
  username?: string
  email?: string
  plan_name?: string
  plan_type?: 'quota' | 'pool'
}

interface AdminUserRow {
  id: string
  username: string
  email: string
}

type GrantForm = { user_id: string; plan_id: string; balance: string; expires_at: string }
type AdjustForm = { user_id: string; username: string; amount: string; note: string }

function toneForStatus(s: string): 'ok' | 'warn' | 'err' | 'mute' {
  if (s === 'active') return 'ok'
  if (s === 'pending') return 'warn'
  if (s === 'cancelled') return 'mute'
  return 'err'
}

export default function SubscriptionsTab() {
  const [rows, setRows] = useState<Subscription[]>([])
  const [plans, setPlans] = useState<Plan[]>([])
  const [users, setUsers] = useState<AdminUserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const [granting, setGranting] = useState(false)
  const [grant, setGrant] = useState<GrantForm>({ user_id: '', plan_id: '', balance: '', expires_at: '' })
  const [adjust, setAdjust] = useState<AdjustForm | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const [subs, p, u] = await Promise.all([
        api<Subscription[]>('/admin/plans/subscriptions'),
        api<Plan[]>('/admin/plans'),
        api<{ users: AdminUserRow[] }>('/admin/users?limit=200'),
      ])
      setRows(Array.isArray(subs) ? subs : [])
      setPlans(Array.isArray(p) ? p : [])
      setUsers(u.users ?? [])
    } catch (e: any) {
      setErr(e?.message ?? '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function doGrant() {
    if (!grant.user_id || !grant.plan_id) return
    setBusy(true)
    try {
      const body: Record<string, unknown> = {
        user_id: grant.user_id,
        plan_id: grant.plan_id,
      }
      if (grant.balance !== '') body.balance = Number(grant.balance)
      if (grant.expires_at !== '') body.expires_at = grant.expires_at
      await api('/admin/plans/subscriptions/grant', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setGranting(false)
      setGrant({ user_id: '', plan_id: '', balance: '', expires_at: '' })
      await load()
    } catch (e: any) {
      await dialog.alert(e?.message ?? '授予失败')
    } finally {
      setBusy(false)
    }
  }

  async function doRevoke(s: Subscription) {
    if (!(await dialog.confirm(`撤销 ${s.username ?? s.user_id} 的订阅 ${s.plan_name ?? ''}？`, { danger: true }))) return
    try {
      await api(`/admin/plans/subscriptions/${s.id}`, { method: 'DELETE' })
      await load()
    } catch (e: any) {
      await dialog.alert(e?.message ?? '撤销失败')
    }
  }

  async function doAdjust() {
    if (!adjust) return
    const amt = Number(adjust.amount)
    if (!Number.isFinite(amt) || amt === 0) {
      await dialog.alert('金额必须为非零数字')
      return
    }
    setBusy(true)
    try {
      await api(`/admin/users/${adjust.user_id}/balance/adjust`, {
        method: 'POST',
        body: JSON.stringify({ amount: amt, note: adjust.note }),
      })
      setAdjust(null)
      await load()
    } catch (e: any) {
      await dialog.alert(e?.message ?? '调整失败')
    } finally {
      setBusy(false)
    }
  }

  const columns: Column<Subscription>[] = [
    { key: 'user', header: '用户', render: (r) => (
      <div className="flex flex-col">
        <span className="text-[var(--ink)] font-medium">{r.username ?? '-'}</span>
        <span className="text-[10px] text-[var(--ink-3)] font-mono">{r.email ?? ''}</span>
      </div>
    ) },
    { key: 'plan', header: '套餐', render: (r) => (
      <div className="flex items-center gap-2">
        <span className="font-mono">{r.plan_name ?? '-'}</span>
        <Pill tone={r.plan_type === 'quota' ? 'info' : 'warn'}>
          {r.plan_type === 'quota' ? '按量' : '订阅'}
        </Pill>
      </div>
    ) },
    { key: 'balance', header: '余额', render: (r) => (
      <span className="font-mono tabular-nums">${Number(r.balance ?? 0).toFixed(2)}</span>
    ) },
    { key: 'expires', header: '到期', render: (r) => (
      <span className="font-mono text-[11px]">
        {r.expires_at ? new Date(r.expires_at).toLocaleDateString() : '永久'}
      </span>
    ) },
    { key: 'status', header: '状态', render: (r) => <Pill tone={toneForStatus(r.status)}>{r.status}</Pill> },
    { key: 'actions', header: '', render: (r) => (
      <div className="flex gap-1">
        {r.plan_type === 'quota' && r.status === 'active' && (
          <Button size="sm" variant="ghost" onClick={() => setAdjust({
            user_id: r.user_id,
            username: r.username ?? r.user_id,
            amount: '',
            note: '',
          })}>调余额</Button>
        )}
        {r.status === 'active' && (
          <Button size="sm" variant="ghost" onClick={() => doRevoke(r)}>撤销</Button>
        )}
      </div>
    ) },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[12px] text-[var(--ink-3)]">共 {rows.length} 个活跃订阅</div>
        <Button variant="primary" size="sm" onClick={() => setGranting(true)}>手动授予</Button>
      </div>

      {err && <div className="border border-[var(--err)] text-[var(--err)] text-[12px] px-3 py-2 rounded">{err}</div>}

      <div className="border border-[var(--rule)] rounded overflow-hidden">
        {loading
          ? <div className="p-6 text-center text-[12px] text-[var(--ink-3)]">加载中…</div>
          : <Table<Subscription> rows={rows} columns={columns} emptyLabel="暂无订阅。" />
        }
      </div>

      <Modal
        open={granting}
        onClose={() => setGranting(false)}
        title="手动授予订阅"
        footer={
          <>
            <Button variant="ghost" onClick={() => setGranting(false)}>取消</Button>
            <Button
              variant="primary"
              disabled={busy || !grant.user_id || !grant.plan_id}
              onClick={doGrant}
            >{busy ? '处理中…' : '授予'}</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="用户">
            <Select value={grant.user_id} onChange={(e) => setGrant({ ...grant, user_id: e.target.value })}>
              <option value="">选择…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.username} ({u.email})</option>
              ))}
            </Select>
          </Field>
          <Field label="套餐">
            <Select value={grant.plan_id} onChange={(e) => setGrant({ ...grant, plan_id: e.target.value })}>
              <option value="">选择…</option>
              {plans.filter((p) => p.enabled).map((p) => (
                <option key={p.id} value={p.id}>{p.name} — {p.type}</option>
              ))}
            </Select>
          </Field>
          <Field label="初始余额（可选，留空使用 plan.quota_amount）">
            <Input
              type="number"
              step="0.01"
              value={grant.balance}
              onChange={(e) => setGrant({ ...grant, balance: e.target.value })}
            />
          </Field>
          <Field label="到期时间（可选，留空使用 plan.duration_days）">
            <Input
              type="date"
              value={grant.expires_at}
              onChange={(e) => setGrant({ ...grant, expires_at: e.target.value })}
            />
          </Field>
        </div>
      </Modal>

      <Modal
        open={adjust !== null}
        onClose={() => setAdjust(null)}
        title={adjust ? `调整余额 — ${adjust.username}` : '调整余额'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdjust(null)}>取消</Button>
            <Button
              variant="primary"
              disabled={busy || !adjust?.amount}
              onClick={doAdjust}
            >{busy ? '处理中…' : '确认'}</Button>
          </>
        }
      >
        {adjust && (
          <div className="space-y-3">
            <Field label="金额 ($)（正数为充值，负数为扣款）">
              <Input
                type="number"
                step="0.01"
                value={adjust.amount}
                onChange={(e) => setAdjust({ ...adjust, amount: e.target.value })}
              />
            </Field>
            <Field label="备注">
              <Input
                value={adjust.note}
                onChange={(e) => setAdjust({ ...adjust, note: e.target.value })}
                placeholder="管理员手动调账"
              />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  )
}
