// 钱包双栏: pool 订阅 + quota 按量. 配合 tokens.css (暖纸 + 细描边 + 无渐变).
//
// M2+: pool 可用性由 4 窗口 cap (5h/1d/7d/30d) 裁决, balance 只是累计审计值.
// 服务端 /api/me/billing 和 /api/me/dashboard 的 wallet.pool 会返回 `usable` + `caps`,
// 组件照搬展示, 不在前端二次判定.

// ---------- Types ----------
type CapKind = '5h' | '1d' | '7d' | '30d'
type PoolCap = { limit: number; used: number; windowStart?: string | null } | null

interface PoolWallet {
  subscription_id: string
  plan_name: string
  balance: number
  expires_at: string | null
  starts_at?: string | null
  usable?: boolean
  caps?: Record<CapKind, PoolCap>
}

interface QuotaWallet {
  subscription_id: string
  plan_name: string
  balance: number
}

interface Wallet {
  pool: PoolWallet | null
  quota: QuotaWallet | null
  consumption_order: 'pool_first'
}

export interface WaterLevelBarProps {
  wallet: Wallet
  onRecharge?: () => void
  onSubscribe?: () => void
  compact?: boolean
}

// ---------- Helpers ----------
function fmtUsd(n: number, digits = 2): string {
  return `$${n.toFixed(digits)}`
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null
  const diff = new Date(iso).getTime() - Date.now()
  return Math.floor(diff / (24 * 3600 * 1000))
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('zh-CN')
}

const CAP_LABELS: Record<CapKind, string> = {
  '5h':  '5 小时',
  '1d':  '24 小时',
  '7d':  '7 天',
  '30d': '30 天',
}

const CAP_DURATION_MS: Record<CapKind, number> = {
  '5h':  5 * 3600 * 1000,
  '1d':  24 * 3600 * 1000,
  '7d':  7 * 24 * 3600 * 1000,
  '30d': 30 * 24 * 3600 * 1000,
}

function fmtResetAt(windowStart: string | null | undefined, kind: CapKind): string {
  if (!windowStart) return '尚未启用'
  const start = new Date(windowStart).getTime()
  if (!Number.isFinite(start)) return '尚未启用'
  const resetAt = start + CAP_DURATION_MS[kind]
  const remainMs = resetAt - Date.now()
  if (remainMs <= 0) return '即将重置'
  const hours = remainMs / 3600_000
  if (hours < 1) {
    const mins = Math.max(1, Math.round(remainMs / 60_000))
    return `${mins} 分钟后重置`
  }
  if (hours < 24) return `${Math.round(hours)} 小时后重置`
  const days = Math.floor(hours / 24)
  const hrs = Math.round(hours - days * 24)
  return hrs > 0 ? `${days} 天 ${hrs} 小时后重置` : `${days} 天后重置`
}

// ---------- Small primitives ----------
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

// ---------- Component ----------
function WaterLevelBar({ wallet, onRecharge, onSubscribe, compact = false }: WaterLevelBarProps) {
  const { pool, quota } = wallet

  const poolDays = pool ? daysUntil(pool.expires_at) : null
  const poolExpired = !!(pool && poolDays !== null && poolDays < 0)
  const poolExpiringSoon = !!(pool && poolDays !== null && poolDays >= 0 && poolDays <= 3)
  const poolUsable = !!pool && !poolExpired && (pool.usable ?? true)

  const currentSource: 'pool' | 'quota' | 'none' = poolUsable
    ? 'pool'
    : quota
      ? 'quota'
      : 'none'

  const bothNull = !pool && !quota
  const pad = compact ? 'p-4' : 'p-5'

  if (bothNull) {
    return (
      <div className={`border border-[var(--rule)] bg-[var(--surface)] rounded ${pad}`}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <div className="font-serif text-[20px] text-[var(--ink)]">尚未开通任何套餐</div>
            <div className="text-[12px] text-[var(--ink-3)] mt-1">
              订阅共享账号或充值个人余额后即可使用
            </div>
          </div>
          <button
            type="button"
            onClick={onSubscribe}
            className="px-3 py-1.5 text-[12px] font-mono uppercase tracking-[0.08em] border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent-weak)] rounded-sm"
          >
            去购买 →
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`border border-[var(--rule)] bg-[var(--surface)] rounded ${pad}`}>
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-4 md:gap-5 items-stretch">
        <PoolColumn
          pool={pool}
          poolUsable={poolUsable}
          poolExpired={poolExpired}
          poolExpiringSoon={poolExpiringSoon}
          compact={compact}
          onSubscribe={onSubscribe}
        />
        <ArrowDivider compact={compact} />
        <QuotaColumn
          quota={quota}
          highlight={currentSource === 'quota'}
          compact={compact}
          onRecharge={onRecharge}
        />
      </div>

      {!compact && <SharedFooter currentSource={currentSource} pool={pool} quota={quota} />}
    </div>
  )
}

