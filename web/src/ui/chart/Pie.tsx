import { useMemo, useState } from 'react'

export interface PieSlice { label: string; value: number; color: string }

export interface PieProps {
  slices: PieSlice[]
  size?: number
  strokeWidth?: number
  centerLabel?: string
  centerValue?: string
  formatValue?: (v: number) => string
  layout?: 'horizontal' | 'vertical'
}

export function Pie({
  slices,
  size = 200,
  strokeWidth = 22,
  centerLabel,
  centerValue,
  formatValue,
  layout = 'horizontal',
}: PieProps) {
  const [hover, setHover] = useState<number | null>(null)

  const { segments, total } = useMemo(() => {
    const total = slices.reduce((s, it) => s + Math.max(0, it.value), 0)
    if (total === 0) return { segments: [], total: 0 }
    const r = (size - strokeWidth) / 2
    const cx = size / 2
    const cy = size / 2
    const circ = 2 * Math.PI * r
    let acc = 0
    const segs = slices.map((s) => {
      const frac = Math.max(0, s.value) / total
      const len = frac * circ
      const seg = { ...s, frac, dashArray: `${len} ${circ - len}`, dashOffset: -acc }
      acc += len
      return seg
    })
    return { segments: segs, total, r, cx, cy, circ }
  }, [slices, size, strokeWidth])

  if (total === 0 || segments.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-[12px] text-[var(--ink-3)] border border-[var(--rule)] rounded"
        style={{ width: size, height: size }}
      >
        暂无数据
      </div>
    )
  }

  const r = (size - strokeWidth) / 2
  const cx = size / 2
  const cy = size / 2

  const isVertical = layout === 'vertical'
  const wrapperClass = isVertical
    ? 'flex flex-col items-center gap-4'
    : 'flex items-center gap-5'
  const legendClass = isVertical
    ? 'w-full space-y-1 text-[12px]'
    : 'flex-1 min-w-0 space-y-1 text-[12px]'

  return (
    <div className={wrapperClass} style={isVertical ? undefined : { minHeight: size }}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg viewBox={`0 0 ${size} ${size}`} style={{ width: size, height: size }}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--rule-2)" strokeWidth={strokeWidth} />
          {segments.map((s, i) => (
            <circle
              key={s.label}
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={hover === i ? strokeWidth + 2 : strokeWidth}
              strokeDasharray={s.dashArray}
              strokeDashoffset={s.dashOffset}
              transform={`rotate(-90 ${cx} ${cy})`}
              style={{ cursor: 'pointer', transition: 'stroke-width 120ms ease' }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          ))}
        </svg>
        {(centerLabel || centerValue) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
            {centerLabel && <div className="text-[10px] uppercase tracking-wider font-mono text-[var(--ink-3)]">{centerLabel}</div>}
            {centerValue && <div className="mt-0.5 text-[18px] font-medium tabular-nums text-[var(--ink)]">{centerValue}</div>}
          </div>
        )}
      </div>
      <ul className={legendClass}>
        {segments.map((s, i) => {
          const active = hover === i
          return (
            <li
              key={s.label}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              className={`flex items-center gap-2 px-2 py-1 rounded cursor-default ${active ? 'bg-[var(--rule-2)]' : ''}`}
            >
              <span
                className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                style={{ background: s.color }}
              />
              <span className="truncate flex-1 font-mono text-[11px] text-[var(--ink)]" title={s.label}>
                {s.label}
              </span>
              <span className="tabular-nums font-mono text-[11px] text-[var(--ink-2)]">
                {formatValue ? formatValue(s.value) : s.value}
              </span>
              <span className="tabular-nums font-mono text-[10px] text-[var(--ink-3)] w-[38px] text-right">
                {(s.frac * 100).toFixed(1)}%
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
