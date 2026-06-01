import { useEffect, useState } from 'react'
import { api } from '../../../api/client'
import { Button, Drawer, Field, Input, Pill, Select, dialog } from '../../../ui'

export interface UserClientRow {
  id: string
  user_id: string
  name: string
  status: string
  group_id: string | null
  group_name: string | null
  created_at: string
  approved_at: string | null
}

export interface UserRowData {
  id: string
  username: string
  email: string
  role: string
  status: string
  created_at: string
  clients?: UserClientRow[]
}

export interface UserGroupOption {
  id: string
  name: string
}

interface UserRowProps {
  user: UserRowData
  groups: UserGroupOption[]
  onChange: () => void
  onError?: (message: string) => void
}

interface PlanLite {
  id: string
  name: string
  type: string
  price: number | string
}

type CapKind = '5h' | '1d' | '7d' | '30d'
type SubCap = { limit: number; used: number } | null

interface SubscriptionRow {
  id: string
  plan_id: string
  plan_name: string | null
  plan_type: string | null
  status: string
  balance: number | string | null
  expires_at: string | null
  remaining_uses: number | null
  created_at: string
  usable?: boolean
  caps?: Record<CapKind, SubCap>
}

const CAP_LABELS: Record<CapKind, string> = {
  '5h':  '5 小时',
  '1d':  '24 小时',
  '7d':  '7 天',
  '30d': '30 天',
}

type DecisionKind =
  | 'new_pool' | 'renew_pool' | 'upgrade_pool' | 'downgrade_pool'
  | 'new_quota' | 'merge_quota'

interface Decision {
  kind: DecisionKind
  plan: { id: string; name: string; type: 'pool' | 'quota'; currency: string; price: number }
  charge_cny: number
  add_usd: number
  new_expires_at: string | null
  rate: number
  summary: string
  details: { label: string; value: string }[]
}

const DECISION_LABELS: Record<DecisionKind, { text: string; tone: 'ok' | 'info' | 'accent' | 'warn' }> = {
  new_pool:       { text: '新开订阅',   tone: 'accent' },
  renew_pool:     { text: '续期',       tone: 'ok' },
  upgrade_pool:   { text: '升级 / 切换', tone: 'info' },
  downgrade_pool: { text: '降级',       tone: 'warn' },
  new_quota:      { text: '新开额度',   tone: 'info' },
  merge_quota:    { text: '追加额度',   tone: 'ok' },
}

function rolePill(role: string) {
  return <Pill tone={role === 'admin' ? 'accent' : 'info'}>{role}</Pill>
}

function statusPill(status: string) {
  const tone = status === 'active' ? 'ok' : status === 'banned' ? 'err' : 'warn'
  return <Pill tone={tone}>{status}</Pill>
}

function clientStatusPill(status: string) {
  if (status === 'active') return <Pill tone="ok">启用</Pill>
  if (status === 'pending') return <Pill tone="warn">待审核</Pill>
  if (status === 'suspended') return <Pill tone="err">已停用</Pill>
  return <Pill tone="mute">{status}</Pill>
}