// ---------- Pool 栏 ----------
function PoolColumn(props: {
  pool: PoolWallet | null
  poolUsable: boolean
  poolExpired: boolean
  poolExpiringSoon: boolean
  compact: boolean
  onSubscribe?: () => void
}) {
  const { pool, poolUsable, poolExpired, poolExpiringSoon, compact, onSubscribe } = props

  if (!pool) {
    return (
      <div className="border border-dashed border-[var(--rule)] rounded p-4 flex flex-col gap-3 min-h-[150px]">
        <SectionLabel>订阅 · pool</SectionLabel>
        <div className="flex-1 flex flex-col justify-center">
          <div className="font-serif text-[22px] text-[var(--ink-3)] leading-tight">未订阅</div>
          <div className="text-[12px] text-[var(--ink-3)] mt-2 leading-relaxed">
            订阅共享账号可获得 4 窗口固定额度, 优先于 quota 扣费
          </div>
        </div>
        <button
          type="button"
          onClick={onSubscribe}
          className="self-start px-3 py-1.5 text-[12px] font-mono uppercase tracking-[0.08em] border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent-weak)] rounded-sm"
        >
          订阅 →
        </button>
      </div>
    )
  }

  const caps = pool.caps
  const capEntries = caps
    ? ((Object.entries(caps) as Array<[CapKind, PoolCap]>).filter(([, v]) => v !== null) as Array<[CapKind, { limit: number; used: number; windowStart?: string | null }]>)
    : []
  const hitCap = capEntries.find(([, v]) => v.used >= v.limit)

  return (
    <div className="border border-[var(--rule)] rounded p-4 flex flex-col gap-3 min-h-[150px]"
      style={{ background: poolUsable ? 'transparent' : 'var(--rule-2)' }}>
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>订阅 · pool</SectionLabel>
        <div className="flex items-center gap-1.5">
          {poolUsable ? <Tag tone="ok">使用中</Tag> : <Tag tone="mute">闲置</Tag>}
          {poolExpiringSoon && <Tag tone="warn">即将到期</Tag>}
          {poolExpired && <Tag tone="mute">已过期</Tag>}
        </div>
      </div>

      <div className="flex items-baseline gap-2 flex-wrap">
        <span className={`font-serif leading-none ${compact ? 'text-[22px]' : 'text-[26px]'} text-[var(--ink)]`}>
          {pool.plan_name}
        </span>
        {pool.expires_at && (
          <span className="text-[11px] font-mono text-[var(--ink-3)]">
            到期 {fmtDate(pool.expires_at)}
          </span>
        )}
      </div>

      {capEntries.length > 0 ? (
        <div className="space-y-2">
          {capEntries.map(([kind, v]) => (
            <CapBar key={kind} kind={kind} limit={v.limit} used={v.used} windowStart={v.windowStart ?? null} />
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-[var(--ink-3)]">此套餐未设置用量上限</div>
      )}

      {!poolUsable && hitCap && (
        <div className="text-[11px] text-[var(--err)] font-mono">
          {CAP_LABELS[hitCap[0]]}用量已达上限, 将改扣 quota
        </div>
      )}
    </div>
  )
}

// ---------- Cap 进度条 ----------
function CapBar({
  kind,
  limit,
  used,
  windowStart,
}: {
  kind: CapKind
  limit: number
  used: number
  windowStart: string | null
}) {
  const pct = Math.min(100, Math.max(0, (used / limit) * 100))
  const hit = used >= limit
  const warn = pct >= 80 && !hit
  const barColor = hit ? 'var(--err)' : warn ? 'var(--warn)' : 'var(--accent)'
  const valueColor = hit ? 'var(--err)' : 'var(--ink)'
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-[var(--ink-3)] font-mono">{CAP_LABELS[kind]}</span>
        <span className="font-mono tabular-nums" style={{ color: valueColor }}>
          {fmtUsd(used, used >= 0.01 ? 2 : 4)} / {fmtUsd(limit)}
        </span>
      </div>
      <div className="mt-1 h-[3px] bg-[var(--rule)] overflow-hidden rounded-sm">
        <div
          style={{
            width: `${pct}%`,
            background: barColor,
            height: '100%',
            transition: 'width 200ms ease',
          }}
        />
      </div>
      <div className="mt-1 text-[10px] font-mono text-[var(--ink-3)]">
        {fmtResetAt(windowStart, kind)}
      </div>
    </div>
  )
}

// ---------- 中间箭头 ----------
function ArrowDivider({ compact }: { compact: boolean }) {
  return (
    <div className="flex md:flex-col items-center justify-center gap-2 md:gap-1 py-1 md:py-0">
      <div
        className="text-[14px] font-mono select-none"
        style={{ color: 'var(--ink-3)' }}
        aria-hidden="true"
      >
        <span className="hidden md:inline">→</span>
        <span className="md:hidden">↓</span>
      </div>
      {!compact && (
        <div className="text-[10px] font-mono leading-tight text-center text-[var(--ink-3)] uppercase tracking-[0.08em]">
          <span className="md:block">pool</span>
          <span className="md:block"> fallback</span>
          <span className="md:block">quota</span>
        </div>
      )}
    </div>
  )
}

// ---------- Quota 栏 ----------
function QuotaColumn(props: {
  quota: QuotaWallet | null
  highlight: boolean
  compact: boolean
  onRecharge?: () => void
}) {
  const { quota, highlight, compact, onRecharge } = props

  if (!quota) {
    return (
      <div className="border border-dashed border-[var(--rule)] rounded p-4 flex flex-col gap-3 min-h-[150px]">
        <SectionLabel>按量 · quota</SectionLabel>
        <div className="flex-1 flex flex-col justify-center">
          <div className="font-serif text-[22px] text-[var(--ink-3)] leading-tight">未充值</div>
          <div className="text-[12px] text-[var(--ink-3)] mt-2 leading-relaxed">
            充值后作为兜底余额使用, 不过期
          </div>
        </div>
        <button
          type="button"
          onClick={onRecharge}
          className="self-start px-3 py-1.5 text-[12px] font-mono uppercase tracking-[0.08em] border border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent-weak)] rounded-sm"
        >
          充值 →
        </button>
      </div>
    )
  }

  const negative = quota.balance < 0
  const amountColor = negative ? 'var(--err)' : 'var(--ink)'

  return (
    <div
      className="border border-[var(--rule)] rounded p-4 flex flex-col gap-3 min-h-[150px]"
      style={{ background: highlight ? 'transparent' : 'var(--rule-2)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>按量 · quota</SectionLabel>
        {highlight ? <Tag tone="ok">使用中</Tag> : <Tag tone="mute">备用</Tag>}
      </div>

      <div>
        <div
          className={`font-serif tabular-nums leading-none ${compact ? 'text-[32px]' : 'text-[40px]'}`}
          style={{ color: amountColor }}
        >
          {fmtUsd(quota.balance)}
        </div>
        <div className="text-[12px] text-[var(--ink-2)] mt-1.5">{quota.plan_name}</div>
        <div className="text-[11px] font-mono text-[var(--ink-3)] mt-0.5">永久 · 不过期</div>
      </div>

      <button
        type="button"
        onClick={onRecharge}
        className="self-start text-[11px] font-mono uppercase tracking-[0.08em] text-[var(--accent)] hover:underline"
      >
        充值 / 升级 →
      </button>
    </div>
  )
}

// ---------- 共享底部 ----------
function SharedFooter(props: {
  currentSource: 'pool' | 'quota' | 'none'
  pool: PoolWallet | null
  quota: QuotaWallet | null
}) {
  const { currentSource, pool, quota } = props

  const leftLabel = pool?.plan_name ?? '订阅余额'
  const rightLabel = quota?.plan_name ?? '按量余额'

  const activeName =
    currentSource === 'pool' ? leftLabel : currentSource === 'quota' ? rightLabel : null

  return (
    <div className="mt-4 pt-3 border-t border-[var(--rule)] flex items-center justify-between flex-wrap gap-2">
      <div className="text-[11px] font-mono text-[var(--ink-3)]">
        {activeName ? (
          <>
            下一次请求优先扣{' '}
            <span className="text-[var(--ink)]">{activeName}</span>
          </>
        ) : (
          <span>当前无可扣费来源</span>
        )}
      </div>
      <div className="text-[10px] font-mono uppercase tracking-[0.08em] text-[var(--ink-3)]">
        pool → quota
      </div>
    </div>
  )
}

export default WaterLevelBar
