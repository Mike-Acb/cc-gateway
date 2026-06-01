import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../../api/client'

/* ---------- types ---------- */

interface Order {
  payment_id: string
  out_trade_no: string
  trade_no: string | null
  amount: string
  payment_status: 'pending' | 'paid' | 'failed'
  paid_at: string | null
  ordered_at: string
  subscription_id: string | null
  subscription_status: string | null
  balance: string | null
  expires_at: string | null
  starts_at: string | null
  plan_id: string | null
  plan_name: string | null
  plan_type: 'pool' | 'quota' | null
  subtype: string | null
  currency: string
  quota_amount: string | null
  duration_days: number | null
}

interface ActivateResponse {
  ok: boolean
  order: Order | null
}

type Phase = 'loading' | 'success' | 'failed' | 'pending' | 'not_found'

/* ---------- constants ---------- */

const CARD = 'bg-white rounded-[14px] shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
const MAX_POLLS = 3
const POLL_INTERVAL_SEC = 4

const SUBTYPE_LABEL: Record<string, string> = {
  monthly: '月卡',
  daily: '日卡',
  per_use: '次卡',
}

/* ---------- helpers ---------- */

function fmtMoney(amount: string | number | null, currency = 'CNY') {
  const n = Number(amount ?? 0)
  const prefix = currency === 'USD' ? '$ ' : '¥ '
  return `${prefix}${n.toFixed(2)}`
}

function fmtDate(s: string | null) {
  if (!s) return '—'
  return new Date(s).toLocaleString('zh-CN')
}

function fmtExpires(s: string | null) {
  if (!s) return '不过期'
  return new Date(s).toLocaleDateString('zh-CN')
}

function tradeStatusReason(tradeStatus: string | null): string {
  if (!tradeStatus) return '交易未成功'
  if (tradeStatus === 'TRADE_CLOSED') return '订单已关闭'
  if (tradeStatus === 'WAIT_BUYER_PAY') return '尚未完成支付'
  return `交易未成功 (trade_status: ${tradeStatus})`
}

/* ---------- sub-components ---------- */

function Spinner() {
  return (
    <div className="w-12 h-12 border-4 border-[#f5f5f7] border-t-[#007aff] rounded-full animate-spin" />
  )
}

function SuccessIcon() {
  return (
    <div className="w-16 h-16 rounded-full bg-[#34c759] flex items-center justify-center">
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path
          d="M8 16.5 L14 22 L24 11"
          stroke="#ffffff"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}

function FailIcon() {
  return (
    <div className="w-16 h-16 rounded-full bg-[#ff3b30] flex items-center justify-center">
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path
          d="M10 10 L22 22 M22 10 L10 22"
          stroke="#ffffff"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
    </div>
  )
}

function WarnIcon() {
  return (
    <div className="w-16 h-16 rounded-full bg-[#ff9500] flex items-center justify-center">
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path
          d="M16 9 L16 18"
          stroke="#ffffff"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <circle cx="16" cy="23" r="1.8" fill="#ffffff" />
      </svg>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5">
      <dt className="text-[13px] text-[#6e6e73] flex-shrink-0">{label}</dt>
      <dd className="text-[13px] text-[#1d1d1f] text-right break-all">{children}</dd>
    </div>
  )
}

function PlanTypePill({
  planType,
  subtype,
}: {
  planType: 'pool' | 'quota' | null
  subtype: string | null
}) {
  if (!planType) return null
  if (planType === 'quota') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#007aff]/10 text-[#007aff]">
        按量
      </span>
    )
  }
  const label = (subtype && SUBTYPE_LABEL[subtype]) || '订阅'
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#af52de]/10 text-[#af52de]">
      {label}
    </span>
  )
}

/* ---------- main ---------- */

