import { useEffect, useState, useCallback } from 'react'
import { api } from '../../api/client'
import { useAuthStore } from '../../stores/auth'
import { dialog } from '../../ui'

/* ---------- types ---------- */

interface InviteCode {
  id: string
  code: string
  campaign_id: string
  campaign_name: string
  max_uses: number
  used_count: number
  status: string
  created_at: string
}

interface InviteRecord {
  id: string
  invitee_id: string
  invitee_username: string
  status: string
  created_at: string
  invite_code: string
}

interface Campaign {
  id: string
  name: string
  type: string
  status: string
  end_at: string | null
  codes_per_user: number
  inviter_rewards: unknown
  invitee_rewards: unknown
}

/* ---------- constants ---------- */

const CARD_CLS = 'bg-white rounded-[14px] shadow-[0_1px_2px_rgba(0,0,0,0.04)] p-5'

const CODE_STATUS: Record<string, { label: string; cls: string }> = {
  active:   { label: '可用', cls: 'bg-[#34c759]/10 text-[#34c759]' },
  expired:  { label: '已过期', cls: 'bg-[#8e8e93]/10 text-[#8e8e93]' },
  disabled: { label: '已停用', cls: 'bg-[#ff3b30]/10 text-[#ff3b30]' },
}

const RECORD_STATUS: Record<string, { label: string; cls: string }> = {
  bound:    { label: '已绑定', cls: 'text-[#34c759]' },
  rewarded: { label: '已发奖', cls: 'text-[#007aff]' },
  pending:  { label: '等待中', cls: 'text-[#ff9500]' },
}

/* ---------- helpers ---------- */

function fmtDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function describeRewards(rewards: unknown): string {
  if (!rewards || typeof rewards !== 'object') return '无'
  const r = rewards as Record<string, unknown>
  const parts: string[] = []
  if (r.coupon_amount) parts.push(`优惠券 $${r.coupon_amount}`)
  if (r.token_amount) parts.push(`Token ${Number(r.token_amount) >= 1_000_000 ? (Number(r.token_amount) / 1_000_000).toFixed(1) + 'M' : Number(r.token_amount) >= 1_000 ? (Number(r.token_amount) / 1_000).toFixed(0) + 'K' : r.token_amount}`)
  if (r.free_days) parts.push(`免费 ${r.free_days} 天`)
  if (r.discount_rate) parts.push(`${Math.round(Number(r.discount_rate) * 10)}折`)
  return parts.length > 0 ? parts.join(' + ') : '参与活动即可获得奖励'
}

/* ---------- main ---------- */

