import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../../api/client'
import { dialog } from '../../ui'

/* ---------- types (mirror server Decision) ---------- */

type DecisionKind =
  | 'new_pool'
  | 'renew_pool'
  | 'upgrade_pool'
  | 'downgrade_pool'
  | 'new_quota'
  | 'merge_quota'

interface DecisionDetail {
  label: string
  value: string
}

interface Decision {
  kind: DecisionKind
  plan: { id: string; name: string; type: 'pool' | 'quota'; currency: string; price: number }
  charge_cny: number
  add_usd: number
  new_expires_at: string | null
  rate: number
  summary: string
  details: DecisionDetail[]
  bonus_days?: number
  refund_cny?: number
  refund_usd?: number
}

interface Plan {
  id: string
  name: string
  type: 'pool' | 'quota'
  subtype: string | null
  price: string
  currency: string
  quota_amount: string | null
  duration_days: number | null
  description: string | null
  features: string[] | null
  max_concurrent: number | null
}

/* ---------- constants ---------- */

const CARD =
  'rounded-[14px] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]'

const KIND_LABELS: Record<DecisionKind, { text: string; tone: string }> = {
  new_pool: { text: '新开订阅', tone: 'bg-[#007aff]/10 text-[#007aff]' },
  renew_pool: { text: '续期', tone: 'bg-[#34c759]/10 text-[#34c759]' },
  upgrade_pool: { text: '升级 / 切换', tone: 'bg-[#af52de]/10 text-[#af52de]' },
  downgrade_pool: { text: '降级', tone: 'bg-[#ff9500]/10 text-[#ff9500]' },
  new_quota: { text: '新开额度', tone: 'bg-[#007aff]/10 text-[#007aff]' },
  merge_quota: { text: '追加额度', tone: 'bg-[#34c759]/10 text-[#34c759]' },
}

const TYPE_LABELS: Record<'pool' | 'quota', string> = {
  pool: '订阅',
  quota: '按量',
}

/* ---------- helpers ---------- */

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return '0.00'
  return n.toFixed(2)
}

function priceWithSymbol(currency: string, price: number): string {
  const prefix = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : ''
  return `${prefix}${fmtMoney(price)}`
}

function formatExpires(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('zh-CN')
}

/* ---------- page ---------- */

