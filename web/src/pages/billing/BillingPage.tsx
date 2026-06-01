import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { Pill, Table } from '../../ui'
import type { Column } from '../../ui/Table'
import WaterLevelBar from '../../ui/WaterLevelBar'

/* ---------- types (mirror server BillingDTO) ---------- */

interface ActiveSubscription {
  id: string
  status: string
  plan_name: string
  plan_type: string
  plan_subtype: string | null
  starts_at: string | null
  expires_at: string | null
  balance: number
  price: number
  currency: string
}

interface SubscriptionHistoryRow {
  id: string
  status: string
  plan_name: string
  plan_type: string
  plan_subtype: string | null
  starts_at: string | null
  expires_at: string | null
  balance: number
  price: number
  currency: string
  created_at: string
}

interface PaymentRow {
  id: string
  amount: number
  out_trade_no: string
  trade_no: string | null
  status: string
  paid_at: string | null
  created_at: string
}

interface WalletShape {
  pool: {
    subscription_id: string
    plan_name: string
    balance: number
    expires_at: string | null
    starts_at?: string | null
  } | null
  quota: {
    subscription_id: string
    plan_name: string
    balance: number
  } | null
  consumption_order: 'pool_first'
}

interface DailyUsage {
  day: string
  spend_usd: number
  topup_cny: number
}

interface BillingDTO {
  activeSubscription: ActiveSubscription | null
  activeSubscriptions?: ActiveSubscription[]
  wallet: WalletShape
  dailyUsage: DailyUsage[]
  subscriptionHistory: SubscriptionHistoryRow[]
  balance: {
    current_balance: number
    total_topup: number
    total_spend: number
    currency: string
  }
  payments: PaymentRow[]
}

/* ---------- helpers ---------- */

function currencyPrefix(code: string | undefined | null): string {
  switch ((code ?? '').toUpperCase()) {
    case 'USD': return '$ '
    case 'EUR': return '€ '
    case 'GBP': return '£ '
    case 'JPY': return '¥ '
    case 'CNY':
    case 'RMB':
    case '':
      return '¥ '
    default:
      return `${code} `
  }
}

