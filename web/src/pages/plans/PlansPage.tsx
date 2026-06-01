import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api/client'
import WaterLevelBar from '../../ui/WaterLevelBar'

/* ---------- types ---------- */

interface Plan {
  id: string
  name: string
  type: string
  subtype: string | null
  price: string
  quota_amount: string | null
  duration_days: number | null
  description: string | null
  features: string[] | null
  max_concurrent: number | null
  limit_5h_usd: string | number | null
  limit_1d_usd: string | number | null
  limit_7d_usd: string | number | null
  limit_30d_usd: string | number | null
  recommended?: boolean
}

interface Subscription {
  id: string
  plan_name: string
  plan_type: string
  subtype: string | null
  status: string
  balance: string
  expires_at: string | null
  remaining_uses: number | null
  price: string
  quota_amount: string | null
  features: string[] | null
}

/* ---------- constants ---------- */

const SUBTYPE_LABELS: Record<string, string> = { monthly: '月卡', daily: '日卡', per_use: '次卡' }
const SUBTYPE_PERIOD: Record<string, string> = { monthly: '/月', daily: '/天', per_use: '/次' }

const CAP_FIELDS: Array<{ key: keyof Plan; label: string; cadence: string }> = [
  { key: 'limit_5h_usd',  label: '5 小时',  cadence: '每 5 小时滚动' },
  { key: 'limit_1d_usd',  label: '24 小时', cadence: '每 24 小时滚动' },
  { key: 'limit_7d_usd',  label: '7 天',    cadence: '每 7 天滚动' },
  { key: 'limit_30d_usd', label: '30 天',   cadence: '每 30 天滚动' },
]

/* ---------- helpers ---------- */

function toNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

/* ---------- primitives ---------- */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-[0.14em] font-mono text-[var(--ink-3)]">
      {children}
    </div>
  )
}

function Tag({ tone, children }: { tone: 'ok' | 'mute' | 'warn' | 'err' | 'accent'; children: React.ReactNode }) {
  const color = {
    ok:     'var(--ok)',
    mute:   'var(--ink-3)',
    warn:   'var(--warn)',
    err:    'var(--err)',
    accent: 'var(--accent)',
  }[tone]
  return (
    <span
      className="inline-flex items-center px-1.5 py-[1px] text-[10px] font-mono uppercase tracking-[0.08em] border rounded-sm"
      style={{ color, borderColor: color }}
    >
      {children}
    </span>
  )
}

/* ---------- pending orders ---------- */

interface PendingOrder {
  out_trade_no: string
  amount: string
  subscription_id: string
  plan_id: string
  plan_name: string
  plan_type: 'pool' | 'quota'
  subtype: string | null
  currency: string
  created_at: string
}

function PendingOrderBanner() {
  const [orders, setOrders] = useState<PendingOrder[]>([])
  const navigate = useNavigate()
  useEffect(() => {
    api<{ pending: PendingOrder[] }>('/subscription/pending')
      .then(d => setOrders(d.pending ?? []))
      .catch(() => setOrders([]))
  }, [])
  if (orders.length === 0) return null
  return (
    <div className="border border-[var(--warn)] bg-[var(--surface)] rounded px-4 py-3 flex items-center gap-3 flex-wrap">
      <Tag tone="warn">待支付</Tag>
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-[var(--ink)]">
          你有 <span className="font-mono tabular-nums">{orders.length}</span> 个待支付订单
        </div>
        <div className="text-[11px] font-mono text-[var(--ink-3)] mt-0.5 truncate">
          {orders.slice(0, 3).map(o => `${o.plan_name} ¥${Number(o.amount).toFixed(2)}`).join(' · ')}
          {orders.length > 3 && ' …'}
        </div>
      </div>
      <button
        onClick={() => {
          const o = orders[0]
          navigate(`/checkout/${o.plan_id}?resume=${o.out_trade_no}`)
        }}
        className="px-3 py-1.5 text-[12px] font-mono uppercase tracking-[0.08em] border border-[var(--warn)] text-[var(--warn)] hover:bg-[var(--rule-2)] rounded-sm whitespace-nowrap"
      >
        继续支付 →
      </button>
    </div>
  )
}

/* ---------- plan cards ---------- */