export default function CheckoutPage() {
  const { planId } = useParams<{ planId: string }>()
  const [search] = useSearchParams()
  const resume = search.get('resume') || undefined
  const navigate = useNavigate()

  const [decision, setDecision] = useState<Decision | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [paying, setPaying] = useState<string | null>(null)

  useEffect(() => {
    if (!planId) {
      setError('缺少套餐标识')
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      api<Decision>('/subscription/preview', {
        method: 'POST',
        body: JSON.stringify({ plan_id: planId }),
      }),
      api<Plan[]>('/plans'),
    ])
      .then(([dec, plans]) => {
        if (cancelled) return
        setDecision(dec)
        const found = plans.find((p) => p.id === planId) || null
        setPlan(found)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : '加载失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [planId])

  const approxUsd = useMemo(() => {
    if (!decision) return null
    if (!decision.rate || decision.rate <= 0) return null
    return decision.charge_cny / decision.rate
  }, [decision])

  async function handlePay(payType: 'alipay' | 'wxpay') {
    if (!planId || paying) return
    setPaying(payType)
    try {
      const data = await api<{ pay_url: string }>('/subscription/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          plan_id: planId,
          pay_type: payType,
          ...(resume ? { out_trade_no: resume } : {}),
        }),
      })
      if (data?.pay_url) {
        window.location.href = data.pay_url
      } else {
        throw new Error('支付网关未返回跳转链接')
      }
    } catch (e: unknown) {
      setPaying(null)
      const msg = e instanceof Error ? e.message : '操作失败'
      await dialog.alert(msg)
    }
  }

  /* ---------- loading ---------- */

  if (loading) {
    return (
      <div className="mx-auto max-w-[960px] px-4 py-10 text-[#1d1d1f]">
        <div className={`${CARD} p-8 text-center text-[#86868b]`}>正在加载订单信息…</div>
      </div>
    )
  }

  /* ---------- error ---------- */

  if (error || !decision) {
    return (
      <div className="mx-auto max-w-[960px] px-4 py-10 text-[#1d1d1f]">
        <div className={`${CARD} p-8 text-center`}>
          <div className="mb-2 text-[17px] font-semibold text-[#ff3b30]">
            无法准备该订单
          </div>
          <div className="mb-6 text-[14px] text-[#6e6e73]">
            {error || '预览数据为空'}
          </div>
          <button
            onClick={() => navigate('/plans')}
            className="inline-flex items-center justify-center rounded-full bg-[#007aff] px-6 py-2 text-[14px] font-medium text-white hover:bg-[#0062cc]"
          >
            返回套餐
          </button>
        </div>
      </div>
    )
  }

  const kindMeta = KIND_LABELS[decision.kind]
  const currency = plan?.currency || decision.plan.currency || 'CNY'
  const displayName = plan?.name || decision.plan.name
  const displayPriceNum =
    plan?.price != null ? Number(plan.price) : decision.plan.price
  const isUpDown =
    decision.kind === 'upgrade_pool' || decision.kind === 'downgrade_pool'
  const isDowngrade = decision.kind === 'downgrade_pool'

  /* ---------- render ---------- */

  return (
    <div className="mx-auto max-w-[960px] px-4 py-8 text-[#1d1d1f]">
      {/* 顶部条 */}
      <div className="mb-6 flex items-center gap-3">
        <button
          onClick={() => navigate('/plans')}
          className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[13px] text-[#6e6e73] hover:bg-[#f5f5f7] hover:text-[#1d1d1f]"
        >
          <span aria-hidden>←</span>
          <span>返回套餐</span>
        </button>
        <span className="text-[13px] text-[#8e8e93]">/</span>
        <h1 className="text-[15px] font-medium text-[#1d1d1f]">确认订单</h1>
      </div>

      {/* 区块 A 订单概要 */}
      <section className={`${CARD} mb-4 p-6`}>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2">
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-medium ${kindMeta.tone}`}
              >
                {kindMeta.text}
              </span>
              <span className="inline-flex items-center rounded-full bg-[#f5f5f7] px-2.5 py-0.5 text-[12px] text-[#6e6e73]">
                {TYPE_LABELS[decision.plan.type]}
              </span>
            </div>
            <div className="truncate text-[20px] font-semibold text-[#1d1d1f]">
              {displayName}
            </div>
            {plan?.description && (
              <div className="mt-1 text-[13px] text-[#86868b]">
                {plan.description}
              </div>
            )}
          </div>
          <div className="flex flex-col items-start md:items-end">
            <div className="text-[32px] font-bold leading-none text-[#1d1d1f]">
              {priceWithSymbol(currency, displayPriceNum)}
            </div>
            <div className="mt-2 text-[12px] text-[#8e8e93]">
              应付 ¥{fmtMoney(decision.charge_cny)}
              {approxUsd !== null && (
                <>
                  {' · '}≈ ${fmtMoney(approxUsd)}（汇率 1 USD = ¥
                  {fmtMoney(decision.rate)}）
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 区块 B 本次操作 */}
      <section className={`${CARD} mb-4 p-6`}>
        <div className="mb-4 text-[13px] font-medium uppercase tracking-wide text-[#8e8e93]">
          本次操作
        </div>
        <p className="mb-5 text-[16px] leading-relaxed text-[#1d1d1f]">
          {decision.summary}
        </p>
        {decision.details && decision.details.length > 0 && (
          <dl className="overflow-hidden rounded-[10px] border border-[#f5f5f7]">
            {decision.details.map((d, i) => (
              <div
                key={`${d.label}-${i}`}
                className={`flex items-start justify-between gap-4 px-4 py-2.5 text-[14px] ${
                  i % 2 === 1 ? 'bg-[#fafafa]' : 'bg-white'
                }`}
              >
                <dt className="text-[#6e6e73]">{d.label}</dt>
                <dd className="text-right font-medium text-[#1d1d1f]">
                  {d.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <MiniStat
            label="应付金额"
            value={`¥${fmtMoney(decision.charge_cny)}`}
          />
          <MiniStat
            label="到账余额"
            value={`+$${fmtMoney(decision.add_usd)}`}
            tone="#34c759"
          />
          <MiniStat
            label="有效期至"
            value={formatExpires(decision.new_expires_at)}
          />
        </div>
      </section>

      {/* 区块 C 方案对比 (仅升降级) */}
      {isUpDown && (
        <section className={`${CARD} mb-4 p-6`}>
          <div className="mb-4 text-[13px] font-medium uppercase tracking-wide text-[#8e8e93]">
            方案对比
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {/* 左：只续期 */}
            <div className="rounded-[12px] border border-[#e5e5ea] bg-[#fafafa] p-5">
              <div className="mb-1 text-[12px] font-medium text-[#8e8e93]">
                如果只续期
              </div>
              <div className="mb-2 text-[15px] font-semibold text-[#1d1d1f]">
                沿用原套餐
              </div>
              <div className="text-[13px] leading-relaxed text-[#6e6e73]">
                价格与原套餐一致 · 余额按原价率累计，不触发折算。
              </div>
            </div>

            {/* 右：升级或降级 */}
            <div
              className={
                isDowngrade
                  ? 'rounded-[12px] border border-[#ff9500]/40 bg-[#ff9500]/5 p-5'
                  : 'rounded-[12px] border border-[#af52de]/40 bg-[#af52de]/5 p-5'
              }
            >
              <div
                className={`mb-1 text-[12px] font-medium ${
                  isDowngrade ? 'text-[#ff9500]' : 'text-[#af52de]'
                }`}
              >
                {isDowngrade ? '降级到' : '升级 / 切换到'}
              </div>
              <div className="mb-2 truncate text-[15px] font-semibold text-[#1d1d1f]">
                {displayName}
              </div>
              {isDowngrade ? (
                <div className="space-y-1 text-[13px] leading-relaxed text-[#1d1d1f]">
                  {typeof decision.bonus_days === 'number' &&
                    decision.bonus_days > 0 && (
                      <div>
                        折赠天数：
                        <span className="font-semibold text-[#ff9500]">
                          +{decision.bonus_days} 天
                        </span>
                      </div>
                    )}
                  {typeof decision.refund_usd === 'number' &&
                    decision.refund_usd > 0 && (
                      <div>
                        余额折算：
                        <span className="font-semibold text-[#ff9500]">
                          ${fmtMoney(decision.refund_usd)}
                        </span>
                      </div>
                    )}
                  {typeof decision.refund_cny === 'number' &&
                    decision.refund_cny > 0 && (
                      <div>
                        等值返还：
                        <span className="font-semibold text-[#ff9500]">
                          ¥{fmtMoney(decision.refund_cny)}
                        </span>
                      </div>
                    )}
                  <div className="pt-1 text-[#6e6e73]">
                    降级不退现金，按新价折算为额外使用天数。
                  </div>
                </div>
              ) : (
                <div className="space-y-1 text-[13px] leading-relaxed text-[#1d1d1f]">
                  <div>
                    本次补差：
                    <span className="font-semibold text-[#af52de]">
                      ¥{fmtMoney(decision.charge_cny)}
                    </span>
                  </div>
                  <div>
                    到账余额：
                    <span className="font-semibold text-[#af52de]">
                      +${fmtMoney(decision.add_usd)}
                    </span>
                  </div>
                  <div className="pt-1 text-[#6e6e73]">
                    立即切换到新套餐，原余额按规则结转。
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* 区块 D 支付方式 */}
      <section className={`${CARD} p-6`}>
        <div className="mb-4 text-[13px] font-medium uppercase tracking-wide text-[#8e8e93]">
          选择支付方式
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <PayButton
            kind="alipay"
            disabled={!!paying}
            loading={paying === 'alipay'}
            onClick={() => handlePay('alipay')}
          />
          <PayButton
            kind="wxpay"
            disabled={!!paying}
            loading={paying === 'wxpay'}
            onClick={() => handlePay('wxpay')}
          />
        </div>
        <div className="mt-4 text-[12px] leading-relaxed text-[#8e8e93]">
          提交订单即表示同意按所选套餐计费。支付完成后将自动返回网关，余额通常在数秒内到账。
        </div>
      </section>
    </div>
  )
}

/* ---------- sub components ---------- */

function MiniStat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: string
}) {
  return (
    <div className="rounded-[10px] bg-[#fafafa] px-4 py-3">
      <div className="text-[12px] text-[#8e8e93]">{label}</div>
      <div
        className="mt-1 text-[15px] font-semibold"
        style={{ color: tone || '#1d1d1f' }}
      >
        {value}
      </div>
    </div>
  )
}

function PayButton({
  kind,
  disabled,
  loading,
  onClick,
}: {
  kind: 'alipay' | 'wxpay'
  disabled: boolean
  loading: boolean
  onClick: () => void
}) {
  const isAlipay = kind === 'alipay'
  const brand = isAlipay ? '#1677FF' : '#07C160'
  const letter = isAlipay ? 'A' : 'W'
  const title = isAlipay ? '支付宝' : '微信支付'
  const subtitle = isAlipay
    ? '推荐使用支付宝 App 或网页支付'
    : '使用微信扫码或 H5 支付'

  const hoverBorder = isAlipay
    ? 'hover:border-[#007aff]'
    : 'hover:border-[#34c759]'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`group flex items-center gap-4 rounded-[12px] border border-[#e5e5ea] bg-white px-5 py-4 text-left transition ${hoverBorder} hover:shadow-[0_2px_6px_rgba(0,0,0,0.06)] disabled:cursor-not-allowed disabled:opacity-60`}
    >
      <div
        className="flex h-11 w-11 flex-none items-center justify-center rounded-[10px] text-[20px] font-bold text-white"
        style={{ backgroundColor: brand }}
      >
        {letter}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold text-[#1d1d1f]">
          {loading ? '正在跳转支付…' : title}
        </div>
        <div className="mt-0.5 truncate text-[12px] text-[#8e8e93]">
          {loading ? '请稍候，不要关闭页面' : subtitle}
        </div>
      </div>
      <div
        className="flex-none text-[18px] text-[#c7c7cc] transition group-hover:text-[#1d1d1f]"
        aria-hidden
      >
        →
      </div>
    </button>
  )
}
