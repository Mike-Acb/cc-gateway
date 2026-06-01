import { useEffect, useState, useCallback } from 'react'
import { api } from '../../api/client'
import { dialog } from '../../ui'

/* ========================================================================== */
/*  Shared constants & helpers                                                */
/* ========================================================================== */

const CARD_CLS = 'bg-white rounded-[14px] shadow-[0_1px_2px_rgba(0,0,0,0.04)] p-5'
const INPUT_CLS = 'w-full px-3 py-2 border border-[#d2d2d7] rounded-lg text-[14px] text-[#1d1d1f] placeholder:text-[#aeaeb2] focus:outline-none focus:ring-2 focus:ring-[#007aff]/30 focus:border-[#007aff] transition-colors'
const BTN_PRIMARY = 'px-4 py-2 bg-[#007aff] text-white text-[13px] font-medium rounded-lg hover:bg-[#0066d6] disabled:opacity-40 disabled:cursor-not-allowed transition-colors'
const BTN_SECONDARY = 'px-3 py-1.5 text-[12px] font-medium text-[#007aff] bg-[#007aff]/5 rounded-lg hover:bg-[#007aff]/10 transition-colors'
const BTN_DANGER = 'px-3 py-1.5 text-[12px] font-medium text-[#ff3b30] bg-[#ff3b30]/5 rounded-lg hover:bg-[#ff3b30]/10 transition-colors'

function fmtDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function fmtDateTime(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function Modal({ open, onClose, children }: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl p-6 w-full max-w-lg mx-4 max-h-[80vh] overflow-y-auto">
        {children}
      </div>
    </div>
  )
}

function LoadingView() {
  return (
    <div className="flex items-center justify-center h-64 text-[#86868b] text-[13px]">
      加载中...
    </div>
  )
}

function EmptyView({ text }: { text: string }) {
  return (
    <div className={`${CARD_CLS} text-center text-[#86868b] text-[13px] py-12`}>
      {text}
    </div>
  )
}

/* ========================================================================== */
/*  AdminUsersPage                                                            */
/* ========================================================================== */

interface User {
  id: string
  username: string
  email: string
  role: string
  status: string
  free_until: string | null
  discount_rate: number
  invited_by: string | null
  created_at: string
  updated_at: string
}

interface UserDetail extends User {
  inviter_username: string | null
  invite_bound_at: string | null
}

interface UserClient {
  id: string; name: string; token: string; status: string
  created_at: string; approved_at: string | null; suspended_at: string | null; suspend_reason: string | null
}

interface UserSubscription {
  id: string; plan_name: string | null; plan_type: string | null; plan_price: number | null
  status: string; balance: number; starts_at: string; expires_at: string | null; created_at: string
}

interface UserInvite {
  id: string; username: string; email: string; bound_at: string | null; status: string; code: string
}

interface UserReward {
  id: string; type: string; status: string; campaign_name: string | null
  coupon_id: string | null; token_amount: number | null; token_remaining: number | null
  free_until: string | null; discount_rate: number | null; discount_periods_left: number | null
  expires_at: string | null; created_at: string
}

const USER_ROLES = ['user', 'admin'] as const
const USER_STATUSES = ['active', 'suspended', 'banned'] as const

const ROLE_BADGE: Record<string, string> = {
  admin: 'bg-[#af52de]/10 text-[#af52de]',
  user:  'bg-[#007aff]/10 text-[#007aff]',
}

const USER_STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  active:    { label: '正常', cls: 'bg-[#34c759]/10 text-[#34c759]' },
  suspended: { label: '停用', cls: 'bg-[#ff9500]/10 text-[#ff9500]' },
  banned:    { label: '封禁', cls: 'bg-[#ff3b30]/10 text-[#ff3b30]' },
}

/* ---------- UserDrawer ---------- */

function DrawerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-[#f0f0f0] pb-4 mb-4 last:border-0">
      <h3 className="text-[14px] font-semibold text-[#1d1d1f] mb-3">{title}</h3>
      {children}
    </div>
  )
}