function reportError(err: unknown, onError?: (m: string) => void) {
  const msg = err instanceof Error ? err.message : '操作失败'
  if (onError) onError(msg)
  else void dialog.alert(msg)
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function toDateInputValue(value: string | null | undefined): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export default function UserRow({ user, groups, onChange, onError }: UserRowProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [drawer, setDrawer] = useState(false)

  async function ban() {
    if (!(await dialog.confirm(`封禁 ${user.email}？\n该用户名下所有 client 将立刻失效。`, { danger: true }))) return
    setBusy(true)
    try {
      await api(`/admin/users/${user.id}/ban`, { method: 'POST' })
      onChange()
    } catch (err) { reportError(err, onError) } finally { setBusy(false) }
  }

  async function unban() {
    setBusy(true)
    try {
      await api(`/admin/users/${user.id}/unban`, { method: 'POST' })
      onChange()
    } catch (err) { reportError(err, onError) } finally { setBusy(false) }
  }

  async function setClientGroup(clientId: string, groupId: string) {
    setBusy(true)
    try {
      // 'auto' / '' → null（后端会自动分配 multiplier 最低分组）
      const payload = groupId === '' || groupId === 'auto' ? null : groupId
      await api(`/admin/groups/clients/${clientId}`, {
        method: 'POST',
        body: JSON.stringify({ groupId: payload }),
      })
      onChange()
    } catch (err) { reportError(err, onError) } finally { setBusy(false) }
  }

  async function approveClient(id: string) {
    setBusy(true)
    try {
      await api(`/admin/clients/${id}/approve`, { method: 'POST' })
      onChange()
    } catch (err) { reportError(err, onError) } finally { setBusy(false) }
  }

  async function rejectClient(id: string, name: string) {
    if (!(await dialog.confirm(`驳回并删除客户端「${name}」？此操作不可恢复。`, { danger: true }))) return
    setBusy(true)
    try {
      await api(`/admin/clients/${id}/reject`, { method: 'POST' })
      onChange()
    } catch (err) { reportError(err, onError) } finally { setBusy(false) }
  }

  async function suspendClient(id: string, name: string) {
    if (!(await dialog.confirm(`停用客户端「${name}」？用户将无法继续使用该 client。`, { danger: true }))) return
    setBusy(true)
    try {
      await api(`/clients/${id}/suspend`, { method: 'POST' })
      onChange()
    } catch (err) { reportError(err, onError) } finally { setBusy(false) }
  }

  async function activateClient(id: string) {
    setBusy(true)
    try {
      await api(`/clients/${id}/activate`, { method: 'POST' })
      onChange()
    } catch (err) { reportError(err, onError) } finally { setBusy(false) }
  }

  const clients = user.clients ?? []

  return (
    <>
      <tr className="border-b border-[var(--rule)]">
        <td className="px-3 py-2 text-[var(--ink)]">{user.email}</td>
        <td className="px-3 py-2 text-[var(--ink-2)]">{user.username}</td>
        <td className="px-3 py-2">{rolePill(user.role)}</td>
        <td className="px-3 py-2">{statusPill(user.status)}</td>
        <td className="px-3 py-2 tabular-nums text-[var(--ink-2)]">{clients.length}</td>
        <td className="px-3 py-2">
          <div className="flex flex-wrap gap-1.5 justify-end">
            <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>
              {open ? '收起' : '展开'}
            </Button>
            <Button size="sm" variant="default" disabled={busy} onClick={() => setDrawer(true)}>
              编辑
            </Button>
            {user.status === 'active'
              ? <Button size="sm" variant="danger" disabled={busy} onClick={ban}>封禁</Button>
              : <Button size="sm" variant="default" disabled={busy} onClick={unban}>解封</Button>}
          </div>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} className="bg-[var(--rule-2)] px-4 py-3">
            {clients.length === 0
              ? <div className="text-[12px] text-[var(--ink-3)]">该用户没有 client。</div>
              : (
                <table className="w-full text-[12px] border-collapse">
                  <thead>
                    <tr className="text-left font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">
                      <th className="px-2 py-1.5">名称</th>
                      <th className="px-2 py-1.5">状态</th>
                      <th className="px-2 py-1.5">账号组</th>
                      <th className="px-2 py-1.5">创建时间</th>
                      <th className="px-2 py-1.5 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clients.map((c) => (
                      <tr key={c.id} className="border-t border-[var(--rule)]">
                        <td className="px-2 py-1.5 text-[var(--ink)]">{c.name}</td>
                        <td className="px-2 py-1.5">{clientStatusPill(c.status)}</td>
                        <td className="px-2 py-1.5">
                          <Select
                            value={c.group_id ?? ''}
                            disabled={busy}
                            onChange={(e) => setClientGroup(c.id, e.target.value)}
                          >
                            <option value="">自动（auto）</option>
                            {groups.map((g) => (
                              <option key={g.id} value={g.id}>{g.name}</option>
                            ))}
                          </Select>
                        </td>
                        <td className="px-2 py-1.5 text-[var(--ink-3)] tabular-nums">
                          {fmtDate(c.created_at)}
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="flex flex-wrap gap-1 justify-end">
                            {c.status === 'pending' && (
                              <>
                                <Button size="sm" variant="primary" disabled={busy}
                                  onClick={() => approveClient(c.id)}>审核通过</Button>
                                <Button size="sm" variant="danger" disabled={busy}
                                  onClick={() => rejectClient(c.id, c.name)}>驳回</Button>
                              </>
                            )}
                            {c.status === 'active' && (
                              <Button size="sm" variant="danger" disabled={busy}
                                onClick={() => suspendClient(c.id, c.name)}>停用</Button>
                            )}
                            {c.status === 'suspended' && (
                              <Button size="sm" variant="default" disabled={busy}
                                onClick={() => activateClient(c.id)}>启用</Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </td>
        </tr>
      )}

      {drawer && (
        <UserEditDrawer
          user={user}
          onClose={() => setDrawer(false)}
          onChange={onChange}
          onError={onError}
        />
      )}
    </>
  )
}

function UserEditDrawer({
  user, onClose, onChange, onError,
}: {
  user: UserRowData
  onClose: () => void
  onChange: () => void
  onError?: (m: string) => void
}) {
  const [plans, setPlans] = useState<PlanLite[]>([])
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  // Assign-plan form state
  const [planId, setPlanId] = useState('')
  const [balance, setBalance] = useState('')
  const [expiresAt, setExpiresAt] = useState('')

  // Adjust-balance form state (for the current active sub)
  const [adjBalance, setAdjBalance] = useState('')

  // Grant preview modal state
  const [grantPreview, setGrantPreview] = useState<
    | { loading: boolean; decision: Decision | null; error: string | null; payload: { plan_id: string; balance?: number; expires_at?: string } }
    | null
  >(null)

  async function load() {
    setLoading(true)
    try {
      const [planList, subs] = await Promise.all([
        api<PlanLite[]>('/admin/plans'),
        api<{ subscriptions: SubscriptionRow[] }>(`/admin/users/${user.id}/subscriptions`),
      ])
      setPlans(Array.isArray(planList) ? planList : [])
      setSubscriptions(subs.subscriptions ?? [])
      const actives = (subs.subscriptions ?? []).filter((s) => s.status === 'active')
      const activeQuotaRow = actives.find((s) => s.plan_type === 'quota') ?? null
      setAdjBalance(activeQuotaRow?.balance != null ? String(activeQuotaRow.balance) : '')
      setPlanId(actives[0]?.plan_id ?? (Array.isArray(planList) && planList[0]?.id) ?? '')
    } catch (err) {
      reportError(err, onError)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const activeQuota = subscriptions.find((s) => s.status === 'active' && s.plan_type === 'quota') ?? null
  const activePool = subscriptions.find((s) => s.status === 'active' && s.plan_type !== 'quota') ?? null

  async function setRole(role: 'admin' | 'user') {
    if (role === 'admin' && !(await dialog.confirm(`将 ${user.email} 提升为管理员？`))) return
    if (role === 'user' && !(await dialog.confirm(`撤销 ${user.email} 的管理员权限？`, { danger: true }))) return
    setBusy(true)
    try {
      await api(`/admin/users/${user.id}/role`, {
        method: 'POST',
        body: JSON.stringify({ role }),
      })
      onChange()
    } catch (err) { reportError(err, onError) } finally { setBusy(false) }
  }

  async function previewGrant() {
    if (!planId) {
      reportError(new Error('请选择套餐'), onError)
      return
    }
    const payload: { plan_id: string; balance?: number; expires_at?: string } = { plan_id: planId }
    if (balance.trim() !== '') payload.balance = Number(balance)
    if (expiresAt.trim() !== '') payload.expires_at = new Date(`${expiresAt}T23:59:59`).toISOString()

    setGrantPreview({ loading: true, decision: null, error: null, payload })
    try {
      const decision = await api<Decision>(`/admin/users/${user.id}/subscriptions/preview`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      setGrantPreview((cur) => cur ? { ...cur, loading: false, decision } : cur)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '预览失败'
      setGrantPreview((cur) => cur ? { ...cur, loading: false, error: msg } : cur)
    }
  }

  async function confirmGrant() {
    if (!grantPreview || !grantPreview.decision) return
    setBusy(true)
    try {
      await api(`/admin/users/${user.id}/subscriptions`, {
        method: 'POST',
        body: JSON.stringify(grantPreview.payload),
      })
      setBalance('')
      setExpiresAt('')
      setGrantPreview(null)
      onChange()
      await load()
    } catch (err) { reportError(err, onError) } finally { setBusy(false) }
  }

  async function adjustBalance() {
    if (!activeQuota) return
    if (adjBalance.trim() === '') {
      reportError(new Error('余额不能为空'), onError)
      return
    }
    setBusy(true)
    try {
      await api(`/admin/plans/subscriptions/${activeQuota.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ balance: Number(adjBalance) }),
      })
      onChange()
      await load()
    } catch (err) { reportError(err, onError) } finally { setBusy(false) }
  }

  async function revokeSubscription(sub: SubscriptionRow) {
    const isQuota = sub.plan_type === 'quota'
    const msg = isQuota
      ? `清空 ${user.email} 的当前额度？\n该额度记录将被置为 cancelled，用户无法继续使用。`
      : `取消 ${user.email} 的当前订阅？\n该订阅将被标记为 cancelled。`
    if (!(await dialog.confirm(msg, { danger: true }))) return
    setBusy(true)
    try {
      await api(`/admin/plans/subscriptions/${sub.id}`, { method: 'DELETE' })
      onChange()
      await load()
    } catch (err) { reportError(err, onError) } finally { setBusy(false) }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={`编辑用户 · ${user.email}`}
      width={520}
      footer={
        <Button variant="default" onClick={onClose}>关闭</Button>
      }
    >
      {loading ? (
        <div className="text-[12px] text-[var(--ink-3)]">加载中…</div>
      ) : (
        <div className="space-y-5">
          {/* Basic info */}
          <section className="space-y-2">
            <h3 className="text-[10px] uppercase tracking-[0.14em] font-mono text-[var(--ink-3)]">基本信息</h3>
            <div className="grid grid-cols-2 gap-2 text-[12px]">
              <div className="bg-[var(--rule-2)] px-3 py-2 rounded">
                <div className="text-[var(--ink-3)]">用户名</div>
                <div className="text-[var(--ink)]">{user.username}</div>
              </div>
              <div className="bg-[var(--rule-2)] px-3 py-2 rounded">
                <div className="text-[var(--ink-3)]">邮箱</div>
                <div className="text-[var(--ink)] truncate" title={user.email}>{user.email}</div>
              </div>
              <div className="bg-[var(--rule-2)] px-3 py-2 rounded">
                <div className="text-[var(--ink-3)]">角色</div>
                <div className="mt-0.5">{rolePill(user.role)}</div>
              </div>
              <div className="bg-[var(--rule-2)] px-3 py-2 rounded">
                <div className="text-[var(--ink-3)]">账号状态</div>
                <div className="mt-0.5">{statusPill(user.status)}</div>
              </div>
            </div>
            <div className="flex gap-1.5">
              {user.role === 'user'
                ? <Button size="sm" variant="default" disabled={busy} onClick={() => setRole('admin')}>提升为管理员</Button>
                : <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRole('user')}>撤销管理员</Button>}
            </div>
          </section>

          {/* Current active — quota and pool coexist, render each independently. */}
          {activeQuota && (
            <section className="space-y-2">
              <h3 className="text-[10px] uppercase tracking-[0.14em] font-mono text-[var(--ink-3)]">当前额度</h3>
              <div className="border border-[var(--rule)] rounded p-3 space-y-2 text-[12px]">
                <div className="flex items-baseline gap-2">
                  <span className="text-[var(--ink)] font-medium">{activeQuota.plan_name ?? '—'}</span>
                  <Pill tone="info">额度</Pill>
                  <Pill tone="ok">active</Pill>
                </div>
                <div className="text-[var(--ink-2)]">
                  剩余额度：<span className="text-[var(--ink)] font-mono tabular-nums">{activeQuota.balance ?? '—'}</span>
                </div>
                <div className="pt-2 border-t border-[var(--rule)] flex items-end gap-2">
                  <Field label="直接设置余额" className="flex-1">
                    <Input
                      type="number"
                      step="0.01"
                      value={adjBalance}
                      onChange={(e) => setAdjBalance(e.target.value)}
                    />
                  </Field>
                  <Button size="sm" variant="primary" disabled={busy} onClick={adjustBalance}>保存</Button>
                  <Button size="sm" variant="danger" disabled={busy} onClick={() => revokeSubscription(activeQuota)}>清空额度</Button>
                </div>
                <div className="text-[10px] text-[var(--ink-3)]">
                  额度型套餐：再次发放会自动合并到当前余额；也可在此直接增减。
                </div>
              </div>
            </section>
          )}
          {activePool && (
            <section className="space-y-2">
              <h3 className="text-[10px] uppercase tracking-[0.14em] font-mono text-[var(--ink-3)]">当前订阅</h3>
              <div className="border border-[var(--rule)] rounded p-3 space-y-2 text-[12px]">
                <div className="flex items-baseline gap-2">
                  <span className="text-[var(--ink)] font-medium">{activePool.plan_name ?? '—'}</span>
                  <Pill tone="accent">{activePool.plan_type ?? '订阅'}</Pill>
                  {activePool.usable === false ? <Pill tone="warn">capped</Pill> : <Pill tone="ok">active</Pill>}
                </div>
                <div className="grid grid-cols-2 gap-2 text-[var(--ink-2)]">
                  <div>到期：<span className="text-[var(--ink)] font-mono">{fmtDate(activePool.expires_at)}</span></div>
                  {activePool.remaining_uses != null && (
                    <div>剩余次数：<span className="text-[var(--ink)] font-mono tabular-nums">{activePool.remaining_uses}</span></div>
                  )}
                </div>
                {activePool.caps && (() => {
                  const rows = (Object.entries(activePool.caps) as Array<[CapKind, SubCap]>)
                    .filter(([, v]) => v !== null) as Array<[CapKind, { limit: number; used: number }]>
                  if (rows.length === 0) {
                    return <div className="text-[11px] text-[var(--ink-3)]">此套餐未设置用量上限</div>
                  }
                  return (
                    <div className="pt-1 space-y-1">
                      <div className="text-[10px] uppercase tracking-[0.12em] font-mono text-[var(--ink-3)]">用量窗口</div>
                      {rows.map(([kind, v]) => {
                        const pct = Math.min(100, Math.max(0, (v.used / v.limit) * 100))
                        const hit = v.used >= v.limit
                        const warn = pct >= 80 && !hit
                        const barColor = hit ? 'var(--err)' : warn ? 'var(--warn)' : 'var(--accent)'
                        return (
                          <div key={kind}>
                            <div className="flex items-baseline justify-between text-[11px]">
                              <span className="text-[var(--ink-3)]">{CAP_LABELS[kind]}</span>
                              <span className={`font-mono tabular-nums ${hit ? 'text-[var(--err)]' : 'text-[var(--ink)]'}`}>
                                ${v.used.toFixed(4)} / ${v.limit.toFixed(2)}
                              </span>
                            </div>
                            <div className="mt-0.5 h-[3px] rounded-full bg-[var(--rule)] overflow-hidden">
                              <div style={{ width: `${pct}%`, background: barColor, height: '100%', transition: 'width 180ms ease' }} />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}
                <div className="pt-2 border-t border-[var(--rule)] flex justify-end">
                  <Button size="sm" variant="danger" disabled={busy} onClick={() => revokeSubscription(activePool)}>取消订阅</Button>
                </div>
              </div>
            </section>
          )}

          {/* Grant — framing depends on picked plan.type */}
          <section className="space-y-2">
            <h3 className="text-[10px] uppercase tracking-[0.14em] font-mono text-[var(--ink-3)]">
              {(() => {
                const p = plans.find((x) => x.id === planId)
                if (!p) return '发放套餐'
                return p.type === 'quota' ? '发放额度' : '分配订阅'
              })()}
            </h3>
            <div className="border border-[var(--rule)] rounded p-3 space-y-2">
              <Field label="套餐">
                <Select value={planId} onChange={(e) => setPlanId(e.target.value)}>
                  <optgroup label="额度型">
                    {plans.filter((p) => p.type === 'quota').map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}（¥{p.price}）
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="订阅型">
                    {plans.filter((p) => p.type !== 'quota').map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}（{p.type} · ¥{p.price}）
                      </option>
                    ))}
                  </optgroup>
                </Select>
              </Field>

              {(() => {
                const p = plans.find((x) => x.id === planId)
                if (!p) return null
                if (p.type === 'quota') {
                  return (
                    <Field label="发放额度（可选，留空使用套餐默认 quota_amount）">
                      <Input
                        type="number"
                        step="0.01"
                        placeholder="¥"
                        value={balance}
                        onChange={(e) => setBalance(e.target.value)}
                      />
                    </Field>
                  )
                }
                return (
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="初始余额（可选）">
                      <Input
                        type="number"
                        step="0.01"
                        placeholder="留空使用套餐默认"
                        value={balance}
                        onChange={(e) => setBalance(e.target.value)}
                      />
                    </Field>
                    <Field label="到期日（可选，留空=按 duration_days）">
                      <Input
                        type="date"
                        value={expiresAt}
                        onChange={(e) => setExpiresAt(e.target.value)}
                      />
                    </Field>
                  </div>
                )
              })()}

              <div className="flex justify-end">
                <Button size="sm" variant="primary" disabled={busy} onClick={previewGrant}>
                  预览变更…
                </Button>
              </div>
              <div className="text-[10px] text-[var(--ink-3)]">
                发放前会先计算变更方案（续期 / 升级 / 降级 / 合并 / 新开），确认后才执行。
              </div>
            </div>
          </section>

          {/* Subscription history */}
          {subscriptions.length > 1 && (
            <section className="space-y-2">
              <h3 className="text-[10px] uppercase tracking-[0.14em] font-mono text-[var(--ink-3)]">历史记录</h3>
              <div className="border border-[var(--rule)] rounded overflow-hidden">
                <table className="w-full text-[11px] border-collapse">
                  <thead>
                    <tr className="text-left font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)] bg-[var(--rule-2)]">
                      <th className="px-2 py-1.5">套餐</th>
                      <th className="px-2 py-1.5">类型</th>
                      <th className="px-2 py-1.5">状态</th>
                      <th className="px-2 py-1.5">余额</th>
                      <th className="px-2 py-1.5">到期</th>
                      <th className="px-2 py-1.5">创建</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subscriptions.map((s) => (
                      <tr key={s.id} className="border-t border-[var(--rule)]">
                        <td className="px-2 py-1.5">{s.plan_name ?? '—'}</td>
                        <td className="px-2 py-1.5">
                          <Pill tone={s.plan_type === 'quota' ? 'info' : 'accent'}>
                            {s.plan_type === 'quota' ? '额度' : (s.plan_type ?? '订阅')}
                          </Pill>
                        </td>
                        <td className="px-2 py-1.5">
                          <Pill tone={s.status === 'active' ? 'ok' : s.status === 'merged' ? 'info' : s.status === 'cancelled' ? 'mute' : 'warn'}>
                            {s.status === 'merged' ? '已合并' : s.status}
                          </Pill>
                        </td>
                        <td className="px-2 py-1.5 font-mono tabular-nums">{s.balance ?? '—'}</td>
                        <td className="px-2 py-1.5 font-mono text-[var(--ink-3)]">{toDateInputValue(s.expires_at) || '—'}</td>
                        <td className="px-2 py-1.5 font-mono text-[var(--ink-3)]">{toDateInputValue(s.created_at) || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}

      {grantPreview && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/35 backdrop-blur-[1px]"
            onClick={() => !busy && setGrantPreview(null)}
          />
          <div className="relative bg-[var(--surface)] border border-[var(--rule)] rounded shadow-[0_10px_40px_rgba(0,0,0,0.18)] w-full max-w-[480px] mx-4 overflow-hidden">
            <div className="px-5 py-4 border-b border-[var(--rule)]">
              <div className="flex items-center gap-2">
                <h3 className="text-[13px] font-medium text-[var(--ink)]">发放变更预览</h3>
                {grantPreview.decision && (
                  <Pill tone={DECISION_LABELS[grantPreview.decision.kind].tone}>
                    {DECISION_LABELS[grantPreview.decision.kind].text}
                  </Pill>
                )}
              </div>
              <div className="text-[11px] text-[var(--ink-3)] mt-1">
                用户：{user.email}
              </div>
            </div>

            <div className="px-5 py-4 max-h-[380px] overflow-y-auto">
              {grantPreview.loading && (
                <div className="py-4 text-center text-[12px] text-[var(--ink-3)]">正在计算方案…</div>
              )}
              {grantPreview.error && (
                <div className="py-2 px-3 rounded bg-[var(--err)]/5 text-[12px] text-[var(--err)]">
                  预览失败：{grantPreview.error}
                </div>
              )}
              {grantPreview.decision && (
                <div className="space-y-3">
                  <p className="text-[12px] text-[var(--ink)] leading-relaxed">
                    {grantPreview.decision.summary}
                  </p>
                  <dl className="divide-y divide-[var(--rule)] border-y border-[var(--rule)]">
                    {grantPreview.decision.details.map((d, i) => (
                      <div key={i} className="flex items-center justify-between py-2 gap-3">
                        <dt className="text-[11px] text-[var(--ink-3)] flex-shrink-0">{d.label}</dt>
                        <dd className="text-[12px] text-[var(--ink)] text-right tabular-nums font-mono">{d.value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-[var(--rule)] flex justify-end gap-2">
              <Button size="sm" variant="default" disabled={busy} onClick={() => setGrantPreview(null)}>
                取消
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={busy || grantPreview.loading || !!grantPreview.error || !grantPreview.decision}
                onClick={confirmGrant}
              >
                {busy ? '执行中…' : '确认发放'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Drawer>
  )
}
