import { useEffect, useState, useCallback } from 'react'
import { api } from '../../api/client'

/* ---------- types ---------- */

interface Reward {
  id: string
  type: string
  token_amount: number | null
  token_remaining: number | null
  free_until: string | null
  discount_rate: number | null
  discount_periods_left: number | null
  coupon_id: string | null
  status: string
  expires_at: string | null
  created_at: string
  campaign_name: string
}

interface Coupon {
  id: string
  code: string
  amount: number
  min_order: number | null
  status: string
  expires_at: string | null
  used_at: string | null
  created_at: string
}

/* ---------- constants ---------- */

const STATUS_MAP: Record<string, { label: string; cls: string }> = {
  active:  { label: '可用', cls: 'bg-[#34c759]/10 text-[#34c759]' },
  used:    { label: '已用', cls: 'bg-[#8e8e93]/10 text-[#8e8e93]' },
  expired: { label: '已过期', cls: 'bg-[#ff3b30]/10 text-[#ff3b30]' },
  unused:  { label: '可用', cls: 'bg-[#34c759]/10 text-[#34c759]' },
}

const COLORS: Record<string, string> = {
  coupon:   'bg-[#ff9500]',
  token:    'bg-[#af52de]',
  free:     'bg-[#34c759]',
  discount: 'bg-[#007aff]',
}

/* ---------- helpers ---------- */

function fmtDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function fmtTokenAmount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K'
  return n.toString()
}

function isExpired(dateStr: string | null): boolean {
  if (!dateStr) return false
  return new Date(dateStr) < new Date()
}

function resolveStatus(status: string, expiresAt: string | null): { label: string; cls: string } {
  if (isExpired(expiresAt) && status !== 'used') {
    return STATUS_MAP.expired
  }
  return STATUS_MAP[status] ?? STATUS_MAP.active
}

/* ---------- main ---------- */