function QuotaCard({ plan, recommended, onBuy }: { plan: Plan; recommended: boolean; onBuy: () => void }) {
  return (
    <div
      className={`border bg-[var(--surface)] rounded p-5 flex flex-col min-w-[200px] flex-shrink-0 ${
        recommended ? 'border-[var(--accent)]' : 'border-[var(--rule)]'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <SectionLabel>quota · 按量</SectionLabel>
          {recommended && <Tag tone="accent">推荐</Tag>}
        </div>
      </div>
      <div className="mt-2 font-serif text-[22px] text-[var(--ink)]">{plan.name}</div>

      <div className="mt-4 flex items-baseline gap-1">
        <span className="text-[12px] font-mono text-[var(--ink-3)]">¥</span>
        <span className="font-serif text-[36px] text-[var(--ink)] tabular-nums leading-none">
          {parseFloat(plan.price).toFixed(0)}
        </span>
      </div>

      {plan.quota_amount && parseFloat(plan.quota_amount) > 0 && (
        <div className="mt-3 flex items-baseline justify-between pt-3 border-t border-[var(--rule)]">
          <span className="text-[11px] text-[var(--ink-3)] font-mono">可用额度</span>
          <span className="text-[13px] font-mono tabular-nums text-[var(--ink)]">
            ${parseFloat(plan.quota_amount).toFixed(2)}
          </span>
        </div>
      )}

      {plan.description && (
        <p className="mt-3 text-[12px] text-[var(--ink-2)] leading-relaxed">{plan.description}</p>
      )}

      <div className="flex-1" />

      <button
        onClick={onBuy}
        className={`mt-4 w-full py-2 text-[12px] font-mono uppercase tracking-[0.08em] rounded-sm border ${
          recommended
            ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--surface)] hover:opacity-90'
            : 'border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent-weak)]'
        }`}
      >
        购买 →
      </button>
    </div>
  )
}

function PoolCard({ plan, recommended, onBuy }: { plan: Plan; recommended: boolean; onBuy: () => void }) {
  const caps = CAP_FIELDS
    .map((f) => ({ label: f.label, cadence: f.cadence, value: toNum(plan[f.key] as any) }))
    .filter((c) => c.value !== null && c.value > 0)

  return (
    <div
      className={`border bg-[var(--surface)] rounded p-5 flex flex-col ${
        recommended ? 'border-[var(--accent)]' : 'border-[var(--rule)]'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <SectionLabel>pool · 订阅</SectionLabel>
          {recommended && <Tag tone="accent">推荐</Tag>}
        </div>
        {plan.subtype && <Tag tone="mute">{SUBTYPE_LABELS[plan.subtype] ?? plan.subtype}</Tag>}
      </div>

      <div className="mt-2 font-serif text-[22px] text-[var(--ink)]">{plan.name}</div>

      <div className="mt-4 flex items-baseline gap-1">
        <span className="text-[12px] font-mono text-[var(--ink-3)]">¥</span>
        <span className="font-serif text-[36px] text-[var(--ink)] tabular-nums leading-none">
          {parseFloat(plan.price).toFixed(0)}
        </span>
        <span className="text-[12px] font-mono text-[var(--ink-3)]">
          {SUBTYPE_PERIOD[plan.subtype ?? ''] ?? ''}
        </span>
      </div>

      {plan.description && (
        <p className="mt-3 text-[12px] text-[var(--ink-2)] leading-relaxed">{plan.description}</p>
      )}

      {/* 4-cap usage ceilings */}
      {caps.length > 0 ? (
        <div className="mt-4 pt-3 border-t border-[var(--rule)] space-y-1">
          <div className="text-[10px] uppercase tracking-[0.12em] font-mono text-[var(--ink-3)] mb-1.5">
            用量上限
          </div>
          {caps.map((c) => (
            <div key={c.label} className="text-[11px]">
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[var(--ink-3)]">{c.label}</span>
                <span className="font-mono tabular-nums text-[var(--ink)]">${c.value!.toFixed(2)}</span>
              </div>
              <div className="text-[10px] font-mono text-[var(--ink-3)] mt-0.5">{c.cadence}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-4 pt-3 border-t border-[var(--rule)] text-[11px] font-mono text-[var(--ink-3)]">
          未设置用量上限
        </div>
      )}

      {/* Features */}
      {plan.features && plan.features.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {plan.features.map((f, i) => (
            <span
              key={i}
              className="px-1.5 py-[1px] border border-[var(--rule)] text-[10px] font-mono text-[var(--ink-2)] rounded-sm"
            >
              {f}
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-[var(--rule)] flex items-baseline justify-between text-[11px]">
        <span className="font-mono text-[var(--ink-3)]">有效期</span>
        <span className="font-mono tabular-nums text-[var(--ink)]">
          {plan.duration_days != null && plan.duration_days > 0 ? `${plan.duration_days} 天` : '永久'}
        </span>
      </div>
      {plan.max_concurrent != null && plan.max_concurrent > 1 && (
        <div className="flex items-baseline justify-between text-[11px]">
          <span className="font-mono text-[var(--ink-3)]">并发数</span>
          <span className="font-mono tabular-nums text-[var(--ink)]">{plan.max_concurrent}</span>
        </div>
      )}

      <div className="flex-1" />

      <button
        onClick={onBuy}
        className={`mt-4 w-full py-2 text-[12px] font-mono uppercase tracking-[0.08em] rounded-sm border ${
          recommended
            ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--surface)] hover:opacity-90'
            : 'border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent-weak)]'
        }`}
      >
        立即购买 →
      </button>
    </div>
  )
}

/* ---------- main ---------- */

interface WalletShape {
  pool: {
    subscription_id: string
    plan_name: string
    balance: number
    expires_at: string | null
    starts_at?: string | null
    usable?: boolean
    caps?: Record<'5h' | '1d' | '7d' | '30d', { limit: number; used: number; windowStart?: string | null } | null>
  } | null
  quota: { subscription_id: string; plan_name: string; balance: number } | null
  consumption_order: 'pool_first'
}

const EMPTY_WALLET: WalletShape = { pool: null, quota: null, consumption_order: 'pool_first' }

export default function PlansPage() {
  const [plans, setPlans] = useState<Plan[]>([])
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [wallet, setWallet] = useState<WalletShape>(EMPTY_WALLET)
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    Promise.all([
      api<Plan[]>('/plans').catch(() => []),
      api<Subscription[] | Subscription | null>('/subscription').catch(() => []),
      api<{ wallet?: WalletShape }>('/me/dashboard?window=7d').catch(() => ({ wallet: EMPTY_WALLET })),
    ]).then(([p, s, d]) => {
      setPlans(Array.isArray(p) ? p : [])
      if (Array.isArray(s)) setSubscriptions(s)
      else if (s) setSubscriptions([s])
      else setSubscriptions([])
      setWallet(d?.wallet ?? EMPTY_WALLET)
    }).finally(() => setLoading(false))
  }, [])

  const handleRecharge = (sub: Subscription) => {
    const matchedPlan = plans.find(p => p.name === sub.plan_name && p.type === sub.plan_type)
    if (matchedPlan) navigate(`/checkout/${matchedPlan.id}`)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-[13px] font-mono text-[var(--ink-3)]">loading …</div>
      </div>
    )
  }

  const quotaPlans = plans.filter(p => p.type === 'quota')
  const poolPlans = plans.filter(p => p.type === 'pool')
  // 管理员在套餐表里勾选 recommended=true 才会展示「推荐」标签；无勾选则没有推荐。
  // quota / pool 各取第一个勾选，互不影响。
  const recommendedPoolId = poolPlans.find(p => p.recommended)?.id
  const recommendedQuotaId = quotaPlans.find(p => p.recommended)?.id

  return (
    <div className="max-w-[1280px] mx-auto space-y-8">
      {/* Header */}
      <header>
        <h1 className="text-[26px] font-serif text-[var(--ink)]">套餐方案</h1>
        <p className="text-[13px] text-[var(--ink-3)] mt-1">选择适合的套餐, 立即开始使用</p>
      </header>

      {/* Pending orders */}
      <PendingOrderBanner />

      {/* Current wallet */}
      <WaterLevelBar
        wallet={wallet}
        onRecharge={() => {
          const quotaSub = subscriptions.find(s => s.plan_type === 'quota' && s.status === 'active')
          if (quotaSub) {
            handleRecharge(quotaSub)
            return
          }
          const el = document.getElementById('quota-plans')
          el?.scrollIntoView({ behavior: 'smooth' })
        }}
        onSubscribe={() => {
          const poolSub = subscriptions.find(s => s.plan_type === 'pool' && s.status === 'active')
          if (poolSub) {
            handleRecharge(poolSub)
            return
          }
          const el = document.getElementById('pool-plans')
          el?.scrollIntoView({ behavior: 'smooth' })
        }}
      />

      {/* Pool plans */}
      {poolPlans.length > 0 && (
        <section id="pool-plans" className="space-y-4">
          <div className="flex items-baseline justify-between border-b border-[var(--rule)] pb-2">
            <div>
              <SectionLabel>订阅</SectionLabel>
              <h2 className="text-[18px] font-serif text-[var(--ink)] mt-0.5">共享账号 · 4 窗口额度</h2>
            </div>
            <span className="text-[11px] font-mono text-[var(--ink-3)]">
              {poolPlans.length} 个套餐
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {poolPlans.map((plan) => (
              <PoolCard
                key={plan.id}
                plan={plan}
                recommended={plan.id === recommendedPoolId}
                onBuy={() => navigate(`/checkout/${plan.id}`)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Quota plans */}
      {quotaPlans.length > 0 && (
        <section id="quota-plans" className="space-y-4">
          <div className="flex items-baseline justify-between border-b border-[var(--rule)] pb-2">
            <div>
              <SectionLabel>按量</SectionLabel>
              <h2 className="text-[18px] font-serif text-[var(--ink)] mt-0.5">充额度 · 按使用扣费</h2>
            </div>
            <span className="text-[11px] font-mono text-[var(--ink-3)]">
              {quotaPlans.length} 个套餐
            </span>
          </div>
          <div className="flex gap-4 overflow-x-auto pb-2">
            {quotaPlans.map((plan) => (
              <QuotaCard
                key={plan.id}
                plan={plan}
                recommended={plan.id === recommendedQuotaId}
                onBuy={() => navigate(`/checkout/${plan.id}`)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Empty state */}
      {plans.length === 0 && (
        <div className="border border-[var(--rule)] bg-[var(--surface)] rounded p-16 text-center">
          <div className="text-[13px] font-mono text-[var(--ink-3)]">暂无可用套餐</div>
        </div>
      )}
    </div>
  )
}