export default function InvitePage() {
  const user = useAuthStore(s => s.user)
  const [codes, setCodes] = useState<InviteCode[]>([])
  const [records, setRecords] = useState<InviteRecord[]>([])
  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [bindCode, setBindCode] = useState('')
  const [binding, setBinding] = useState(false)
  const [hasBound, setHasBound] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const fetchCodes = useCallback(async () => {
    try {
      const data = await api<{ invite_codes: InviteCode[] }>('/invite-codes')
      const list = data.invite_codes ?? []
      setCodes(list)
      // Extract campaign info from first code
      if (list.length > 0) {
        // Try to get active campaign info
        try {
          const campData = await api<{ campaigns: Campaign[] }>('/admin/campaigns')
          const active = campData.campaigns?.find(c => c.status === 'active' && c.type === 'invite')
          if (active) setCampaign(active)
        } catch {
          // Non-admin: build campaign info from codes
          const first = list[0]
          setCampaign({
            id: first.campaign_id,
            name: first.campaign_name,
            type: 'invite',
            status: 'active',
            end_at: null,
            codes_per_user: 5,
            inviter_rewards: null,
            invitee_rewards: null,
          })
        }
      }
    } catch {
      setCodes([])
    }
  }, [])

  const fetchRecords = useCallback(async () => {
    try {
      const data = await api<{ records: InviteRecord[] }>('/invite/records')
      setRecords(data.records ?? [])
    } catch {
      setRecords([])
    }
  }, [])

  useEffect(() => {
    Promise.all([fetchCodes(), fetchRecords()]).finally(() => setLoading(false))
  }, [fetchCodes, fetchRecords])

  // Check if user has already bound an invite code (simplified: if they appear in any record as invitee)
  useEffect(() => {
    if (user) {
      // If user was invited, the records endpoint won't show it (it shows who I invited)
      // We'll just show bind section always and let the API return an error if already bound
      setHasBound(false)
    }
  }, [user])

  const handleGenerate = async () => {
    setGenerating(true)
    try {
      await api('/invite-codes', { method: 'POST' })
      await fetchCodes()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '生成失败'
      await dialog.alert(msg)
    } finally {
      setGenerating(false)
    }
  }

  const handleBind = async () => {
    if (!bindCode.trim()) return
    setBinding(true)
    try {
      await api('/invite/bind', {
        method: 'POST',
        body: JSON.stringify({ code: bindCode.trim() }),
      })
      setHasBound(true)
      setBindCode('')
      await dialog.alert('邀请码绑定成功！')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '绑定失败'
      await dialog.alert(msg)
    } finally {
      setBinding(false)
    }
  }

  const handleCopy = (code: string) => {
    navigator.clipboard.writeText(code)
    setCopied(code)
    setTimeout(() => setCopied(null), 2000)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[#86868b] text-[13px]">
        加载中...
      </div>
    )
  }

  const myCode = codes[0] ?? null  // Each user has at most 1 code per campaign
  const canGenerate = codes.length === 0

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-[#1d1d1f]">邀请好友</h1>
        <p className="text-[13px] text-[#86868b] mt-0.5">邀请好友注册，双方都可以获得奖励</p>
      </div>

      {/* Active campaign card */}
      {campaign && (
        <div className={CARD_CLS}>
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-[15px] font-semibold text-[#1d1d1f]">{campaign.name}</h2>
                <span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#34c759]/10 text-[#34c759]">
                  进行中
                </span>
              </div>
              <div className="mt-2 space-y-1 text-[13px] text-[#6e6e73]">
                {campaign.inviter_rewards && (
                  <p>邀请人奖励: {describeRewards(campaign.inviter_rewards)}</p>
                )}
                {campaign.invitee_rewards && (
                  <p>被邀请人奖励: {describeRewards(campaign.invitee_rewards)}</p>
                )}
                {campaign.end_at && (
                  <p>截止日期: {fmtDate(campaign.end_at)}</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* My invite code */}
      <div className={CARD_CLS}>
        <h2 className="text-[15px] font-semibold text-[#1d1d1f] mb-4">我的邀请码</h2>

        {myCode ? (
          <div>
            <div className="flex items-center gap-3 bg-[#f5f5f7] rounded-xl p-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[18px] font-bold text-[#1d1d1f] tracking-widest">
                    {myCode.code}
                  </span>
                  {myCode.used_count >= myCode.max_uses ? (
                    <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-[#8e8e93]/10 text-[#8e8e93]">已用完</span>
                  ) : (
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${(CODE_STATUS[myCode.status] ?? CODE_STATUS.active).cls}`}>
                      {(CODE_STATUS[myCode.status] ?? CODE_STATUS.active).label}
                    </span>
                  )}
                </div>
                <div className="mt-2 flex items-center gap-4">
                  <div className="text-[13px] text-[#6e6e73]">
                    已邀请 <span className="font-semibold text-[#1d1d1f]">{myCode.used_count}</span> / {myCode.max_uses} 人
                  </div>
                  <div className="flex-1 h-2 bg-[#e5e5ea] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#007aff] rounded-full transition-all"
                      style={{ width: `${Math.min(100, (myCode.used_count / myCode.max_uses) * 100)}%` }}
                    />
                  </div>
                </div>
              </div>
              <button
                onClick={() => handleCopy(myCode.code)}
                className="px-4 py-2 text-[13px] font-medium text-white bg-[#007aff] rounded-lg hover:bg-[#0066d6] transition-colors shrink-0"
              >
                {copied === myCode.code ? '已复制' : '复制'}
              </button>
            </div>
          </div>
        ) : canGenerate ? (
          <div className="text-center py-6">
            <p className="text-[13px] text-[#86868b] mb-4">获取你的专属邀请码，分享给好友</p>
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="px-6 py-2.5 bg-[#007aff] text-white text-[14px] font-medium rounded-xl hover:bg-[#0066d6] disabled:opacity-40 transition-colors"
            >
              {generating ? '生成中...' : '获取邀请码'}
            </button>
          </div>
        ) : (
          <div className="text-center text-[#86868b] text-[13px] py-6">暂无可用的邀请活动</div>
        )}
      </div>

      {/* Invite records table */}
      <div className={CARD_CLS}>
        <h2 className="text-[15px] font-semibold text-[#1d1d1f] mb-4">邀请记录</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-[#e5e5ea]">
                <th className="pb-2 font-medium text-[#86868b]">用户</th>
                <th className="pb-2 font-medium text-[#86868b]">邀请码</th>
                <th className="pb-2 font-medium text-[#86868b]">绑定时间</th>
                <th className="pb-2 font-medium text-[#86868b] text-center">状态</th>
              </tr>
            </thead>
            <tbody>
              {records.map(r => {
                const badge = RECORD_STATUS[r.status] ?? RECORD_STATUS.pending
                return (
                  <tr key={r.id} className="border-b border-[#f5f5f7] last:border-0">
                    <td className="py-2.5 text-[#1d1d1f]">{r.invitee_username}</td>
                    <td className="py-2.5 font-mono text-[#6e6e73]">{r.invite_code}</td>
                    <td className="py-2.5 text-[#6e6e73]">{fmtDate(r.created_at)}</td>
                    <td className="py-2.5 text-center">
                      <span className={`text-[12px] font-medium ${badge.cls}`}>{badge.label}</span>
                    </td>
                  </tr>
                )
              })}
              {records.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-[#86868b]">暂无邀请记录</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Bind invite code section */}
      {!hasBound && (
        <div className={CARD_CLS}>
          <h2 className="text-[15px] font-semibold text-[#1d1d1f] mb-3">绑定邀请码</h2>
          <p className="text-[13px] text-[#86868b] mb-4">如果你是通过好友邀请注册的，输入邀请码绑定后双方都可以获得奖励</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={bindCode}
              onChange={e => setBindCode(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleBind()}
              placeholder="输入邀请码"
              className="flex-1 px-3 py-2 border border-[#d2d2d7] rounded-lg text-[14px] text-[#1d1d1f] placeholder:text-[#aeaeb2] focus:outline-none focus:ring-2 focus:ring-[#007aff]/30 focus:border-[#007aff] transition-colors font-mono"
            />
            <button
              onClick={handleBind}
              disabled={binding || !bindCode.trim()}
              className="px-4 py-2 bg-[#007aff] text-white text-[13px] font-medium rounded-lg hover:bg-[#0066d6] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {binding ? '绑定中...' : '绑定'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