export default function CheckoutResultPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  const queryObject: Record<string, string> = {}
  searchParams.forEach((v, k) => {
    queryObject[k] = v
  })

  const outTradeNo = queryObject.out_trade_no || ''
  const tradeStatus = queryObject.trade_status || null

  const [phase, setPhase] = useState<Phase>('loading')
  const [order, setOrder] = useState<Order | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [pollCount, setPollCount] = useState(0)
  const [pollCountdown, setPollCountdown] = useState(POLL_INTERVAL_SEC)
  const [exhausted, setExhausted] = useState(false)

  // Guard against double-activate in React strict-mode dev
  const activatedRef = useRef(false)

  /* 1. Initial activate call */
  useEffect(() => {
    if (!outTradeNo) {
      setPhase('not_found')
      setErrorMsg('无效的订单链接')
      return
    }
    if (activatedRef.current) return
    activatedRef.current = true

    let cancelled = false
    ;(async () => {
      try {
        const resp = await api<ActivateResponse>('/subscription/activate', {
          method: 'POST',
          body: JSON.stringify(queryObject),
        })
        if (cancelled) return
        if (!resp || resp.order == null) {
          setPhase('not_found')
          return
        }
        setOrder(resp.order)
        if (!resp.ok) {
          setPhase('failed')
          return
        }
        if (resp.order.payment_status === 'paid') {
          setPhase('success')
        } else if (resp.order.payment_status === 'failed') {
          setPhase('failed')
        } else {
          // pending
          setPhase('pending')
        }
      } catch (e: unknown) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : '网络异常'
        setErrorMsg(msg)
        setPhase('not_found')
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outTradeNo])

  /* 2. Polling loop when pending */
  useEffect(() => {
    if (phase !== 'pending') return
    if (exhausted) return
    if (!outTradeNo) return

    // countdown each second
    setPollCountdown(POLL_INTERVAL_SEC)
    const tick = setInterval(() => {
      setPollCountdown((c) => (c > 0 ? c - 1 : 0))
    }, 1000)

    // single-shot poll at the end of the interval
    const fire = setTimeout(async () => {
      clearInterval(tick)
      try {
        const fresh = await api<Order>(
          `/subscription/order/${encodeURIComponent(outTradeNo)}`,
        )
        if (!fresh) {
          // If the order vanished somehow
          return
        }
        setOrder(fresh)
        if (fresh.payment_status === 'paid') {
          setPhase('success')
          return
        }
        if (fresh.payment_status === 'failed') {
          setPhase('failed')
          return
        }
        // still pending
        setPollCount((n) => {
          const next = n + 1
          if (next >= MAX_POLLS) {
            setExhausted(true)
          } else {
            // re-trigger effect by resetting countdown
            setPollCountdown(POLL_INTERVAL_SEC)
          }
          return next
        })
      } catch {
        // on poll error, count as one attempt
        setPollCount((n) => {
          const next = n + 1
          if (next >= MAX_POLLS) setExhausted(true)
          return next
        })
      }
    }, POLL_INTERVAL_SEC * 1000)

    return () => {
      clearInterval(tick)
      clearTimeout(fire)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, pollCount, exhausted, outTradeNo])

  const manualRefresh = async () => {
    if (!outTradeNo) return
    setPhase('loading')
    try {
      const fresh = await api<Order>(
        `/subscription/order/${encodeURIComponent(outTradeNo)}`,
      )
      setOrder(fresh)
      if (fresh.payment_status === 'paid') setPhase('success')
      else if (fresh.payment_status === 'failed') setPhase('failed')
      else {
        setExhausted(false)
        setPollCount(0)
        setPhase('pending')
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '刷新失败'
      setErrorMsg(msg)
      setPhase('not_found')
    }
  }

  /* ---------- render ---------- */

  // Phase: not_found (line marker for report)
  if (phase === 'not_found') {
    return (
      <div className={`${CARD} max-w-[560px] mx-auto p-8 border border-[#e5e5ea]`}>
        <div className="flex flex-col items-center text-center">
          <WarnIcon />
          <h1 className="mt-5 text-[22px] font-semibold text-[#1d1d1f]">找不到该订单</h1>
          <p className="mt-2 text-[14px] text-[#86868b] leading-relaxed">
            {errorMsg
              ? errorMsg
              : outTradeNo
                ? `订单号 ${outTradeNo} 无效或不属于你`
                : '缺少订单号，无法查询支付结果'}
          </p>
          <button
            onClick={() => navigate('/plans')}
            className="mt-8 px-6 py-2.5 bg-[#007aff] text-white text-[14px] font-medium rounded-full hover:bg-[#0066d6] transition-colors"
          >
            返回套餐
          </button>
        </div>
      </div>
    )
  }

  // Phase: loading / pending (share spinner UI)
  if (phase === 'loading' || phase === 'pending') {
    const isPending = phase === 'pending'
    const title = isPending
      ? exhausted
        ? '支付处理中'
        : '再次核对中'
      : '正在确认支付结果'
    const subtitle = isPending
      ? exhausted
        ? '支付稍有延迟，你可以手动刷新或稍后回来查看'
        : `${pollCountdown} 秒后自动刷新（第 ${Math.min(pollCount + 1, MAX_POLLS)} / ${MAX_POLLS} 次）`
      : '请稍候，我们正在与支付平台核对'

    return (
      <div className={`${CARD} max-w-[560px] mx-auto p-10 border border-[#e5e5ea]`}>
        <div className="flex flex-col items-center text-center">
          <Spinner />
          <h1 className="mt-6 text-[20px] font-semibold text-[#1d1d1f]">{title}</h1>
          <p className="mt-2 text-[13px] text-[#86868b]">{subtitle}</p>

          {isPending && order && (
            <dl className="mt-6 w-full divide-y divide-[#f5f5f7] border-y border-[#f5f5f7] text-left">
              <Row label="套餐">
                <span className="inline-flex items-center gap-2">
                  <span className="font-medium">{order.plan_name ?? '—'}</span>
                  <PlanTypePill planType={order.plan_type} subtype={order.subtype} />
                </span>
              </Row>
              <Row label="金额">
                <span className="tabular-nums">{fmtMoney(order.amount, order.currency)}</span>
              </Row>
              <Row label="订单号">
                <span className="font-mono text-[12px] text-[#6e6e73]">{order.out_trade_no}</span>
              </Row>
            </dl>
          )}

          {isPending && exhausted && (
            <div className="mt-6 flex gap-3">
              <button
                onClick={manualRefresh}
                className="px-5 py-2 bg-[#007aff] text-white text-[13px] font-medium rounded-full hover:bg-[#0066d6] transition-colors"
              >
                手动刷新
              </button>
              <button
                onClick={() => navigate('/billing')}
                className="px-5 py-2 text-[#007aff] text-[13px] font-medium rounded-full border border-[#007aff]/30 hover:bg-[#007aff]/5 transition-colors"
              >
                稍后再来
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Phase: success
  if (phase === 'success' && order) {
    const isPool = order.plan_type === 'pool'
    const balanceLabel = isPool ? '本周期可用' : '账户额度'

    return (
      <div className={`${CARD} max-w-[560px] mx-auto p-8 border border-[#e5e5ea]`}>
        <div className="flex flex-col items-center text-center">
          <SuccessIcon />
          <h1 className="mt-5 text-[22px] font-semibold text-[#1d1d1f]">支付成功</h1>
          <p className="mt-2 text-[13px] text-[#86868b]">订阅已激活，现在可以开始使用</p>
        </div>

        <dl className="mt-7 divide-y divide-[#f5f5f7] border-y border-[#f5f5f7]">
          <Row label="套餐">
            <span className="inline-flex items-center gap-2">
              <span className="font-medium">{order.plan_name ?? '—'}</span>
              <PlanTypePill planType={order.plan_type} subtype={order.subtype} />
            </span>
          </Row>
          <Row label="金额">
            <span className="tabular-nums">{fmtMoney(order.amount, order.currency)}</span>
          </Row>
          {order.balance != null && (
            <Row label={balanceLabel}>
              <span className="tabular-nums text-[#007aff] font-semibold">
                ${Number(order.balance).toFixed(2)}
              </span>
            </Row>
          )}
          <Row label="有效期至">
            <span>{fmtExpires(order.expires_at)}</span>
          </Row>
          <Row label="订单号">
            <span className="font-mono text-[12px] text-[#6e6e73]">{order.out_trade_no}</span>
          </Row>
          <Row label="支付时间">
            <span className="tabular-nums">{fmtDate(order.paid_at)}</span>
          </Row>
        </dl>

        <div className="mt-7 flex gap-3 justify-center">
          <button
            onClick={() => navigate('/plans')}
            className="px-6 py-2.5 bg-[#007aff] text-white text-[14px] font-medium rounded-full hover:bg-[#0066d6] transition-colors"
          >
            查看余额
          </button>
          <button
            onClick={() => navigate('/billing')}
            className="px-6 py-2.5 text-[#007aff] text-[14px] font-medium rounded-full border border-[#007aff]/30 hover:bg-[#007aff]/5 transition-colors"
          >
            去账单
          </button>
        </div>
      </div>
    )
  }

  // Phase: failed (covers payment_status=failed OR non-success trade_status OR ok=false)
  const reason = tradeStatus && tradeStatus !== 'TRADE_SUCCESS'
    ? tradeStatusReason(tradeStatus)
    : order?.payment_status === 'failed'
      ? '支付失败，未能完成扣款'
      : '交易未成功'

  const resumePlanId = order?.plan_id ?? null
  const resumeOutTradeNo = order?.out_trade_no ?? outTradeNo

  return (
    <div className={`${CARD} max-w-[560px] mx-auto p-8 border border-[#e5e5ea]`}>
      <div className="flex flex-col items-center text-center">
        <FailIcon />
        <h1 className="mt-5 text-[22px] font-semibold text-[#1d1d1f]">支付未完成</h1>
        <p className="mt-2 text-[13px] text-[#86868b] leading-relaxed">{reason}</p>
      </div>

      {order && (
        <dl className="mt-7 divide-y divide-[#f5f5f7] border-y border-[#f5f5f7]">
          <Row label="套餐">
            <span className="inline-flex items-center gap-2">
              <span className="font-medium">{order.plan_name ?? '—'}</span>
              <PlanTypePill planType={order.plan_type} subtype={order.subtype} />
            </span>
          </Row>
          <Row label="金额">
            <span className="tabular-nums">{fmtMoney(order.amount, order.currency)}</span>
          </Row>
          <Row label="订单号">
            <span className="font-mono text-[12px] text-[#6e6e73]">{order.out_trade_no}</span>
          </Row>
        </dl>
      )}

      <div className="mt-7 flex gap-3 justify-center">
        <button
          onClick={() => {
            if (resumePlanId) {
              navigate(`/checkout/${resumePlanId}?resume=${encodeURIComponent(resumeOutTradeNo)}`)
            } else {
              navigate('/plans')
            }
          }}
          className="px-6 py-2.5 bg-[#007aff] text-white text-[14px] font-medium rounded-full hover:bg-[#0066d6] transition-colors"
        >
          重新支付
        </button>
        <button
          onClick={() => navigate('/plans')}
          className="px-6 py-2.5 text-[#007aff] text-[14px] font-medium rounded-full border border-[#007aff]/30 hover:bg-[#007aff]/5 transition-colors"
        >
          返回套餐
        </button>
      </div>
    </div>
  )
}