export default function RewardsPage() {
  const [rewards, setRewards] = useState<Reward[]>([])
  const [coupons, setCoupons] = useState<Coupon[]>([])
  const [loading, setLoading] = useState(true)

  const fetchRewards = useCallback(async () => {
    try {
      const data = await api<{ rewards: Reward[] }>('/rewards')
      setRewards(data.rewards ?? [])
    } catch {
      setRewards([])
    }
  }, [])

  const fetchCoupons = useCallback(async () => {
    try {
      const data = await api<{ coupons: Coupon[] }>('/coupons')
      setCoupons(data.coupons ?? [])
    } catch {
      setCoupons([])
    }
  }, [])

  useEffect(() => {
    Promise.all([fetchRewards(), fetchCoupons()]).finally(() => setLoading(false))
  }, [fetchRewards, fetchCoupons])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[#86868b] text-[13px]">
        加载中...
      </div>
    )
  }

  // Build unified card list
  type CardItem =
    | { kind: 'coupon'; coupon: Coupon }
    | { kind: 'reward'; reward: Reward }

  const cards: CardItem[] = [
    ...coupons.map(c => ({ kind: 'coupon' as const, coupon: c })),
    ...rewards.map(r => ({ kind: 'reward' as const, reward: r })),
  ]

  const isEmpty = cards.length === 0

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-[#1d1d1f]">我的奖励</h1>
        <p className="text-[13px] text-[#86868b] mt-0.5">通过邀请好友和参与活动获得的奖励</p>
      </div>

      {isEmpty ? (
        <div className="bg-white rounded-[14px] shadow-[0_1px_2px_rgba(0,0,0,0.04)] p-5 text-center text-[#86868b] text-[13px] py-12">
          暂无奖励，去邀请好友获取奖励吧
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {cards.map(card => {
            if (card.kind === 'coupon') {
              const c = card.coupon
              const badge = resolveStatus(c.status, c.expires_at)
              return (
                <div key={`coupon-${c.id}`} className="bg-white rounded-[14px] shadow-[0_1px_2px_rgba(0,0,0,0.04)] overflow-hidden">
                  {/* Gradient header */}
                  <div className={`${COLORS.coupon} px-5 py-4`}>
                    <div className="flex items-center justify-between">
                      <div className="text-white/80 text-[12px] font-medium">优惠券</div>
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-white/20 text-white`}>
                        {badge.label}
                      </span>
                    </div>
                    <div className="mt-1 text-white text-[28px] font-bold tracking-tight">
                      ${Number(c.amount).toFixed(0)}
                    </div>
                  </div>
                  {/* Body */}
                  <div className="px-5 py-4 space-y-2 text-[13px]">
                    <div className="flex justify-between text-[#6e6e73]">
                      <span>兑换码</span>
                      <span className="font-mono text-[#1d1d1f]">{c.code}</span>
                    </div>
                    {c.min_order != null && (
                      <div className="flex justify-between text-[#6e6e73]">
                        <span>最低消费</span>
                        <span className="text-[#1d1d1f]">${Number(c.min_order).toFixed(0)}</span>
                      </div>
                    )}
                    {c.expires_at && (
                      <div className="flex justify-between text-[#6e6e73]">
                        <span>有效期至</span>
                        <span className="text-[#1d1d1f]">{fmtDate(c.expires_at)}</span>
                      </div>
                    )}
                    {c.used_at && (
                      <div className="flex justify-between text-[#6e6e73]">
                        <span>使用时间</span>
                        <span className="text-[#1d1d1f]">{fmtDate(c.used_at)}</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            }

            // Reward card
            const r = card.reward
            const badge = resolveStatus(r.status, r.expires_at)

            // Determine type
            if (r.type === 'token_credit' && r.token_amount != null) {
              const total = r.token_amount
              const remaining = r.token_remaining ?? 0
              const pct = total > 0 ? Math.round((remaining / total) * 100) : 0
              return (
                <div key={`reward-${r.id}`} className="bg-white rounded-[14px] shadow-[0_1px_2px_rgba(0,0,0,0.04)] overflow-hidden">
                  <div className={`${COLORS.token} px-5 py-4`}>
                    <div className="flex items-center justify-between">
                      <div className="text-white/80 text-[12px] font-medium">Token 额度</div>
                      <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-white/20 text-white">
                        {badge.label}
                      </span>
                    </div>
                    <div className="mt-1 text-white text-[28px] font-bold tracking-tight">
                      {fmtTokenAmount(total)}
                    </div>
                  </div>
                  <div className="px-5 py-4 space-y-3 text-[13px]">
                    <div>
                      <div className="flex justify-between text-[#6e6e73] mb-1.5">
                        <span>剩余 / 总量</span>
                        <span className="text-[#1d1d1f] font-medium tabular-nums">{fmtTokenAmount(remaining)} / {fmtTokenAmount(total)}</span>
                      </div>
                      <div className="w-full h-2 bg-[#f5f5f7] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[#af52de] rounded-full transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                    <div className="flex justify-between text-[#6e6e73]">
                      <span>来源</span>
                      <span className="text-[#1d1d1f]">{r.campaign_name}</span>
                    </div>
                    {r.expires_at && (
                      <div className="flex justify-between text-[#6e6e73]">
                        <span>有效期至</span>
                        <span className="text-[#1d1d1f]">{fmtDate(r.expires_at)}</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            }

            if (r.type === 'free_days' && r.free_until) {
              return (
                <div key={`reward-${r.id}`} className="bg-white rounded-[14px] shadow-[0_1px_2px_rgba(0,0,0,0.04)] overflow-hidden">
                  <div className={`${COLORS.free} px-5 py-4`}>
                    <div className="flex items-center justify-between">
                      <div className="text-white/80 text-[12px] font-medium">免费使用</div>
                      <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-white/20 text-white">
                        {badge.label}
                      </span>
                    </div>
                    <div className="mt-1 text-white text-[28px] font-bold tracking-tight">
                      免费
                    </div>
                  </div>
                  <div className="px-5 py-4 space-y-2 text-[13px]">
                    <div className="flex justify-between text-[#6e6e73]">
                      <span>免费至</span>
                      <span className="text-[#1d1d1f] font-medium">{fmtDate(r.free_until)}</span>
                    </div>
                    <div className="flex justify-between text-[#6e6e73]">
                      <span>来源</span>
                      <span className="text-[#1d1d1f]">{r.campaign_name}</span>
                    </div>
                  </div>
                </div>
              )
            }

            if (r.type === 'discount' && r.discount_rate != null) {
              return (
                <div key={`reward-${r.id}`} className="bg-white rounded-[14px] shadow-[0_1px_2px_rgba(0,0,0,0.04)] overflow-hidden">
                  <div className={`${COLORS.discount} px-5 py-4`}>
                    <div className="flex items-center justify-between">
                      <div className="text-white/80 text-[12px] font-medium">折扣</div>
                      <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-white/20 text-white">
                        {badge.label}
                      </span>
                    </div>
                    <div className="mt-1 text-white text-[28px] font-bold tracking-tight">
                      {Math.round(r.discount_rate * 10)}折
                    </div>
                  </div>
                  <div className="px-5 py-4 space-y-2 text-[13px]">
                    {r.discount_periods_left != null && (
                      <div className="flex justify-between text-[#6e6e73]">
                        <span>剩余期数</span>
                        <span className="text-[#1d1d1f] font-medium tabular-nums">{r.discount_periods_left}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-[#6e6e73]">
                      <span>来源</span>
                      <span className="text-[#1d1d1f]">{r.campaign_name}</span>
                    </div>
                    {r.expires_at && (
                      <div className="flex justify-between text-[#6e6e73]">
                        <span>有效期至</span>
                        <span className="text-[#1d1d1f]">{fmtDate(r.expires_at)}</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            }

            // Fallback for unknown reward types
            return (
              <div key={`reward-${r.id}`} className="bg-white rounded-[14px] shadow-[0_1px_2px_rgba(0,0,0,0.04)] overflow-hidden">
                <div className={`${COLORS.token} px-5 py-4`}>
                  <div className="flex items-center justify-between">
                    <div className="text-white/80 text-[12px] font-medium">奖励</div>
                    <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-white/20 text-white">
                      {badge.label}
                    </span>
                  </div>
                  <div className="mt-1 text-white text-[18px] font-bold tracking-tight">
                    {r.type}
                  </div>
                </div>
                <div className="px-5 py-4 space-y-2 text-[13px]">
                  <div className="flex justify-between text-[#6e6e73]">
                    <span>来源</span>
                    <span className="text-[#1d1d1f]">{r.campaign_name}</span>
                  </div>
                  {r.expires_at && (
                    <div className="flex justify-between text-[#6e6e73]">
                      <span>有效期至</span>
                      <span className="text-[#1d1d1f]">{fmtDate(r.expires_at)}</span>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
