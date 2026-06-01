// Shared primitives for the accounts admin page: letter icon, ring/mini charts,
// status row, big stat, time/percent helpers. Kept colocated so the card grid
// and the drawer render identically.

export interface RateLimit {
  utilization: number | null
  resets_at: string | null
}

export interface ClaudeUtilization {
  five_hour?: RateLimit | null
  seven_day?: RateLimit | null
  seven_day_opus?: RateLimit | null
  seven_day_sonnet?: RateLimit | null
  seven_day_oauth_apps?: RateLimit | null
}

export function fmtRelative(date: string | null | undefined): string {
  if (!date) return '从未使用'
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins}分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  return `${days}天前`
}

export function fmtResetIn(resetsAt: string | null | undefined): string {
  if (!resetsAt) return ''
  const diff = new Date(resetsAt).getTime() - Date.now()
  if (diff <= 0) return '已重置'
  const hours = Math.floor(diff / 3_600_000)
  const mins = Math.floor((diff % 3_600_000) / 60_000)
  if (hours >= 24) return `${Math.floor(hours / 24)}天${hours % 24}时后重置`
  if (hours > 0) return `${hours}时${mins}分后重置`
  return `${mins}分钟后重置`
}

export function fmtDuration(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.floor(seconds ?? 0))
  if (total <= 0) return '0秒'
  const mins = Math.floor(total / 60)
  const secs = total % 60
  if (mins <= 0) return `${secs}秒`
  if (mins < 60) return secs > 0 ? `${mins}分${secs}秒` : `${mins}分`
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  return remMins > 0 ? `${hours}时${remMins}分` : `${hours}时`
}

export function utilPct(r: RateLimit | null | undefined): number {
  if (!r || r.utilization === null || r.utilization === undefined) return 0
  return Math.min(100, Math.max(0, r.utilization))
}

// Solid color per account_type — no gradients (user rule).
function typeColor(type: string | null | undefined): string {
  switch (type) {
    case 'max': return 'var(--accent)'
    case 'team': return 'var(--ok)'
    case 'enterprise': return 'var(--ink)'
    case 'pro':
    default: return 'var(--info)'
  }
}

export function LetterIcon({ name, type, size = 28 }: {
  name: string
  type: string | null | undefined
  size?: number
}) {
  const letter = (name.charAt(0) || '?').toUpperCase()
  return (
    <div
      className="flex items-center justify-center text-white font-semibold rounded-[8px] shrink-0 select-none"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.45,
        background: typeColor(type),
      }}
    >
      {letter}
    </div>
  )
}

function toneFor(pct: number, base: string): string {
  if (pct >= 90) return 'var(--err)'
  if (pct >= 70) return 'var(--warn)'
  return base
}

export function MiniBar({ label, percentage, color }: {
  label: string
  percentage: number
  color: string
}) {
  const pct = Math.min(100, Math.max(0, percentage ?? 0))
  const c = toneFor(pct, color)
  return (
    <div>
      <div className="flex justify-between text-[10px] mb-1">
        <span className="text-[var(--ink-3)]">{label}</span>
        <span className="text-[var(--ink)] font-semibold tabular-nums">{pct.toFixed(1)}%</span>
      </div>
      <div className="h-[3px] bg-[var(--rule-2)] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: c }} />
      </div>
    </div>
  )
}

export function RingChart({ label, percentage, color, resetIn }: {
  label: string
  percentage: number
  color: string
  resetIn?: string
}) {
  const pct = Math.min(100, Math.max(0, percentage))
  const circumference = 2 * Math.PI * 34
  const offset = circumference - (pct / 100) * circumference
  const stroke = toneFor(pct, color)

  return (
    <div className="text-center p-3 bg-[var(--mute-bg)] rounded-lg">
      <svg width="84" height="84" viewBox="0 0 84 84" className="mx-auto">
        <circle cx="42" cy="42" r="34" fill="none" stroke="var(--rule)" strokeWidth="7" />
        <circle
          cx="42" cy="42" r="34" fill="none"
          stroke={stroke} strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 42 42)"
        />
        <text
          x="42" y="40" textAnchor="middle" dominantBaseline="middle"
          fontSize="17" fontWeight="700" fill="var(--ink)"
        >
          {pct.toFixed(1)}%
        </text>
        <text x="42" y="55" textAnchor="middle" fontSize="9" fill="var(--ink-3)">
          {label}
        </text>
      </svg>
      <div className="text-[10px] text-[var(--ink-3)] mt-1">{resetIn || '—'}</div>
    </div>
  )
}

export function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-[12px]">
      <span className="text-[var(--ink-3)]">{label}</span>
      <span className="tabular-nums font-medium text-[var(--ink)]">{value}</span>
    </div>
  )
}

export function BigStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <div className="text-[11px] text-[var(--ink-3)] font-medium">{label}</div>
      <div className="mt-1 text-[22px] font-semibold tracking-tight text-[var(--ink)] tabular-nums">{value}</div>
    </div>
  )
}


// Palette shared between RingChart and MiniBar so both views read consistently.
export const UTIL_COLORS = {
  five_hour: 'var(--info)',
  seven_day: 'var(--ink)',
  opus: 'var(--accent)',
  sonnet: 'var(--ok)',
}