function UserDrawer({ userId, onClose, onUpdated }: { userId: string; onClose: () => void; onUpdated: () => void }) {
  const [detail, setDetail] = useState<UserDetail | null>(null)
  const [clients, setClients] = useState<UserClient[]>([])
  const [subs, setSubs] = useState<UserSubscription[]>([])
  const [inviteData, setInviteData] = useState<{ inviter: UserInvite | null; invitees: UserInvite[] }>({ inviter: null, invitees: [] })
  const [rewards, setRewards] = useState<UserReward[]>([])
  const [loading, setLoading] = useState(true)

  // Editable fields
  const [editMode, setEditMode] = useState(false)
  const [editRole, setEditRole] = useState('')
  const [editStatus, setEditStatus] = useState('')
  const [editFreeUntil, setEditFreeUntil] = useState('')
  const [editDiscount, setEditDiscount] = useState('')
  const [saving, setSaving] = useState(false)

  // Subscription management
  const [showSubForm, setShowSubForm] = useState(false)
  const [subMode, setSubMode] = useState<'plan' | 'custom'>('custom')
  const [plans, setPlans] = useState<{ id: string; name: string; type: string; price: number; quota_amount: number | null }[]>([])
  const [subPlanId, setSubPlanId] = useState('')
  const [subBalance, setSubBalance] = useState('')
  const [subExpires, setSubExpires] = useState('')
  const [creatingSubscription, setCreatingSubscription] = useState(false)
  // Inline balance edit
  const [editingSubId, setEditingSubId] = useState<string | null>(null)
  const [editBalanceVal, setEditBalanceVal] = useState('')
  const [savingBalance, setSavingBalance] = useState(false)
  const [clientBusyId, setClientBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [d, c, s, inv, r] = await Promise.all([
        api<UserDetail>(`/admin/users/${userId}`),
        api<{ clients: UserClient[] }>(`/admin/users/${userId}/clients`),
        api<{ subscriptions: UserSubscription[] }>(`/admin/users/${userId}/subscriptions`),
        api<{ inviter: UserInvite | null; invitees: UserInvite[] }>(`/admin/users/${userId}/invites`),
        api<{ rewards: UserReward[] }>(`/admin/users/${userId}/rewards`),
      ])
      setDetail(d)
      setClients(c.clients ?? [])
      setSubs(s.subscriptions ?? [])
      setInviteData({ inviter: inv.inviter ?? null, invitees: inv.invitees ?? [] })
      setRewards(r.rewards ?? [])
    } catch {}
    setLoading(false)
  }, [userId])

  useEffect(() => { load() }, [load])

  const startEdit = () => {
    if (!detail) return
    setEditRole(detail.role)
    setEditStatus(detail.status)
    setEditFreeUntil(detail.free_until ?? '')
    setEditDiscount(String(detail.discount_rate ?? 1))
    setEditMode(true)
  }

  const saveEdit = async () => {
    if (!detail) return
    setSaving(true)
    try {
      const body: Record<string, unknown> = {}
      if (editRole !== detail.role) body.role = editRole
      if (editStatus !== detail.status) body.status = editStatus
      if (editFreeUntil !== (detail.free_until ?? '')) body.free_until = editFreeUntil || null
      if (editDiscount !== String(detail.discount_rate ?? 1)) body.discount_rate = Number(editDiscount)
      if (Object.keys(body).length > 0) {
        await api(`/admin/users/${userId}`, { method: 'PATCH', body: JSON.stringify(body) })
      }
      setEditMode(false)
      await load()
      onUpdated()
    } catch (e) {
      await dialog.alert(e instanceof Error ? e.message : 'Failed')
    }
    setSaving(false)
  }

  const openSubForm = async () => {
    try {
      const data = await api<{ id: string; name: string; type: string; price: number; quota_amount: number | null }[]>('/admin/plans')
      setPlans(data ?? [])
      setSubPlanId(data?.[0]?.id ?? '')
      setSubBalance('')
      setSubExpires('')
      setSubMode('custom')
      setShowSubForm(true)
    } catch (e) {
      await dialog.alert(e instanceof Error ? e.message : '加载套餐失败')
    }
  }

  const createSubscription = async () => {
    setCreatingSubscription(true)
    try {
      const body: Record<string, unknown> = {}
      if (subMode === 'plan') {
        if (!subPlanId) return
        body.plan_id = subPlanId
        if (subBalance) body.balance = Number(subBalance)
      } else {
        // Custom mode: use balance only, backend picks default quota plan
        if (!subBalance || Number(subBalance) <= 0) return
        body.balance = Number(subBalance)
      }
      if (subExpires) body.expires_at = subExpires
      await api(`/admin/users/${userId}/subscriptions`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setShowSubForm(false)
      await load()
    } catch (e) {
      await dialog.alert(e instanceof Error ? e.message : '创建失败')
    }
    setCreatingSubscription(false)
  }

  const saveSubBalance = async (subId: string) => {
    setSavingBalance(true)
    try {
      await api(`/admin/plans/subscriptions/${subId}`, {
        method: 'PATCH',
        body: JSON.stringify({ balance: Number(editBalanceVal) }),
      })
      setEditingSubId(null)
      await load()
    } catch (e) {
      await dialog.alert(e instanceof Error ? e.message : '保存失败')
    }
    setSavingBalance(false)
  }

  const runClientAction = async (
    clientId: string,
    path: string,
    method: 'POST' | 'DELETE',
    confirmText?: string,
  ) => {
    if (confirmText && !(await dialog.confirm(confirmText, { danger: true }))) return
    setClientBusyId(clientId)
    try {
      await api(path, { method })
      await load()
      onUpdated()
    } catch (e) {
      await dialog.alert(e instanceof Error ? e.message : '操作失败')
    }
    setClientBusyId(null)
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 bottom-0 w-[640px] max-w-full bg-white z-50 shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#e5e5ea]">
          <h2 className="text-[18px] font-semibold text-[#1d1d1f]">用户详情</h2>
          <button onClick={onClose} className="text-[#86868b] hover:text-[#1d1d1f] text-[20px]">x</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="text-[13px] text-[#86868b]">加载中...</div>
          ) : detail ? (
            <>
              {/* 1. Basic info */}
              <DrawerSection title="基本信息">
                {!editMode ? (
                  <div className="space-y-2 text-[13px]">
                    <div className="flex justify-between"><span className="text-[#86868b]">用户名</span><span className="text-[#1d1d1f] font-medium">{detail.username}</span></div>
                    <div className="flex justify-between"><span className="text-[#86868b]">邮箱</span><span className="text-[#1d1d1f]">{detail.email}</span></div>
                    <div className="flex justify-between"><span className="text-[#86868b]">角色</span><span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${ROLE_BADGE[detail.role] ?? ''}`}>{detail.role}</span></div>
                    <div className="flex justify-between"><span className="text-[#86868b]">状态</span><span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${USER_STATUS_BADGE[detail.status]?.cls ?? ''}`}>{USER_STATUS_BADGE[detail.status]?.label ?? detail.status}</span></div>
                    <div className="flex justify-between"><span className="text-[#86868b]">免费到期</span><span className="text-[#1d1d1f]">{detail.free_until ?? '-'}</span></div>
                    <div className="flex justify-between"><span className="text-[#86868b]">折扣率</span><span className="text-[#1d1d1f]">{detail.discount_rate ?? 1}</span></div>
                    <div className="flex justify-between"><span className="text-[#86868b]">注册时间</span><span className="text-[#1d1d1f]">{fmtDate(detail.created_at)}</span></div>
                    <button onClick={startEdit} className={BTN_SECONDARY + ' mt-2 w-full text-center'}>编辑</button>
                  </div>
                ) : (
                  <div className="space-y-3 text-[13px]">
                    <div><label className="text-[#86868b] block mb-1">角色</label><select value={editRole} onChange={e => setEditRole(e.target.value)} className={INPUT_CLS}>{USER_ROLES.map(r => <option key={r}>{r}</option>)}</select></div>
                    <div><label className="text-[#86868b] block mb-1">状态</label><select value={editStatus} onChange={e => setEditStatus(e.target.value)} className={INPUT_CLS}>{USER_STATUSES.map(s => <option key={s}>{s}</option>)}</select></div>
                    <div><label className="text-[#86868b] block mb-1">免费到期 (YYYY-MM-DD)</label><input type="date" value={editFreeUntil} onChange={e => setEditFreeUntil(e.target.value)} className={INPUT_CLS} /></div>
                    <div><label className="text-[#86868b] block mb-1">折扣率 (0.8=8折, 1=无折扣)</label><input type="number" step="0.01" value={editDiscount} onChange={e => setEditDiscount(e.target.value)} className={INPUT_CLS} /></div>
                    <div className="flex gap-2">
                      <button onClick={() => setEditMode(false)} className="flex-1 py-2 text-[13px] bg-[#f5f5f7] rounded-lg hover:bg-[#e8e8ed]">取消</button>
                      <button onClick={saveEdit} disabled={saving} className="flex-1 py-2 text-[13px] text-white bg-[#007aff] rounded-lg hover:bg-[#0066d6] disabled:opacity-40">{saving ? '保存中...' : '保存'}</button>
                    </div>
                  </div>
                )}
              </DrawerSection>

              {/* 2. Subscriptions */}
              <DrawerSection title="订阅 & 余额">
                <div className="space-y-2">
                  {subs.length === 0 ? (
                    <p className="text-[12px] text-[#86868b]">暂无订阅</p>
                  ) : subs.map(s => (
                    <div key={s.id} className="bg-[#f9f9fb] rounded-lg p-3 text-[12px]">
                      <div className="flex justify-between"><span className="font-medium text-[#1d1d1f]">{s.plan_name ?? '未知套餐'}</span><span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${s.status === 'active' ? 'bg-[#34c759]/10 text-[#34c759]' : 'bg-[#8e8e93]/10 text-[#8e8e93]'}`}>{s.status}</span></div>
                      {editingSubId === s.id ? (
                        <div className="mt-1.5 flex items-center gap-1.5">
                          <span className="text-[#86868b]">余额: $</span>
                          <input type="number" step="0.01" value={editBalanceVal} onChange={e => setEditBalanceVal(e.target.value)} className="w-24 px-1.5 py-0.5 border border-[#d2d2d7] rounded text-[12px] focus:outline-none focus:border-[#007aff]" autoFocus />
                          <button onClick={() => saveSubBalance(s.id)} disabled={savingBalance} className="px-2 py-0.5 text-[11px] text-white bg-[#007aff] rounded hover:bg-[#0066d6] disabled:opacity-40">{savingBalance ? '...' : '保存'}</button>
                          <button onClick={() => setEditingSubId(null)} className="px-2 py-0.5 text-[11px] text-[#86868b] hover:text-[#1d1d1f]">取消</button>
                        </div>
                      ) : (
                        <div className="mt-1 flex items-center justify-between">
                          <span className="text-[#86868b]">余额: ${Number(s.balance ?? 0).toFixed(2)} | 到期: {s.expires_at ? fmtDate(s.expires_at) : '-'}</span>
                          {s.status === 'active' && (
                            <button onClick={() => { setEditingSubId(s.id); setEditBalanceVal(String(Number(s.balance ?? 0))) }} className="text-[11px] text-[#007aff] hover:underline">编辑</button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                  {!showSubForm ? (
                    <button onClick={openSubForm} className={BTN_SECONDARY + ' w-full text-center'}>新建订阅</button>
                  ) : (
                    <div className="bg-[#f9f9fb] rounded-lg p-3 space-y-2">
                      <div className="flex gap-1 mb-1">
                        <button onClick={() => setSubMode('custom')} className={`flex-1 py-1 text-[12px] rounded-md font-medium transition-colors ${subMode === 'custom' ? 'bg-[#007aff] text-white' : 'bg-white text-[#6e6e73] border border-[#d2d2d7]'}`}>自定义额度</button>
                        <button onClick={() => setSubMode('plan')} className={`flex-1 py-1 text-[12px] rounded-md font-medium transition-colors ${subMode === 'plan' ? 'bg-[#007aff] text-white' : 'bg-white text-[#6e6e73] border border-[#d2d2d7]'}`}>选择套餐</button>
                      </div>
                      {subMode === 'plan' && (
                        <div>
                          <label className="text-[12px] text-[#86868b] block mb-1">套餐</label>
                          <select value={subPlanId} onChange={e => setSubPlanId(e.target.value)} className={INPUT_CLS + ' text-[12px]'}>
                            {plans.map(p => (
                              <option key={p.id} value={p.id}>{p.name} ({p.type}) - ¥{p.price}</option>
                            ))}
                          </select>
                        </div>
                      )}
                      <div>
                        <label className="text-[12px] text-[#86868b] block mb-1">{subMode === 'custom' ? '余额 (USD)' : '初始余额 (可选，覆盖套餐默认)'}</label>
                        <input type="number" step="0.01" value={subBalance} onChange={e => setSubBalance(e.target.value)} placeholder={subMode === 'custom' ? '例如: 10' : '留空用套餐默认'} className={INPUT_CLS + ' text-[12px]'} />
                      </div>
                      <div>
                        <label className="text-[12px] text-[#86868b] block mb-1">到期日 (可选)</label>
                        <input type="date" value={subExpires} onChange={e => setSubExpires(e.target.value)} className={INPUT_CLS + ' text-[12px]'} />
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => setShowSubForm(false)} className="flex-1 py-1.5 text-[12px] bg-[#f5f5f7] rounded-lg hover:bg-[#e8e8ed]">取消</button>
                        <button onClick={createSubscription} disabled={creatingSubscription || (subMode === 'plan' ? !subPlanId : !subBalance || Number(subBalance) <= 0)} className="flex-1 py-1.5 text-[12px] text-white bg-[#007aff] rounded-lg hover:bg-[#0066d6] disabled:opacity-40">{creatingSubscription ? '创建中...' : '确认创建'}</button>
                      </div>
                    </div>
                  )}
                </div>
              </DrawerSection>

              {/* 3. Clients */}
              <DrawerSection title="客户端 (API Keys)">
                {clients.length === 0 ? (
                  <p className="text-[12px] text-[#86868b]">暂无客户端</p>
                ) : (
                  <div className="space-y-2">
                    {clients.map(c => {
                      const busy = clientBusyId === c.id
                      return (
                        <div key={c.id} className="bg-[#f9f9fb] rounded-lg p-3 text-[12px] flex items-start gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-[#1d1d1f] truncate">{c.name}</span>
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${c.status === 'active' ? 'bg-[#34c759]/10 text-[#34c759]' : c.status === 'pending' ? 'bg-[#ff9500]/10 text-[#ff9500]' : c.status === 'suspended' ? 'bg-[#ff9500]/10 text-[#ff9500]' : 'bg-[#ff3b30]/10 text-[#ff3b30]'}`}>{c.status}</span>
                            </div>
                            <div className="mt-1 text-[#86868b] font-mono truncate">{c.token.slice(0, 16)}...</div>
                            <div className="text-[#86868b]">创建: {fmtDate(c.created_at)}</div>
                          </div>
                          <div className="flex flex-col gap-1.5 shrink-0">
                            {c.status === 'pending' && (
                              <>
                                <button
                                  disabled={busy}
                                  onClick={() => runClientAction(c.id, `/admin/clients/${c.id}/approve`, 'POST')}
                                  className="px-3 py-1.5 text-[12px] font-medium text-[#34c759] bg-[#34c759]/5 rounded-lg hover:bg-[#34c759]/10 disabled:opacity-40 transition-colors"
                                >通过</button>
                                <button
                                  disabled={busy}
                                  onClick={() => runClientAction(c.id, `/admin/clients/${c.id}/reject`, 'POST', '确定拒绝此客户端？')}
                                  className={BTN_DANGER + ' disabled:opacity-40'}
                                >拒绝</button>
                              </>
                            )}
                            {c.status === 'active' && (
                              <>
                                <button
                                  disabled={busy}
                                  onClick={() => runClientAction(c.id, `/clients/${c.id}/suspend`, 'POST')}
                                  className="px-3 py-1.5 text-[12px] font-medium text-[#ff9500] bg-[#ff9500]/5 rounded-lg hover:bg-[#ff9500]/10 disabled:opacity-40 transition-colors"
                                >停用</button>
                                <button
                                  disabled={busy}
                                  onClick={() => runClientAction(c.id, `/clients/${c.id}`, 'DELETE', '确定删除此客户端？此操作不可恢复。')}
                                  className={BTN_DANGER + ' disabled:opacity-40'}
                                >删除</button>
                              </>
                            )}
                            {c.status === 'suspended' && (
                              <>
                                <button
                                  disabled={busy}
                                  onClick={() => runClientAction(c.id, `/clients/${c.id}/activate`, 'POST')}
                                  className={BTN_SECONDARY + ' disabled:opacity-40'}
                                >启用</button>
                                <button
                                  disabled={busy}
                                  onClick={() => runClientAction(c.id, `/clients/${c.id}`, 'DELETE', '确定删除此客户端？此操作不可恢复。')}
                                  className={BTN_DANGER + ' disabled:opacity-40'}
                                >删除</button>
                              </>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </DrawerSection>

              {/* 4. Invite relationships */}
              <DrawerSection title="邀请关系">
                <div className="text-[12px] space-y-2">
                  <div className="flex justify-between text-[#86868b]">
                    <span>邀请人</span>
                    <span className="text-[#1d1d1f]">
                      {inviteData.inviter ? `${inviteData.inviter.username} (${inviteData.inviter.email})` : '-'}
                    </span>
                  </div>
                  {inviteData.invitees.length > 0 && (
                    <div>
                      <span className="text-[#86868b]">被邀请人 ({inviteData.invitees.length})</span>
                      <div className="mt-1 space-y-1">
                        {inviteData.invitees.map(inv => (
                          <div key={inv.id} className="flex justify-between bg-[#f9f9fb] rounded px-2 py-1">
                            <span className="text-[#1d1d1f]">{inv.username}</span>
                            <span className="text-[#86868b]">{inv.code} | {inv.bound_at ? fmtDate(inv.bound_at) : '-'}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {inviteData.invitees.length === 0 && (
                    <div className="flex justify-between text-[#86868b]"><span>被邀请人</span><span className="text-[#1d1d1f]">0</span></div>
                  )}
                </div>
              </DrawerSection>

              {/* 5. Rewards */}
              <DrawerSection title="奖励记录">
                {rewards.length === 0 ? (
                  <p className="text-[12px] text-[#86868b]">暂无奖励</p>
                ) : (
                  <div className="space-y-2">
                    {rewards.map(r => (
                      <div key={r.id} className="bg-[#f9f9fb] rounded-lg p-3 text-[12px]">
                        <div className="flex justify-between">
                          <span className="font-medium text-[#1d1d1f]">
                            {r.type === 'coupon' && '优惠券'}
                            {r.type === 'tokens' && `Token ${(r.token_amount ?? 0).toLocaleString()}`}
                            {r.type === 'free_days' && `免费到 ${r.free_until ?? '-'}`}
                            {r.type === 'discount' && `${((r.discount_rate ?? 1) * 10).toFixed(0)}折 x${r.discount_periods_left ?? 0}期`}
                          </span>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${r.status === 'active' ? 'bg-[#34c759]/10 text-[#34c759]' : 'bg-[#8e8e93]/10 text-[#8e8e93]'}`}>{r.status}</span>
                        </div>
                        <div className="text-[#86868b]">{r.campaign_name ?? '-'} | {fmtDate(r.created_at)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </DrawerSection>
            </>
          ) : (
            <div className="text-[13px] text-[#ff3b30]">加载失败</div>
          )}
        </div>
      </div>
    </>
  )
}

export function AdminUsersPage() {
  const [users, setUsers] = useState<User[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [drawerUserId, setDrawerUserId] = useState<string | null>(null)
  const [rowBusyId, setRowBusyId] = useState<string | null>(null)

  const fetchUsers = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page), limit: '50' })
      if (search) params.set('search', search)
      const data = await api<{ users: User[]; total: number }>(`/admin/users?${params}`)
      setUsers(data.users ?? [])
      setTotal(data.total ?? 0)
    } catch {
      setUsers([])
    }
  }, [page, search])

  const patchUser = async (id: string, body: Record<string, unknown>, confirmText?: string) => {
    if (confirmText && !(await dialog.confirm(confirmText, { danger: true }))) return
    setRowBusyId(id)
    try {
      await api(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
      await fetchUsers()
    } catch (e) {
      await dialog.alert(e instanceof Error ? e.message : '操作失败')
    }
    setRowBusyId(null)
  }

  useEffect(() => {
    setLoading(true)
    fetchUsers().finally(() => setLoading(false))
  }, [fetchUsers])

  if (loading && users.length === 0) return <LoadingView />

  const totalPages = Math.ceil(total / 50)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-[#1d1d1f]">用户管理</h1>
          <p className="text-[13px] text-[#86868b] mt-0.5">共 {total} 个用户</p>
        </div>
        <input
          type="text"
          placeholder="搜索用户名或邮箱..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1) }}
          className={INPUT_CLS + ' w-[240px]'}
        />
      </div>

      <div className={CARD_CLS}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px] min-w-[960px]">
            <thead>
              <tr className="border-b border-[#e5e5ea]">
                <th className="pb-2 font-medium text-[#86868b]">用户名</th>
                <th className="pb-2 font-medium text-[#86868b]">邮箱</th>
                <th className="pb-2 font-medium text-[#86868b] text-center">角色</th>
                <th className="pb-2 font-medium text-[#86868b] text-center">状态</th>
                <th className="pb-2 font-medium text-[#86868b]">折扣</th>
                <th className="pb-2 font-medium text-[#86868b]">免费到</th>
                <th className="pb-2 font-medium text-[#86868b]">注册时间</th>
                <th className="pb-2 font-medium text-[#86868b] text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => {
                const sBadge = USER_STATUS_BADGE[u.status] ?? USER_STATUS_BADGE.active
                const busy = rowBusyId === u.id
                return (
                  <tr
                    key={u.id}
                    onClick={() => setDrawerUserId(u.id)}
                    className="border-b border-[#f5f5f7] last:border-0 cursor-pointer hover:bg-[#f9f9fb] transition-colors"
                  >
                    <td className="py-2.5 text-[#1d1d1f] font-medium">{u.username}</td>
                    <td className="py-2.5 text-[#6e6e73]">{u.email}</td>
                    <td className="py-2.5 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${ROLE_BADGE[u.role] ?? ROLE_BADGE.user}`}>{u.role}</span>
                    </td>
                    <td className="py-2.5 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${sBadge.cls}`}>{sBadge.label}</span>
                    </td>
                    <td className="py-2.5 text-[#6e6e73]">{u.discount_rate < 1 ? `${(u.discount_rate * 10).toFixed(0)}折` : '-'}</td>
                    <td className="py-2.5 text-[#6e6e73]">{u.free_until ?? '-'}</td>
                    <td className="py-2.5 text-[#6e6e73]">{fmtDate(u.created_at)}</td>
                    <td className="py-2.5">
                      <div className="flex items-center justify-end gap-1.5" onClick={e => e.stopPropagation()}>
                        <button
                          disabled={busy}
                          onClick={e => { e.stopPropagation(); setDrawerUserId(u.id) }}
                          className={BTN_SECONDARY + ' disabled:opacity-40'}
                        >编辑</button>
                        {u.status === 'active' ? (
                          <button
                            disabled={busy}
                            onClick={e => { e.stopPropagation(); patchUser(u.id, { status: 'banned' }, `确定封禁用户 ${u.username}？`) }}
                            className={BTN_DANGER + ' disabled:opacity-40'}
                          >封禁</button>
                        ) : (
                          <button
                            disabled={busy}
                            onClick={e => { e.stopPropagation(); patchUser(u.id, { status: 'active' }) }}
                            className={BTN_SECONDARY + ' disabled:opacity-40'}
                          >解封</button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
              {users.length === 0 && (
                <tr><td colSpan={8} className="py-8 text-center text-[#86868b]">暂无用户</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 mt-4">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} className={BTN_SECONDARY + ' disabled:opacity-40'}>上一页</button>
            <span className="text-[13px] text-[#6e6e73]">{page} / {totalPages}</span>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className={BTN_SECONDARY + ' disabled:opacity-40'}>下一页</button>
          </div>
        )}
      </div>

      {drawerUserId && (
        <UserDrawer userId={drawerUserId} onClose={() => setDrawerUserId(null)} onUpdated={fetchUsers} />
      )}
    </div>
  )
}

/* ========================================================================== */
/*  AdminClientsPage (placeholder)                                            */
/* ========================================================================== */

interface PendingClient {
  id: string
  name: string
  token: string
  status: string
  created_at: string
  user?: string
}

export function AdminClientsPage() {
  const [clients, setClients] = useState<PendingClient[]>([])
  const [loading, setLoading] = useState(true)

  const fetchPending = useCallback(async () => {
    try {
      const data = await api<{ clients: PendingClient[] }>('/admin/clients/pending')
      setClients(data.clients ?? [])
    } catch {
      setClients([])
    }
  }, [])

  useEffect(() => {
    fetchPending().finally(() => setLoading(false))
  }, [fetchPending])

  const handleApprove = async (id: string) => {
    try {
      await api(`/admin/clients/${id}/approve`, { method: 'POST' })
      await fetchPending()
    } catch (e: unknown) {
      await dialog.alert(e instanceof Error ? e.message : '操作失败')
    }
  }

  const handleReject = async (id: string) => {
    if (!(await dialog.confirm('确定拒绝此客户端申请？', { danger: true }))) return
    try {
      await api(`/admin/clients/${id}/reject`, { method: 'POST' })
      await fetchPending()
    } catch (e: unknown) {
      await dialog.alert(e instanceof Error ? e.message : '操作失败')
    }
  }

  if (loading) return <LoadingView />

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-[#1d1d1f]">客户端审核</h1>
        <p className="text-[13px] text-[#86868b] mt-0.5">待审核的客户端申请</p>
      </div>

      {clients.length === 0 ? (
        <EmptyView text="暂无待审核的客户端" />
      ) : (
        <div className="space-y-3">
          {clients.map(client => (
            <div key={client.id} className={`${CARD_CLS} flex items-center gap-4`}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-semibold text-[#1d1d1f]">{client.name}</span>
                  <span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#ff9500]/10 text-[#ff9500]">
                    等待审核
                  </span>
                </div>
                {client.user && (
                  <div className="mt-1 text-[12px] text-[#86868b]">所属用户: {client.user}</div>
                )}
                <div className="mt-0.5 text-[11px] text-[#aeaeb2]">创建于 {fmtDate(client.created_at)}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => handleApprove(client.id)} className="px-3 py-1.5 text-[12px] font-medium text-[#34c759] bg-[#34c759]/5 rounded-lg hover:bg-[#34c759]/10 transition-colors">
                  通过
                </button>
                <button onClick={() => handleReject(client.id)} className={BTN_DANGER}>
                  拒绝
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ========================================================================== */
/*  AdminQuotasPage                                                           */
/* ========================================================================== */

interface QuotaRule {
  id: string
  target_type: string
  target_id: string
  metric: string
  window: string
  max_value: number
  action: string
  enabled: boolean
  created_at: string
  updated_at: string
}

interface RateLimit {
  id: string
  target_type: string
  target_id: string
  max_rpm: number
  max_rph: number
  enabled: boolean
  created_at: string
  updated_at: string
}

export function AdminQuotasPage() {
  const [quotas, setQuotas] = useState<QuotaRule[]>([])
  const [rateLimits, setRateLimits] = useState<RateLimit[]>([])
  const [loading, setLoading] = useState(true)
  const [showQuotaForm, setShowQuotaForm] = useState(false)
  const [showRateForm, setShowRateForm] = useState(false)

  // Quota form state
  const [qTargetType, setQTargetType] = useState('user')
  const [qTargetId, setQTargetId] = useState('')
  const [qMetric, setQMetric] = useState('tokens')
  const [qWindow, setQWindow] = useState('1 day')
  const [qMaxValue, setQMaxValue] = useState('')
  const [qAction, setQAction] = useState('block')

  // Rate limit form state
  const [rTargetType, setRTargetType] = useState('user')
  const [rTargetId, setRTargetId] = useState('')
  const [rMaxRpm, setRMaxRpm] = useState('')
  const [rMaxRph, setRMaxRph] = useState('')

  const [submitting, setSubmitting] = useState(false)

  const fetchQuotas = useCallback(async () => {
    try {
      const data = await api<QuotaRule[]>('/admin/quotas')
      setQuotas(data ?? [])
    } catch {
      setQuotas([])
    }
  }, [])

  const fetchRateLimits = useCallback(async () => {
    try {
      const data = await api<RateLimit[]>('/admin/rate-limits')
      setRateLimits(data ?? [])
    } catch {
      setRateLimits([])
    }
  }, [])

  useEffect(() => {
    Promise.all([fetchQuotas(), fetchRateLimits()]).finally(() => setLoading(false))
  }, [fetchQuotas, fetchRateLimits])

  const handleCreateQuota = async () => {
    setSubmitting(true)
    try {
      await api('/admin/quotas', {
        method: 'POST',
        body: JSON.stringify({
          target_type: qTargetType,
          target_id: qTargetId,
          metric: qMetric,
          window: qWindow,
          max_value: Number(qMaxValue),
          action: qAction,
        }),
      })
      setShowQuotaForm(false)
      setQTargetId('')
      setQMaxValue('')
      await fetchQuotas()
    } catch (e: unknown) {
      await dialog.alert(e instanceof Error ? e.message : '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDeleteQuota = async (id: string) => {
    if (!(await dialog.confirm('确定删除此额度规则？', { danger: true }))) return
    try {
      await api(`/admin/quotas/${id}`, { method: 'DELETE' })
      await fetchQuotas()
    } catch (e: unknown) {
      await dialog.alert(e instanceof Error ? e.message : '删除失败')
    }
  }

  const handleCreateRateLimit = async () => {
    setSubmitting(true)
    try {
      await api('/admin/rate-limits', {
        method: 'POST',
        body: JSON.stringify({
          target_type: rTargetType,
          target_id: rTargetId,
          max_rpm: Number(rMaxRpm),
          max_rph: Number(rMaxRph),
        }),
      })
      setShowRateForm(false)
      setRTargetId('')
      setRMaxRpm('')
      setRMaxRph('')
      await fetchRateLimits()
    } catch (e: unknown) {
      await dialog.alert(e instanceof Error ? e.message : '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDeleteRateLimit = async (id: string) => {
    if (!(await dialog.confirm('确定删除此速率限制？', { danger: true }))) return
    try {
      await api(`/admin/rate-limits/${id}`, { method: 'DELETE' })
      await fetchRateLimits()
    } catch (e: unknown) {
      await dialog.alert(e instanceof Error ? e.message : '删除失败')
    }
  }

  if (loading) return <LoadingView />

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-[#1d1d1f]">额度与速率限制</h1>
        <p className="text-[13px] text-[#86868b] mt-0.5">管理用户额度规则和速率限制</p>
      </div>

      {/* Quota Rules */}
      <div className={CARD_CLS}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[15px] font-semibold text-[#1d1d1f]">额度规则</h2>
          <button onClick={() => setShowQuotaForm(true)} className={BTN_PRIMARY}>新建规则</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px] min-w-[640px]">
            <thead>
              <tr className="border-b border-[#e5e5ea]">
                <th className="pb-2 font-medium text-[#86868b]">类型</th>
                <th className="pb-2 font-medium text-[#86868b]">目标ID</th>
                <th className="pb-2 font-medium text-[#86868b]">指标</th>
                <th className="pb-2 font-medium text-[#86868b]">窗口</th>
                <th className="pb-2 font-medium text-[#86868b] text-right">上限</th>
                <th className="pb-2 font-medium text-[#86868b]">动作</th>
                <th className="pb-2 font-medium text-[#86868b] text-center">启用</th>
                <th className="pb-2 font-medium text-[#86868b] text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {quotas.map(q => (
                <tr key={q.id} className="border-b border-[#f5f5f7] last:border-0">
                  <td className="py-2.5 text-[#1d1d1f]">{q.target_type}</td>
                  <td className="py-2.5 text-[#6e6e73] font-mono text-[12px] max-w-[120px] truncate">{q.target_id}</td>
                  <td className="py-2.5 text-[#1d1d1f]">{q.metric}</td>
                  <td className="py-2.5 text-[#6e6e73]">{q.window}</td>
                  <td className="py-2.5 text-right tabular-nums text-[#1d1d1f]">{Number(q.max_value).toLocaleString()}</td>
                  <td className="py-2.5 text-[#6e6e73]">{q.action}</td>
                  <td className="py-2.5 text-center">
                    <span className={`inline-block w-2 h-2 rounded-full ${q.enabled ? 'bg-[#34c759]' : 'bg-[#8e8e93]'}`} />
                  </td>
                  <td className="py-2.5 text-right">
                    <button onClick={() => handleDeleteQuota(q.id)} className={BTN_DANGER}>删除</button>
                  </td>
                </tr>
              ))}
              {quotas.length === 0 && (
                <tr><td colSpan={8} className="py-8 text-center text-[#86868b]">暂无额度规则</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Rate Limits */}
      <div className={CARD_CLS}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[15px] font-semibold text-[#1d1d1f]">速率限制</h2>
          <button onClick={() => setShowRateForm(true)} className={BTN_PRIMARY}>新建限制</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-[#e5e5ea]">
                <th className="pb-2 font-medium text-[#86868b]">类型</th>
                <th className="pb-2 font-medium text-[#86868b]">目标ID</th>
                <th className="pb-2 font-medium text-[#86868b] text-right">RPM</th>
                <th className="pb-2 font-medium text-[#86868b] text-right">RPH</th>
                <th className="pb-2 font-medium text-[#86868b] text-center">启用</th>
                <th className="pb-2 font-medium text-[#86868b] text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {rateLimits.map(r => (
                <tr key={r.id} className="border-b border-[#f5f5f7] last:border-0">
                  <td className="py-2.5 text-[#1d1d1f]">{r.target_type}</td>
                  <td className="py-2.5 text-[#6e6e73] font-mono text-[12px] max-w-[120px] truncate">{r.target_id}</td>
                  <td className="py-2.5 text-right tabular-nums text-[#1d1d1f]">{r.max_rpm}</td>
                  <td className="py-2.5 text-right tabular-nums text-[#1d1d1f]">{r.max_rph}</td>
                  <td className="py-2.5 text-center">
                    <span className={`inline-block w-2 h-2 rounded-full ${r.enabled ? 'bg-[#34c759]' : 'bg-[#8e8e93]'}`} />
                  </td>
                  <td className="py-2.5 text-right">
                    <button onClick={() => handleDeleteRateLimit(r.id)} className={BTN_DANGER}>删除</button>
                  </td>
                </tr>
              ))}
              {rateLimits.length === 0 && (
                <tr><td colSpan={6} className="py-8 text-center text-[#86868b]">暂无速率限制</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Quota Modal */}
      <Modal open={showQuotaForm} onClose={() => setShowQuotaForm(false)}>
        <div className="space-y-4">
          <h2 className="text-[17px] font-semibold text-[#1d1d1f]">新建额度规则</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] text-[#6e6e73] mb-1.5">目标类型</label>
              <select value={qTargetType} onChange={e => setQTargetType(e.target.value)} className={INPUT_CLS}>
                <option value="user">user</option>
                <option value="client">client</option>
                <option value="global">global</option>
              </select>
            </div>
            <div>
              <label className="block text-[13px] text-[#6e6e73] mb-1.5">目标 ID</label>
              <input value={qTargetId} onChange={e => setQTargetId(e.target.value)} placeholder="用户或客户端 ID" className={INPUT_CLS} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] text-[#6e6e73] mb-1.5">指标</label>
              <select value={qMetric} onChange={e => setQMetric(e.target.value)} className={INPUT_CLS}>
                <option value="tokens">tokens</option>
                <option value="requests">requests</option>
                <option value="cost">cost</option>
              </select>
            </div>
            <div>
              <label className="block text-[13px] text-[#6e6e73] mb-1.5">窗口</label>
              <select value={qWindow} onChange={e => setQWindow(e.target.value)} className={INPUT_CLS}>
                <option value="1 hour">1 小时</option>
                <option value="1 day">1 天</option>
                <option value="7 days">7 天</option>
                <option value="30 days">30 天</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] text-[#6e6e73] mb-1.5">上限值</label>
              <input type="number" value={qMaxValue} onChange={e => setQMaxValue(e.target.value)} placeholder="例如: 1000000" className={INPUT_CLS} />
            </div>
            <div>
              <label className="block text-[13px] text-[#6e6e73] mb-1.5">超限动作</label>
              <select value={qAction} onChange={e => setQAction(e.target.value)} className={INPUT_CLS}>
                <option value="block">block</option>
                <option value="warn">warn</option>
                <option value="throttle">throttle</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowQuotaForm(false)} className="flex-1 py-2.5 text-[14px] font-medium text-[#6e6e73] bg-[#f5f5f7] rounded-lg hover:bg-[#e8e8ed] transition-colors">取消</button>
            <button onClick={handleCreateQuota} disabled={submitting || !qTargetId || !qMaxValue} className={BTN_PRIMARY + ' flex-1 py-2.5'}>
              {submitting ? '创建中...' : '创建'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Create Rate Limit Modal */}
      <Modal open={showRateForm} onClose={() => setShowRateForm(false)}>
        <div className="space-y-4">
          <h2 className="text-[17px] font-semibold text-[#1d1d1f]">新建速率限制</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] text-[#6e6e73] mb-1.5">目标类型</label>
              <select value={rTargetType} onChange={e => setRTargetType(e.target.value)} className={INPUT_CLS}>
                <option value="user">user</option>
                <option value="client">client</option>
                <option value="global">global</option>
              </select>
            </div>
            <div>
              <label className="block text-[13px] text-[#6e6e73] mb-1.5">目标 ID</label>
              <input value={rTargetId} onChange={e => setRTargetId(e.target.value)} placeholder="用户或客户端 ID" className={INPUT_CLS} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] text-[#6e6e73] mb-1.5">RPM (每分钟请求数)</label>
              <input type="number" value={rMaxRpm} onChange={e => setRMaxRpm(e.target.value)} placeholder="60" className={INPUT_CLS} />
            </div>
            <div>
              <label className="block text-[13px] text-[#6e6e73] mb-1.5">RPH (每小时请求数)</label>
              <input type="number" value={rMaxRph} onChange={e => setRMaxRph(e.target.value)} placeholder="1000" className={INPUT_CLS} />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowRateForm(false)} className="flex-1 py-2.5 text-[14px] font-medium text-[#6e6e73] bg-[#f5f5f7] rounded-lg hover:bg-[#e8e8ed] transition-colors">取消</button>
            <button onClick={handleCreateRateLimit} disabled={submitting || !rTargetId || !rMaxRpm || !rMaxRph} className={BTN_PRIMARY + ' flex-1 py-2.5'}>
              {submitting ? '创建中...' : '创建'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

/* ========================================================================== */
/*  AdminCostsPage                                                            */
/* ========================================================================== */

interface DailyCost {
  id: string
  date: string
  amount: number
  note: string | null
  created_by: string | null
  created_at: string
}

export function AdminCostsPage() {
  const [costs, setCosts] = useState<DailyCost[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [formDate, setFormDate] = useState('')
  const [formAmount, setFormAmount] = useState('')
  const [formNote, setFormNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const fetchCosts = useCallback(async () => {
    try {
      const data = await api<{ daily_costs: DailyCost[] }>('/admin/invoices/daily-costs')
      setCosts(data.daily_costs ?? [])
    } catch {
      setCosts([])
    }
  }, [])

  useEffect(() => {
    fetchCosts().finally(() => setLoading(false))
  }, [fetchCosts])

  const openCreate = () => {
    setEditId(null)
    setFormDate(new Date().toISOString().slice(0, 10))
    setFormAmount('')
    setFormNote('')
    setShowForm(true)
  }

  const openEdit = (c: DailyCost) => {
    setEditId(c.id)
    setFormDate(c.date.slice(0, 10))
    setFormAmount(String(c.amount))
    setFormNote(c.note ?? '')
    setShowForm(true)
  }

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      if (editId) {
        await api(`/admin/invoices/daily-costs/${editId}`, {
          method: 'PATCH',
          body: JSON.stringify({ amount: Number(formAmount), note: formNote || null }),
        })
      } else {
        await api('/admin/invoices/daily-costs', {
          method: 'POST',
          body: JSON.stringify({ date: formDate, amount: Number(formAmount), note: formNote || null }),
        })
      }
      setShowForm(false)
      await fetchCosts()
    } catch (e: unknown) {
      await dialog.alert(e instanceof Error ? e.message : '操作失败')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <LoadingView />

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-[#1d1d1f]">每日成本</h1>
          <p className="text-[13px] text-[#86868b] mt-0.5">记录每日 API 成本开支</p>
        </div>
        <button onClick={openCreate} className={BTN_PRIMARY}>新增记录</button>
      </div>

      <div className={CARD_CLS}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px] min-w-[400px]">
            <thead>
              <tr className="border-b border-[#e5e5ea]">
                <th className="pb-2 font-medium text-[#86868b]">日期</th>
                <th className="pb-2 font-medium text-[#86868b] text-right">金额</th>
                <th className="pb-2 font-medium text-[#86868b]">备注</th>
                <th className="pb-2 font-medium text-[#86868b] text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {costs.map(c => (
                <tr key={c.id} className="border-b border-[#f5f5f7] last:border-0">
                  <td className="py-2.5 text-[#1d1d1f]">{fmtDate(c.date)}</td>
                  <td className="py-2.5 text-right tabular-nums text-[#1d1d1f] font-medium">${Number(c.amount).toFixed(2)}</td>
                  <td className="py-2.5 text-[#6e6e73] max-w-[200px] truncate">{c.note || '-'}</td>
                  <td className="py-2.5 text-right">
                    <button onClick={() => openEdit(c)} className={BTN_SECONDARY}>编辑</button>
                  </td>
                </tr>
              ))}
              {costs.length === 0 && (
                <tr><td colSpan={4} className="py-8 text-center text-[#86868b]">暂无成本记录</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={showForm} onClose={() => setShowForm(false)}>
        <div className="space-y-4">
          <h2 className="text-[17px] font-semibold text-[#1d1d1f]">{editId ? '编辑成本记录' : '新增成本记录'}</h2>
          <div>
            <label className="block text-[13px] text-[#6e6e73] mb-1.5">日期</label>
            <input type="date" value={formDate} onChange={e => setFormDate(e.target.value)} disabled={!!editId} className={INPUT_CLS + (editId ? ' opacity-60' : '')} />
          </div>
          <div>
            <label className="block text-[13px] text-[#6e6e73] mb-1.5">金额 (USD)</label>
            <input type="number" step="0.01" value={formAmount} onChange={e => setFormAmount(e.target.value)} placeholder="0.00" className={INPUT_CLS} />
          </div>
          <div>
            <label className="block text-[13px] text-[#6e6e73] mb-1.5">备注</label>
            <input value={formNote} onChange={e => setFormNote(e.target.value)} placeholder="可选备注" className={INPUT_CLS} />
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowForm(false)} className="flex-1 py-2.5 text-[14px] font-medium text-[#6e6e73] bg-[#f5f5f7] rounded-lg hover:bg-[#e8e8ed] transition-colors">取消</button>
            <button onClick={handleSubmit} disabled={submitting || !formDate || !formAmount} className={BTN_PRIMARY + ' flex-1 py-2.5'}>
              {submitting ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

/* ========================================================================== */
/*  AdminPricingPage                                                          */
/* ========================================================================== */

interface ModelPricing {
  id: string
  model_pattern: string
  input_mtok: number
  output_mtok: number
  cache_read_mtok: number
  cache_write_mtok: number
  effective_from: string
  created_at: string
}

export function AdminPricingPage() {
  const [pricing, setPricing] = useState<ModelPricing[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)

  const [fModel, setFModel] = useState('')
  const [fInput, setFInput] = useState('')
  const [fOutput, setFOutput] = useState('')
  const [fCacheRead, setFCacheRead] = useState('')
  const [fCacheWrite, setFCacheWrite] = useState('')
  const [fEffective, setFEffective] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const fetchPricing = useCallback(async () => {
    try {
      const data = await api<{ model_pricing: ModelPricing[] }>('/admin/invoices/model-pricing')
      setPricing(data.model_pricing ?? [])
    } catch {
      setPricing([])
    }
  }, [])

  useEffect(() => {
    fetchPricing().finally(() => setLoading(false))
  }, [fetchPricing])

  const openCreate = () => {
    setEditId(null)
    setFModel('')
    setFInput('')
    setFOutput('')
    setFCacheRead('0')
    setFCacheWrite('0')
    setFEffective(new Date().toISOString().slice(0, 10))
    setShowForm(true)
  }

  const openEdit = (p: ModelPricing) => {
    setEditId(p.id)
    setFModel(p.model_pattern)
    setFInput(String(p.input_mtok))
    setFOutput(String(p.output_mtok))
    setFCacheRead(String(p.cache_read_mtok))
    setFCacheWrite(String(p.cache_write_mtok))
    setFEffective(p.effective_from.slice(0, 10))
    setShowForm(true)
  }

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      if (editId) {
        await api(`/admin/invoices/model-pricing/${editId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            input_mtok: Number(fInput),
            output_mtok: Number(fOutput),
            cache_read_mtok: Number(fCacheRead),
            cache_write_mtok: Number(fCacheWrite),
            effective_from: fEffective,
          }),
        })
      } else {
        await api('/admin/invoices/model-pricing', {
          method: 'POST',
          body: JSON.stringify({
            model_pattern: fModel,
            input_mtok: Number(fInput),
            output_mtok: Number(fOutput),
            cache_read_mtok: Number(fCacheRead),
            cache_write_mtok: Number(fCacheWrite),
            effective_from: fEffective,
          }),
        })
      }
      setShowForm(false)
      await fetchPricing()
    } catch (e: unknown) {
      await dialog.alert(e instanceof Error ? e.message : '操作失败')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <LoadingView />

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-[#1d1d1f]">模型定价</h1>
          <p className="text-[13px] text-[#86868b] mt-0.5">管理各模型的 Token 价格</p>
        </div>
        <button onClick={openCreate} className={BTN_PRIMARY}>新增定价</button>
      </div>

      <div className={CARD_CLS}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px] min-w-[640px]">
            <thead>
              <tr className="border-b border-[#e5e5ea]">
                <th className="pb-2 font-medium text-[#86868b]">模型</th>
                <th className="pb-2 font-medium text-[#86868b] text-right">Input $/M</th>
                <th className="pb-2 font-medium text-[#86868b] text-right">Output $/M</th>
                <th className="pb-2 font-medium text-[#86868b] text-right">Cache Read $/M</th>
                <th className="pb-2 font-medium text-[#86868b] text-right">Cache Write $/M</th>
                <th className="pb-2 font-medium text-[#86868b]">生效日期</th>
                <th className="pb-2 font-medium text-[#86868b] text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {pricing.map(p => (
                <tr key={p.id} className="border-b border-[#f5f5f7] last:border-0">
                  <td className="py-2.5 text-[#1d1d1f] font-mono text-[12px]">{p.model_pattern}</td>
                  <td className="py-2.5 text-right tabular-nums text-[#1d1d1f]">${Number(p.input_mtok).toFixed(2)}</td>
                  <td className="py-2.5 text-right tabular-nums text-[#1d1d1f]">${Number(p.output_mtok).toFixed(2)}</td>
                  <td className="py-2.5 text-right tabular-nums text-[#6e6e73]">${Number(p.cache_read_mtok).toFixed(2)}</td>
                  <td className="py-2.5 text-right tabular-nums text-[#6e6e73]">${Number(p.cache_write_mtok).toFixed(2)}</td>
                  <td className="py-2.5 text-[#6e6e73]">{fmtDate(p.effective_from)}</td>
                  <td className="py-2.5 text-right">
                    <button onClick={() => openEdit(p)} className={BTN_SECONDARY}>编辑</button>
                  </td>
                </tr>
              ))}
              {pricing.length === 0 && (
                <tr><td colSpan={7} className="py-8 text-center text-[#86868b]">暂无定价记录</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={showForm} onClose={() => setShowForm(false)}>
        <div className="space-y-4">
          <h2 className="text-[17px] font-semibold text-[#1d1d1f]">{editId ? '编辑模型定价' : '新增模型定价'}</h2>
          <div>
            <label className="block text-[13px] text-[#6e6e73] mb-1.5">模型 Pattern</label>
            <input value={fModel} onChange={e => setFModel(e.target.value)} disabled={!!editId} placeholder="例如: claude-sonnet-4-20250514" className={INPUT_CLS + (editId ? ' opacity-60' : '')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] text-[#6e6e73] mb-1.5">Input $/M tokens</label>
              <input type="number" step="0.01" value={fInput} onChange={e => setFInput(e.target.value)} className={INPUT_CLS} />
            </div>
            <div>
              <label className="block text-[13px] text-[#6e6e73] mb-1.5">Output $/M tokens</label>
              <input type="number" step="0.01" value={fOutput} onChange={e => setFOutput(e.target.value)} className={INPUT_CLS} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] text-[#6e6e73] mb-1.5">Cache Read $/M</label>
              <input type="number" step="0.01" value={fCacheRead} onChange={e => setFCacheRead(e.target.value)} className={INPUT_CLS} />
            </div>
            <div>
              <label className="block text-[13px] text-[#6e6e73] mb-1.5">Cache Write $/M</label>
              <input type="number" step="0.01" value={fCacheWrite} onChange={e => setFCacheWrite(e.target.value)} className={INPUT_CLS} />
            </div>
          </div>
          <div>
            <label className="block text-[13px] text-[#6e6e73] mb-1.5">生效日期</label>
            <input type="date" value={fEffective} onChange={e => setFEffective(e.target.value)} className={INPUT_CLS} />
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowForm(false)} className="flex-1 py-2.5 text-[14px] font-medium text-[#6e6e73] bg-[#f5f5f7] rounded-lg hover:bg-[#e8e8ed] transition-colors">取消</button>
            <button onClick={handleSubmit} disabled={submitting || (!editId && !fModel) || !fInput || !fOutput} className={BTN_PRIMARY + ' flex-1 py-2.5'}>
              {submitting ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

/* ========================================================================== */
/*  AdminCampaignsPage                                                        */
/* ========================================================================== */

/* ---------- RewardEditor ---------- */

type RewardType = 'coupon' | 'tokens' | 'free_days' | 'discount'

interface RewardItem {
  type: RewardType
  amount?: number
  min_order?: number
  valid_days?: number
  days?: number
  rate?: number
  periods?: number
}

const REWARD_TYPES: { value: RewardType; label: string }[] = [
  { value: 'coupon', label: '优惠券' },
  { value: 'tokens', label: 'Token' },
  { value: 'free_days', label: '免费天数' },
  { value: 'discount', label: '折扣' },
]

function defaultReward(type: RewardType): RewardItem {
  switch (type) {
    case 'coupon': return { type: 'coupon', amount: 10, min_order: 0, valid_days: 30 }
    case 'tokens': return { type: 'tokens', amount: 500000, valid_days: 90 }
    case 'free_days': return { type: 'free_days', days: 7 }
    case 'discount': return { type: 'discount', rate: 0.8, periods: 3 }
  }
}

function RewardEditor({ value, onChange, label }: { value: RewardItem[]; onChange: (v: RewardItem[]) => void; label: string }) {
  const update = (idx: number, patch: Partial<RewardItem>) => {
    const next = [...value]
    next[idx] = { ...next[idx], ...patch }
    onChange(next)
  }
  const remove = (idx: number) => onChange(value.filter((_, i) => i !== idx))
  const add = () => onChange([...value, defaultReward('coupon')])
  const changeType = (idx: number, t: RewardType) => {
    const next = [...value]
    next[idx] = defaultReward(t)
    onChange(next)
  }

  return (
    <div>
      <label className="block text-[13px] text-[#6e6e73] mb-1.5">{label}</label>
      <div className="space-y-2">
        {value.map((r, i) => (
          <div key={i} className="border border-[#e5e5ea] rounded-lg p-3 bg-[#fafafa]">
            <div className="flex items-center justify-between mb-2">
              <select
                value={r.type}
                onChange={e => changeType(i, e.target.value as RewardType)}
                className="px-2 py-1 rounded border border-[#d2d2d7] text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-[#007aff]/40"
              >
                {REWARD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <button onClick={() => remove(i)} className="text-[#ff3b30] text-[12px] hover:underline">删除</button>
            </div>
            <div className="grid grid-cols-3 gap-2 text-[12px]">
              {r.type === 'coupon' && (
                <>
                  <div>
                    <label className="text-[#86868b]">金额（元）</label>
                    <input type="number" value={r.amount ?? ''} onChange={e => update(i, { amount: Number(e.target.value) })} className={INPUT_CLS + ' text-[12px] mt-0.5'} />
                  </div>
                  <div>
                    <label className="text-[#86868b]">最低消费</label>
                    <input type="number" value={r.min_order ?? ''} onChange={e => update(i, { min_order: Number(e.target.value) })} className={INPUT_CLS + ' text-[12px] mt-0.5'} />
                  </div>
                  <div>
                    <label className="text-[#86868b]">有效天数</label>
                    <input type="number" value={r.valid_days ?? ''} onChange={e => update(i, { valid_days: Number(e.target.value) })} className={INPUT_CLS + ' text-[12px] mt-0.5'} />
                  </div>
                </>
              )}
              {r.type === 'tokens' && (
                <>
                  <div className="col-span-2">
                    <label className="text-[#86868b]">Token 数量</label>
                    <input type="number" value={r.amount ?? ''} onChange={e => update(i, { amount: Number(e.target.value) })} className={INPUT_CLS + ' text-[12px] mt-0.5'} />
                  </div>
                  <div>
                    <label className="text-[#86868b]">有效天数</label>
                    <input type="number" value={r.valid_days ?? ''} onChange={e => update(i, { valid_days: Number(e.target.value) })} className={INPUT_CLS + ' text-[12px] mt-0.5'} />
                  </div>
                </>
              )}
              {r.type === 'free_days' && (
                <div>
                  <label className="text-[#86868b]">免费天数</label>
                  <input type="number" value={r.days ?? ''} onChange={e => update(i, { days: Number(e.target.value) })} className={INPUT_CLS + ' text-[12px] mt-0.5'} />
                </div>
              )}
              {r.type === 'discount' && (
                <>
                  <div>
                    <label className="text-[#86868b]">折扣率 (0.8=8折)</label>
                    <input type="number" step="0.01" value={r.rate ?? ''} onChange={e => update(i, { rate: Number(e.target.value) })} className={INPUT_CLS + ' text-[12px] mt-0.5'} />
                  </div>
                  <div>
                    <label className="text-[#86868b]">适用期数</label>
                    <input type="number" value={r.periods ?? ''} onChange={e => update(i, { periods: Number(e.target.value) })} className={INPUT_CLS + ' text-[12px] mt-0.5'} />
                  </div>
                  <div>
                    <label className="text-[#86868b]">有效天数</label>
                    <input type="number" value={r.valid_days ?? ''} onChange={e => update(i, { valid_days: Number(e.target.value) })} className={INPUT_CLS + ' text-[12px] mt-0.5'} />
                  </div>
                </>
              )}
            </div>
          </div>
        ))}
        {value.length === 0 && (
          <div className="text-center text-[12px] text-[#86868b] py-3 border border-dashed border-[#d2d2d7] rounded-lg">暂无奖励</div>
        )}
        <button onClick={add} className="w-full py-1.5 text-[12px] text-[#007aff] font-medium border border-dashed border-[#007aff]/30 rounded-lg hover:bg-[#007aff]/5 transition-colors">
          + 添加奖励
        </button>
      </div>
    </div>
  )
}

function parseRewards(raw: unknown): RewardItem[] {
  if (!raw) return []
  const arr = Array.isArray(raw) ? raw : [raw]
  return arr.filter((r: any) => r && typeof r === 'object' && r.type)
}

function describeRewardItems(items: RewardItem[]): string {
  if (items.length === 0) return '无'
  return items.map(r => {
    switch (r.type) {
      case 'coupon': return `优惠券 $${r.amount ?? 0}${r.valid_days ? ` (${r.valid_days}天)` : ''}`
      case 'tokens': {
        const amt = r.amount ?? 0
        const display = amt >= 1_000_000 ? `${(amt / 1_000_000).toFixed(1)}M` : `${(amt / 1000).toFixed(0)}K`
        return `Token ${display}${r.valid_days ? ` (${r.valid_days}天)` : ''}`
      }
      case 'free_days': return `免费 ${r.days ?? 0} 天`
      case 'discount': return `${((r.rate ?? 1) * 10).toFixed(0)}折 x${r.periods ?? 1}期`
      default: return JSON.stringify(r)
    }
  }).join(' + ')
}

/* ---------- Campaign types ---------- */

interface Campaign {
  id: string
  name: string
  type: string
  status: string
  start_at: string | null
  end_at: string | null
  max_uses: number
  current_uses: number
  invite_required: boolean
  code_prefix: string
  codes_per_user: number
  bind_window: string
  inviter_rewards: unknown
  invitee_rewards: unknown
  created_at: string
}

const CAMPAIGN_STATUS: Record<string, { label: string; cls: string }> = {
  active:   { label: '进行中', cls: 'bg-[#34c759]/10 text-[#34c759]' },
  paused:   { label: '已暂停', cls: 'bg-[#ff9500]/10 text-[#ff9500]' },
  ended:    { label: '已结束', cls: 'bg-[#8e8e93]/10 text-[#8e8e93]' },
  draft:    { label: '草稿', cls: 'bg-[#007aff]/10 text-[#007aff]' },
}

export function AdminCampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)

  const [fName, setFName] = useState('')
  const [fType, setFType] = useState('invite')
  const [fStatus, setFStatus] = useState('active')
  const [fEndAt, setFEndAt] = useState('')
  const [fMaxUses, setFMaxUses] = useState('0')
  const [fCodesPerUser, setFCodesPerUser] = useState('1')
  const [fCodePrefix, setFCodePrefix] = useState('')
  const [fBindWindow, setFBindWindow] = useState('5 days')
  const [fInviterRewards, setFInviterRewards] = useState<RewardItem[]>([])
  const [fInviteeRewards, setFInviteeRewards] = useState<RewardItem[]>([])
  const [submitting, setSubmitting] = useState(false)

  const fetchCampaigns = useCallback(async () => {
    try {
      const data = await api<{ campaigns: Campaign[] }>('/admin/campaigns')
      setCampaigns(data.campaigns ?? [])
    } catch {
      setCampaigns([])
    }
  }, [])

  useEffect(() => {
    fetchCampaigns().finally(() => setLoading(false))
  }, [fetchCampaigns])

  const handleCreate = async () => {
    setSubmitting(true)
    try {
      await api('/admin/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name: fName,
          type: fType,
          status: fStatus,
          end_at: fEndAt || null,
          max_uses: Number(fMaxUses),
          codes_per_user: Number(fCodesPerUser),
          code_prefix: fCodePrefix,
          bind_window: fBindWindow,
          inviter_rewards: fInviterRewards.length > 0 ? fInviterRewards : null,
          invitee_rewards: fInviteeRewards.length > 0 ? fInviteeRewards : null,
        }),
      })
      setShowForm(false)
      setFName('')
      setFInviterRewards([])
      setFInviteeRewards([])
      await fetchCampaigns()
    } catch (e: unknown) {
      await dialog.alert(e instanceof Error ? e.message : '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleToggleStatus = async (c: Campaign) => {
    const newStatus = c.status === 'active' ? 'paused' : 'active'
    try {
      await api(`/admin/campaigns/${c.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      })
      await fetchCampaigns()
    } catch (e: unknown) {
      await dialog.alert(e instanceof Error ? e.message : '操作失败')
    }
  }

  if (loading) return <LoadingView />

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-[#1d1d1f]">活动管理</h1>
          <p className="text-[13px] text-[#86868b] mt-0.5">管理邀请活动和奖励配置</p>
        </div>
        <button onClick={() => setShowForm(true)} className={BTN_PRIMARY}>新建活动</button>
      </div>

      {campaigns.length === 0 ? (
        <EmptyView text="暂无活动" />
      ) : (
        <div className="space-y-3">
          {campaigns.map(c => {
            const badge = CAMPAIGN_STATUS[c.status] ?? CAMPAIGN_STATUS.draft
            return (
              <div key={c.id} className={CARD_CLS}>
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[15px] font-semibold text-[#1d1d1f]">{c.name}</span>
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${badge.cls}`}>
                        {badge.label}
                      </span>
                      <span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#f5f5f7] text-[#6e6e73]">
                        {c.type}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[#86868b]">
                      <span>使用: {c.current_uses}/{c.max_uses || '无限'}</span>
                      <span>每码可用: {c.max_uses || '无限'}次</span>
                      <span>每人{c.codes_per_user}个码</span>
                      {c.code_prefix && <span>前缀: {c.code_prefix}</span>}
                      {c.end_at && <span>截止: {fmtDate(c.end_at)}</span>}
                      <span>绑定窗口: {c.bind_window}</span>
                    </div>
                    {(c.inviter_rewards || c.invitee_rewards) && (
                      <div className="mt-2 text-[12px] text-[#6e6e73]">
                        {c.inviter_rewards && <div>邀请人奖励: {describeRewardItems(parseRewards(c.inviter_rewards))}</div>}
                        {c.invitee_rewards && <div>被邀请人奖励: {describeRewardItems(parseRewards(c.invitee_rewards))}</div>}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => handleToggleStatus(c)}
                    className={c.status === 'active' ? BTN_DANGER : BTN_SECONDARY}
                  >
                    {c.status === 'active' ? '暂停' : '启用'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Modal open={showForm} onClose={() => setShowForm(false)}>
        <div className="space-y-4">
          <h2 className="text-[17px] font-semibold text-[#1d1d1f]">新建活动</h2>
          <div>
            <label className="block text-[13px] text-[#6e6e73] mb-1.5">活动名称</label>
            <input value={fName} onChange={e => setFName(e.target.value)} placeholder="例如: 春季邀请活动" className={INPUT_CLS} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] text-[#6e6e73] mb-1.5">类型</label>
              <select value={fType} onChange={e => setFType(e.target.value)} className={INPUT_CLS}>
                <option value="invite">invite</option>
                <option value="promotion">promotion</option>
              </select>
            </div>
            <div>
              <label className="block text-[13px] text-[#6e6e73] mb-1.5">状态</label>
              <select value={fStatus} onChange={e => setFStatus(e.target.value)} className={INPUT_CLS}>
                <option value="active">active</option>
                <option value="paused">paused</option>
                <option value="draft">draft</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] text-[#6e6e73] mb-1.5">截止日期</label>
              <input type="date" value={fEndAt} onChange={e => setFEndAt(e.target.value)} className={INPUT_CLS} />
            </div>
            <div>
              <label className="block text-[13px] text-[#6e6e73] mb-1.5">最大使用数</label>
              <input type="number" value={fMaxUses} onChange={e => setFMaxUses(e.target.value)} className={INPUT_CLS} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] text-[#6e6e73] mb-1.5">每人邀请码数 (建议1)</label>
              <input type="number" value={fCodesPerUser} onChange={e => setFCodesPerUser(e.target.value)} className={INPUT_CLS} />
            </div>
            <div>
              <label className="block text-[13px] text-[#6e6e73] mb-1.5">邀请码前缀</label>
              <input value={fCodePrefix} onChange={e => setFCodePrefix(e.target.value)} placeholder="例如: SPR" className={INPUT_CLS} />
            </div>
          </div>
          <div>
            <label className="block text-[13px] text-[#6e6e73] mb-1.5">绑定窗口</label>
            <input value={fBindWindow} onChange={e => setFBindWindow(e.target.value)} placeholder="5 days" className={INPUT_CLS} />
          </div>
          <RewardEditor label="邀请人奖励" value={fInviterRewards} onChange={setFInviterRewards} />
          <RewardEditor label="被邀请人奖励" value={fInviteeRewards} onChange={setFInviteeRewards} />
          <div className="flex gap-2">
            <button onClick={() => setShowForm(false)} className="flex-1 py-2.5 text-[14px] font-medium text-[#6e6e73] bg-[#f5f5f7] rounded-lg hover:bg-[#e8e8ed] transition-colors">取消</button>
            <button onClick={handleCreate} disabled={submitting || !fName} className={BTN_PRIMARY + ' flex-1 py-2.5'}>
              {submitting ? '创建中...' : '创建'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

/* ========================================================================== */
/*  AdminSystemPage                                                           */
/* ========================================================================== */

interface SystemStats {
  pg_pool_size: number
  uptime: number
  node_version: string
}

interface GatewayHealth {
  status?: string
  error?: string
  detail?: string
}

interface ReloadReport {
  ok: boolean
  error?: string | null
  mode?: string
  message?: string
  elapsed_ms?: number
  pool_transition?: string
  accounts_before?: number
  accounts_after?: number
  accounts_added?: string[]
  accounts_removed?: string[]
  tokens_refreshed?: string[]
  default_profile_before?: string | null
  default_profile_after?: string | null
  actions?: string[]
}

export function AdminSystemPage() {
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [gateway, setGateway] = useState<GatewayHealth | null>(null)
  const [gatewayError, setGatewayError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [lastReload, setLastReload] = useState<{ at: string; report: ReloadReport } | null>(null)

  const fetchStats = useCallback(async () => {
    try {
      const data = await api<SystemStats>('/admin/system/stats')
      setStats(data)
    } catch {
      setStats(null)
    }
  }, [])

  const fetchGateway = useCallback(async () => {
    try {
      const data = await api<GatewayHealth>('/admin/system/gateway')
      setGateway(data)
      setGatewayError(false)
    } catch {
      setGateway(null)
      setGatewayError(true)
    }
  }, [])

  useEffect(() => {
    Promise.all([fetchStats(), fetchGateway()]).finally(() => setLoading(false))
  }, [fetchStats, fetchGateway])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await Promise.all([fetchStats(), fetchGateway()])
    } finally {
      setRefreshing(false)
    }
  }

  const handleReload = async () => {
    setReloading(true)
    try {
      const report = await api<ReloadReport>('/admin/system/reload', { method: 'POST' })
      setLastReload({ at: new Date().toISOString(), report })
      await fetchGateway()
    } catch (e: unknown) {
      setLastReload({
        at: new Date().toISOString(),
        report: { ok: false, error: e instanceof Error ? e.message : '重载失败' },
      })
    } finally {
      setReloading(false)
    }
  }

  if (loading) return <LoadingView />

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-[#1d1d1f]">系统状态</h1>
        <p className="text-[13px] text-[#86868b] mt-0.5">查看系统运行状态和网关健康情况</p>
      </div>

      {/* System stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className={CARD_CLS}>
          <div className="text-[12px] text-[#86868b] font-medium">PG Pool Size</div>
          <div className="mt-1 text-[24px] font-bold text-[#1d1d1f] tabular-nums">{stats?.pg_pool_size ?? '-'}</div>
        </div>
        <div className={CARD_CLS}>
          <div className="text-[12px] text-[#86868b] font-medium">运行时间</div>
          <div className="mt-1 text-[24px] font-bold text-[#1d1d1f]">{stats ? fmtUptime(stats.uptime) : '-'}</div>
        </div>
        <div className={CARD_CLS}>
          <div className="text-[12px] text-[#86868b] font-medium">Node 版本</div>
          <div className="mt-1 text-[24px] font-bold text-[#1d1d1f]">{stats?.node_version ?? '-'}</div>
        </div>
      </div>

      {/* Gateway health */}
      <div className={CARD_CLS}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[15px] font-semibold text-[#1d1d1f]">Gateway 健康</h2>
          <div className="flex items-center gap-2">
            <button onClick={handleRefresh} disabled={refreshing} className={BTN_SECONDARY}>
              {refreshing ? '刷新中...' : '刷新'}
            </button>
            <button onClick={handleReload} disabled={reloading} className={BTN_PRIMARY}>
              {reloading ? '重载中...' : '重载 Gateway'}
            </button>
          </div>
        </div>
        {gatewayError ? (
          <div className="flex items-center gap-2 py-4">
            <span className="inline-block w-3 h-3 rounded-full bg-[#ff3b30]" />
            <span className="text-[14px] text-[#ff3b30] font-medium">Gateway 不可达</span>
          </div>
        ) : gateway ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className={`inline-block w-3 h-3 rounded-full ${gateway.status === 'ok' ? 'bg-[#34c759]' : 'bg-[#ff9500]'}`} />
              <span className="text-[14px] text-[#1d1d1f] font-medium">
                {gateway.status === 'ok' ? '运行正常' : `状态: ${gateway.status}`}
              </span>
            </div>
            <div className="bg-[#f5f5f7] rounded-lg p-3 font-mono text-[12px] text-[#6e6e73]">
              {JSON.stringify(gateway, null, 2)}
            </div>
          </div>
        ) : (
          <div className="text-[13px] text-[#86868b] py-4">无法获取 Gateway 状态</div>
        )}

        {lastReload && (
          <div className="mt-4 border-t border-[#e5e5ea] pt-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[13px] font-semibold text-[#1d1d1f]">最近一次重载</h3>
              <span className="text-[11px] text-[#86868b]">{new Date(lastReload.at).toLocaleString()}</span>
            </div>
            {!lastReload.report.ok ? (
              <div className="text-[13px] text-[#ff3b30]">失败: {lastReload.report.error}</div>
            ) : (
              <div className="space-y-1 text-[12px] text-[#1d1d1f]">
                <div>
                  <span className="text-[#86868b]">耗时：</span>
                  <span className="tabular-nums">{lastReload.report.elapsed_ms ?? '-'} ms</span>
                  {lastReload.report.mode === 'async-fallback' && (
                    <span className="ml-2 text-[#ff9500]">（HTTP 不可达 → NOTIFY 异步回退）</span>
                  )}
                </div>
                {lastReload.report.pool_transition && (
                  <div>
                    <span className="text-[#86868b]">池状态：</span>
                    <span>{lastReload.report.pool_transition}</span>
                  </div>
                )}
                <div>
                  <span className="text-[#86868b]">账号：</span>
                  <span className="tabular-nums">{lastReload.report.accounts_before ?? '-'} → {lastReload.report.accounts_after ?? '-'}</span>
                  {lastReload.report.accounts_added?.length ? <span className="ml-2 text-[#34c759]">+{lastReload.report.accounts_added.join(', ')}</span> : null}
                  {lastReload.report.accounts_removed?.length ? <span className="ml-2 text-[#ff3b30]">-{lastReload.report.accounts_removed.join(', ')}</span> : null}
                </div>
                {lastReload.report.tokens_refreshed?.length ? (
                  <div>
                    <span className="text-[#86868b]">刷新 Token：</span>
                    <span>{lastReload.report.tokens_refreshed.join(', ')}</span>
                  </div>
                ) : null}
                {(lastReload.report.default_profile_before !== lastReload.report.default_profile_after) && (
                  <div>
                    <span className="text-[#86868b]">默认 Profile：</span>
                    <span>{lastReload.report.default_profile_before ?? '（空）'} → {lastReload.report.default_profile_after ?? '（空）'}</span>
                  </div>
                )}
                {lastReload.report.actions?.length ? (
                  <div>
                    <span className="text-[#86868b]">执行步骤：</span>
                    <span className="font-mono text-[11px]">{lastReload.report.actions.join(' → ')}</span>
                  </div>
                ) : null}
                {lastReload.report.message && (
                  <div className="text-[#86868b]">{lastReload.report.message}</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* System Settings */}
      <SystemSettings />

      {/* Last fetched */}
      <div className="text-[11px] text-[#aeaeb2] text-center">
        数据更新于 {fmtDateTime(new Date().toISOString())}
      </div>
    </div>
  )
}

/* ---------- SystemSettings (inline component) ---------- */

interface Setting {
  key: string
  value: string
  updated_at: string
}

const SETTING_LABELS: Record<string, { label: string; description: string }> = {
  gateway_url: { label: 'Gateway 地址', description: '客户端 Launcher 脚本中的 ANTHROPIC_BASE_URL，例如 https://gw.example.com' },
  epay_url: { label: '易支付网关', description: '易支付 API 地址' },
  epay_pid: { label: '易支付商户ID', description: '' },
  epay_key: { label: '易支付密钥', description: '' },
  epay_notify_url: { label: '易支付回调地址', description: '留空则自动用 gateway_url + /api/payments/notify' },
  epay_return_url: { label: '易支付返回地址', description: '支付完成后跳转，留空则自动用 gateway_url + /billing' },
  grace_days: { label: '欠费宽限天数', description: '账单逾期后多少天停用客户端，默认 3' },
  payment_product_name: { label: '支付商品名称', description: '易支付页面显示的商品名称，套餐名会拼接在前面' },
  session_ttl_seconds: { label: '会话粘性时长（秒）', description: 'OAuth 账号池粘性会话的过期时间，默认 86400（24小时）' },
  client_require_approval: { label: '客户端创建需审核', description: 'true（默认）= 新客户端状态 pending，需管理员审核；false = 直接 active 无需审核' },
}

function SystemSettings() {
  const [settings, setSettings] = useState<Setting[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState('')

  const fetchSettings = useCallback(async () => {
    try {
      const data = await api<Setting[]>('/admin/settings')
      setSettings(Array.isArray(data) ? data : [])
    } catch {
      setSettings([])
    }
  }, [])

  useEffect(() => { fetchSettings() }, [fetchSettings])

  const handleSave = async (key: string) => {
    setSaving(true)
    try {
      await api(`/admin/settings/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ value: editValue }),
      })
      setEditing(null)
      setToast('已保存')
      setTimeout(() => setToast(''), 2000)
      await fetchSettings()
    } catch {
      setToast('保存失败')
      setTimeout(() => setToast(''), 2000)
    } finally {
      setSaving(false)
    }
  }

  const handleAdd = async () => {
    const key = await dialog.prompt('设置项名称 (英文)')
    if (!key) return
    const value = await dialog.prompt('值')
    if (value === null) return
    try {
      await api(`/admin/settings/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      })
      await fetchSettings()
    } catch {
      // ignore
    }
  }

  // Merge known settings with DB settings
  const allKeys = new Set([...Object.keys(SETTING_LABELS), ...settings.map(s => s.key)])
  const mergedSettings = Array.from(allKeys).map(key => {
    const dbSetting = settings.find(s => s.key === key)
    const meta = SETTING_LABELS[key]
    return {
      key,
      value: dbSetting?.value ?? '',
      label: meta?.label ?? key,
      description: meta?.description ?? '',
      updated_at: dbSetting?.updated_at ?? '',
      exists: !!dbSetting,
    }
  })

  return (
    <div className={CARD_CLS}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[15px] font-semibold text-[#1d1d1f]">系统设置</h2>
        <div className="flex items-center gap-2">
          {toast && <span className="text-[12px] text-[#34c759] font-medium">{toast}</span>}
          <button onClick={handleAdd} className={BTN_SECONDARY}>添加设置</button>
        </div>
      </div>
      <div className="divide-y divide-[#f0f0f0]">
        {mergedSettings.map(s => (
          <div key={s.key} className="py-3 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium text-[#1d1d1f]">{s.label}</div>
              {s.description && <div className="text-[11px] text-[#aeaeb2] mt-0.5">{s.description}</div>}
            </div>
            {editing === s.key ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSave(s.key)}
                  className="px-2.5 py-1.5 border border-[#d2d2d7] rounded-lg text-[13px] w-[280px] outline-none focus:border-[#007aff]"
                  autoFocus
                />
                <button onClick={() => handleSave(s.key)} disabled={saving} className={BTN_PRIMARY}>
                  {saving ? '...' : '保存'}
                </button>
                <button onClick={() => setEditing(null)} className={BTN_SECONDARY}>取消</button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-[#6e6e73] font-mono max-w-[280px] truncate">
                  {s.value || <span className="text-[#c7c7cc] italic">未设置</span>}
                </span>
                <button
                  onClick={() => { setEditing(s.key); setEditValue(s.value) }}
                  className="text-[12px] text-[#007aff] hover:underline"
                >
                  编辑
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