function fmtMoney(amount: number, code: string | undefined | null): string {
  return `${currencyPrefix(code)}${Number(amount ?? 0).toFixed(2)}`
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function fmtDateTime(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function planTypeLabel(type: string): string {
  if (type === 'quota') return '额度'
  if (type === 'pool') return '订阅'
  return type
}

function isQuotaType(type: string | null | undefined): boolean {
  return type === 'quota'
}

function paymentTone(status: string): 'ok' | 'warn' | 'err' | 'mute' {
  if (status === 'paid') return 'ok'
  if (status === 'pending') return 'warn'
  if (status === 'failed') return 'err'
  return 'mute'
}

function paymentLabel(status: string): string {
  if (status === 'paid') return '已支付'
  if (status === 'pending') return '待支付'
  if (status === 'failed') return '失败'
  return status || '-'
}

function subStatusLabel(status: string): string {
  if (status === 'active') return '进行中'
  if (status === 'pending') return '待支付'
  if (status === 'cancelled') return '已取消'
  if (status === 'merged') return '已合并'
  return status
}

function subStatusTone(status: string): 'ok' | 'warn' | 'mute' | 'info' {
  if (status === 'active') return 'ok'
  if (status === 'pending') return 'warn'
  if (status === 'merged') return 'info'
  return 'mute'
}

/* ---------- subcomponents ---------- */

function DailyBars({
  daily, maxDailySpend, currency,
}: {
  daily: DailyUsage[]
  maxDailySpend: number
  currency: string | null | undefined
}) {
  const [hover, setHover] = useState<number | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const hoverDay = hover !== null ? daily[hover] : null

  return (
    <div className="relative" ref={wrapRef}>
      <div
        className="flex items-end gap-[2px] h-[80px]"
        onMouseLeave={() => setHover(null)}
      >
        {daily.map((d, i) => {
          const h = maxDailySpend > 0
            ? Math.max(2, Math.round((d.spend_usd / maxDailySpend) * 76))
            : 2
          const hasTopup = d.topup_cny > 0
          const active = hover === i
          return (
            <div
              key={d.day}
              onMouseEnter={() => setHover(i)}
              className="flex-1 flex flex-col justify-end items-center gap-[2px] cursor-crosshair group"
            >
              {hasTopup && (
                <div
                  className="w-[60%] rounded-sm"
                  style={{
                    height: '4px',
                    background: active ? 'var(--ink)' : 'var(--info)',
                  }}
                />
              )}
              <div
                className={`w-full rounded-t-sm transition-colors ${
                  d.spend_usd > 0
                    ? active ? 'bg-[var(--ink)]' : 'bg-[var(--accent)]'
                    : 'bg-[var(--rule)]'
                }`}
                style={{ height: `${h}px` }}
              />
            </div>
          )
        })}
      </div>
      {hoverDay && wrapRef.current && (
        <div
          className="pointer-events-none absolute -top-2 z-10 min-w-[160px] rounded border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-2 text-[11px] shadow-[0_4px_16px_rgba(0,0,0,0.12)]"
          style={{
            left: `${((hover! + 0.5) / daily.length) * 100}%`,
            transform: `translate(${hover! / daily.length > 0.65 ? '-100%' : '0'}, -100%)`,
          }}
        >
          <div className="mb-1 text-[var(--ink-3)] font-mono tabular-nums">{hoverDay.day}</div>
          <div className="space-y-0.5 font-mono tabular-nums">
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1 text-[var(--ink-2)]">
                <span className="inline-block w-2 h-2 rounded-sm" style={{ background: 'var(--accent)' }} />
                消耗
              </span>
              <span>$ {hoverDay.spend_usd.toFixed(4)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1 text-[var(--ink-2)]">
                <span className="inline-block w-2 h-2 rounded-sm" style={{ background: 'var(--info)' }} />
                充值
              </span>
              <span>{fmtMoney(hoverDay.topup_cny, currency)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="p-5 rounded-[6px] border border-[var(--rule)] bg-[var(--surface)]">
      <h2 className="text-[14px] font-medium mb-4 text-[var(--ink)]">{title}</h2>
      {children}
    </section>
  )
}

function Metric({
  label, value, hint, emphasize,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  emphasize?: boolean
}) {
  return (
    <div>
      <div className="text-[11px] font-mono uppercase tracking-wider text-[var(--ink-3)]">{label}</div>
      <div className={`mt-1 tabular-nums ${emphasize ? 'text-[20px] font-medium text-[var(--ink)]' : 'text-[14px] text-[var(--ink-2)]'}`}>
        {value}
      </div>
      {hint && <div className="mt-1 text-[11px] text-[var(--mute)]">{hint}</div>}
    </div>
  )
}

/* ---------- page ---------- */

export default function BillingPage() {
  const [data, setData] = useState<BillingDTO | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<BillingDTO>('/me/billing')
      .then(setData)
      .catch((e: Error) => setError(e.message || 'Failed to load billing'))
  }, [])

  if (error) {
    return (
      <div className="max-w-[1280px] mx-auto space-y-6">
        <header>
          <h1 className="text-[26px] font-serif text-[var(--ink)]">账单</h1>
          <p className="text-[13px] text-[var(--mute)] mt-1">额度 · 订阅 · 充值流水</p>
        </header>
        <div className="p-6 rounded-[6px] border border-[var(--rule)] bg-[var(--surface)] text-[13px] text-[var(--err)]">
          加载失败：{error}
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="max-w-[1280px] mx-auto space-y-6">
        <header>
          <h1 className="text-[26px] font-serif text-[var(--ink)]">账单</h1>
          <p className="text-[13px] text-[var(--mute)] mt-1">额度 · 订阅 · 充值流水</p>
        </header>
        <div className="text-[13px] text-[var(--mute)]">加载中…</div>
      </div>
    )
  }

  const actives = data.activeSubscriptions ?? (data.activeSubscription ? [data.activeSubscription] : [])
  const { balance } = data
  const daily = data.dailyUsage ?? []

  // 30 天聚合
  const totalSpend30d = daily.reduce((s, d) => s + (d.spend_usd ?? 0), 0)
  const totalTopup30d = daily.reduce((s, d) => s + (d.topup_cny ?? 0), 0)
  const avgDailySpend = totalSpend30d / 30
  const maxDailySpend = daily.reduce((m, d) => Math.max(m, d.spend_usd ?? 0), 0)

  const paymentColumns: Column<PaymentRow>[] = [
    {
      key: 'created_at',
      header: '时间',
      render: (r) => (
        <span className="tabular-nums whitespace-nowrap text-[var(--ink-2)]">
          {fmtDateTime(r.paid_at ?? r.created_at)}
        </span>
      ),
    },
    {
      key: 'out_trade_no',
      header: '订单号',
      render: (r) => (
        <span className="font-mono text-[11px] text-[var(--ink-2)]">{r.out_trade_no || '-'}</span>
      ),
    },
    {
      key: 'amount',
      header: '金额',
      className: 'text-right',
      render: (r) => (
        <span className={`tabular-nums font-medium ${r.amount > 0 && r.status === 'paid' ? 'text-[var(--ok)]' : 'text-[var(--ink)]'}`}>
          {fmtMoney(r.amount, balance.currency)}
        </span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      className: 'text-center',
      render: (r) => <Pill tone={paymentTone(r.status)}>{paymentLabel(r.status)}</Pill>,
    },
    {
      key: 'trade_no',
      header: '交易号',
      render: (r) => (
        <span className="font-mono text-[11px] text-[var(--ink-3)]">{r.trade_no || '-'}</span>
      ),
    },
  ]

  return (
    <div className="max-w-[1280px] mx-auto space-y-8">
      {/* Header */}
      <header>
        <h1 className="text-[26px] font-serif text-[var(--ink)]">账单</h1>
        <p className="text-[13px] text-[var(--mute)] mt-1">额度 · 订阅 · 充值流水</p>
      </header>

      {/* 双水位 */}
      <WaterLevelBar wallet={data.wallet} />

      {/* 最近 30 天 */}
      <SectionCard title="最近 30 天">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Metric
            label="30 天消耗"
            value={`$ ${totalSpend30d.toFixed(2)}`}
            emphasize
            hint="按 USD 记账（基于模型调用成本）"
          />
          <Metric
            label="30 天充值"
            value={`¥ ${totalTopup30d.toFixed(2)}`}
            hint="已支付订单金额合计"
          />
          <Metric
            label="日均消耗"
            value={`$ ${avgDailySpend.toFixed(2)}`}
            hint="30 天总消耗 ÷ 30"
          />
        </div>
        {daily.length === 0 ? (
          <div className="mt-6 text-[12px] text-[var(--mute)]">暂无消费记录。</div>
        ) : (
          <div className="mt-6">
            <DailyBars daily={daily} maxDailySpend={maxDailySpend} currency={balance.currency} />
            <div className="mt-2 flex justify-between text-[10px] font-mono text-[var(--ink-3)]">
              <span>{daily[0]?.day}</span>
              <span>{daily[daily.length - 1]?.day}</span>
            </div>
            <div className="mt-2 flex items-center gap-4 text-[11px] text-[var(--mute)]">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-sm bg-[var(--accent)]" /> 每日消耗 (USD)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-sm bg-[var(--info)]" /> 当日充值
              </span>
            </div>
          </div>
        )}
      </SectionCard>

      {/* 历史时间线 — 额度发放 + 订阅记录混排 */}
      <section>
        <h2 className="text-[14px] font-medium mb-4 text-[var(--ink)]">账户记录</h2>
        {data.subscriptionHistory.length === 0 ? (
          <div className="text-[13px] text-[var(--mute)]">暂无记录。</div>
        ) : (
          <ul className="relative border-l border-[var(--rule)] pl-5 space-y-5">
            {data.subscriptionHistory.map((s, idx) => {
              const isCurrent = actives.some((a) => a.id === s.id)
              const isQuota = isQuotaType(s.plan_type)
              const isMerged = s.status === 'merged'
              const isFirst = idx === data.subscriptionHistory.length - 1
              return (
                <li key={s.id} className="relative">
                  <span
                    className="absolute -left-[27px] top-[5px] w-[11px] h-[11px] rounded-full border-2 border-[var(--surface)]"
                    style={{
                      background: isCurrent
                        ? 'var(--accent)'
                        : isMerged
                        ? 'var(--info)'
                        : 'var(--ink-3)',
                    }}
                  />
                  <div className="flex flex-wrap items-center gap-2 text-[13px]">
                    <span className="font-medium text-[var(--ink)]">{s.plan_name}</span>
                    <Pill tone={isQuota ? 'info' : 'accent'}>{planTypeLabel(s.plan_type)}</Pill>
                    <Pill tone={subStatusTone(s.status)}>{subStatusLabel(s.status)}</Pill>
                    {isCurrent && <Pill tone="ok">当前</Pill>}
                    {isFirst && !isMerged && (
                      <span className="text-[11px] text-[var(--mute)]">
                        {isQuota ? '首次发放' : '首次订阅'}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[12px] text-[var(--ink-3)] tabular-nums">
                    {fmtDate(s.starts_at ?? s.created_at)}
                    {!isMerged && (isQuota
                      ? (s.expires_at ? ` · 失效 ${fmtDate(s.expires_at)}` : '')
                      : ` → ${s.expires_at ? fmtDate(s.expires_at) : '无到期'}`)}
                    <span className="mx-2 text-[var(--rule)]">|</span>
                    <span>金额 {fmtMoney(s.price, s.currency)}</span>
                    {isMerged ? (
                      <>
                        <span className="mx-2 text-[var(--rule)]">|</span>
                        <span className="text-[var(--info)]">
                          {fmtMoney(s.price, s.currency)} 已并入当前额度
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="mx-2 text-[var(--rule)]">|</span>
                        <span>{isQuota ? '余额' : '订阅余额'} {fmtMoney(s.balance ?? 0, s.currency)}</span>
                      </>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* 充值流水 */}
      <section>
        <h2 className="text-[14px] font-medium mb-4 text-[var(--ink)]">充值流水</h2>
        <div className="rounded-[6px] border border-[var(--rule)] bg-[var(--surface)] overflow-hidden">
          <Table
            rows={data.payments}
            columns={paymentColumns}
            emptyLabel="暂无充值记录。"
          />
        </div>
      </section>
    </div>
  )
}
