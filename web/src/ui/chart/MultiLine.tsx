import { useMemo, useState, type CSSProperties } from 'react'

export interface LineSeries { label: string; color: string; points: number[] }

export interface MultiLineProps {
  series: LineSeries[]
  xLabels?: string[]
  width?: number
  height?: number
  formatX?: (raw: string) => string
  formatY?: (v: number) => string
  formatValue?: (v: number, label: string) => string
}

const PAD_L = 44
const PAD_R = 12
const PAD_T = 12
const PAD_B = 24

function niceCeiling(max: number): number {
  if (max <= 0) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(max)))
  const n = max / pow
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return step * pow
}

function niceStep(max: number): number {
  if (max <= 0) return 1
  const target = 5
  const rough = max / target
  const pow = Math.pow(10, Math.floor(Math.log10(rough)))
  const n = rough / pow
  // Finer stops so we don't collapse to a single big step (which leaves only
  // 2-3 ticks). Include 2.5 and 7.5 for in-between spans.
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : n <= 7.5 ? 7.5 : 10
  return step * pow
}

function formatAxis(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 1_000_000) {
    const n = v / 1_000_000
    return `${(Math.round(n * 10) / 10).toString().replace(/\.0$/, '')}M`
  }
  if (abs >= 1_000) {
    const n = v / 1_000
    return `${(Math.round(n * 10) / 10).toString().replace(/\.0$/, '')}k`
  }
  return String(Math.round(v))
}

export function MultiLine({
  series,
  xLabels,
  width = 800,
  height = 180,
  formatX,
  formatY,
  formatValue,
}: MultiLineProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const state = useMemo(() => {
    const allValues = series.flatMap((s) => s.points)
    const len = series[0]?.points.length ?? 0
    if (len === 0 || allValues.length === 0) {
      return null
    }
    const rawMax = Math.max(0, ...allValues)
    const rawMin = Math.min(0, ...allValues)
    const maxY = niceCeiling(rawMax)
    const minY = rawMin < 0 ? -niceCeiling(-rawMin) : 0
    const spanY = maxY - minY || 1

    const chartW = width - PAD_L - PAD_R
    const chartH = height - PAD_T - PAD_B
    const stepX = len > 1 ? chartW / (len - 1) : 0

    const x = (i: number) => PAD_L + i * stepX
    const y = (v: number) => PAD_T + chartH - ((v - minY) / spanY) * chartH
    const xs = Array.from({ length: len }, (_, i) => x(i))

    const paths = series.map((s) => ({
      label: s.label,
      color: s.color,
      d: s.points
        .map((v, i) => `${i === 0 ? 'M' : 'L'}${xs[i].toFixed(1)},${y(v).toFixed(1)}`)
        .join(' '),
      dots: s.points.map((v, i) => ({ x: xs[i], y: y(v), v })),
    }))

    const step = niceStep(spanY)
    const yTicks: { v: number; y: number }[] = []
    for (let v = minY; v <= maxY + 1e-9; v += step) {
      yTicks.push({ v, y: PAD_T + chartH - ((v - minY) / spanY) * chartH })
      if (yTicks.length > 8) break
    }

    const xTicks: { idx: number; label: string; x: number }[] = []
    if (len > 0) {
      const target = Math.min(6, len)
      for (let j = 0; j < target; j++) {
        const i = Math.round((j * (len - 1)) / Math.max(1, target - 1))
        const raw = xLabels?.[i] ?? String(i)
        xTicks.push({
          idx: i,
          label: formatX ? formatX(raw) : raw,
          x: xs[i],
        })
      }
    }

    return { paths, yTicks, xTicks, xs, len, maxY, minY }
  }, [series, xLabels, width, height, formatX])

  if (!state) return null
  const { paths, yTicks, xTicks, xs, len } = state

  function onMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (len === 0) return
    const svg = e.currentTarget
    const rect = svg.getBoundingClientRect()
    const vbX = ((e.clientX - rect.left) / rect.width) * width
    let nearest = 0
    let nearestDist = Infinity
    for (let i = 0; i < xs.length; i++) {
      const d = Math.abs(vbX - xs[i])
      if (d < nearestDist) {
        nearestDist = d
        nearest = i
      }
    }
    setHoverIdx(nearest)
  }

  const hoverX = hoverIdx !== null ? xs[hoverIdx] : 0
  const tooltipLeftPct = (hoverX / width) * 100
  const flip = tooltipLeftPct > 65
  const hoverRaw = hoverIdx !== null ? xLabels?.[hoverIdx] : null
  const hoverLabel = hoverRaw != null ? (formatX ? formatX(hoverRaw) : hoverRaw) : null

  // Axis labels are rendered as HTML overlays (not SVG text) so they stay
  // pixel-crisp regardless of the SVG's non-uniform scaling to container width.
  const pct = (v: number, base: number) => `${(v / base) * 100}%`

  return (
    <div className="w-full h-full flex flex-col">
    <div className="relative w-full flex-1 min-h-0 overflow-hidden" style={{ minHeight: height }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block absolute inset-0 w-full h-full"
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {yTicks.map((t) => (
          <line
            key={t.y}
            x1={PAD_L}
            x2={width - PAD_R}
            y1={t.y}
            y2={t.y}
            stroke="var(--rule-2)"
            strokeWidth={0.5}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {paths.map((p) => (
          <path
            key={p.label}
            d={p.d}
            stroke={p.color}
            strokeWidth={1.5}
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {hoverIdx !== null &&
          paths.map((p) => {
            const dot = p.dots[hoverIdx]
            return (
              <circle
                key={`dot-${p.label}`}
                cx={dot.x}
                cy={dot.y}
                r={2.5}
                fill={p.color}
                vectorEffect="non-scaling-stroke"
              />
            )
          })}
        {hoverIdx !== null && (
          <line
            x1={hoverX}
            x2={hoverX}
            y1={PAD_T}
            y2={height - PAD_B}
            stroke="var(--ink-3)"
            strokeWidth={0.75}
            strokeDasharray="2 2"
            pointerEvents="none"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      {/* Y-axis labels (HTML overlay — pixel-crisp, monospace) */}
      {yTicks.map((t) => (
        <div
          key={`yl-${t.y}`}
          className="pointer-events-none absolute text-right tabular-nums"
          style={{
            top: `${(t.y / height) * 100}%`,
            left: 0,
            width: PAD_L - 6,
            transform: 'translateY(-50%)',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--ink-3)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatY ? formatY(t.v) : formatAxis(t.v)}
        </div>
      ))}

      {/* X-axis labels (HTML overlay) — first/last anchored to edges so they
          don't overflow the container. */}
      {xTicks.map((t, j) => {
        const isFirst = j === 0
        const isLast = j === xTicks.length - 1
        const positional: CSSProperties = isFirst
          ? { left: 0, transform: 'none', textAlign: 'left' }
          : isLast
          ? { right: 0, transform: 'none', textAlign: 'right' }
          : { left: pct(t.x, width), transform: 'translateX(-50%)', textAlign: 'center' }
        return (
          <div
            key={`xl-${t.idx}`}
            className="pointer-events-none absolute tabular-nums"
            style={{
              ...positional,
              bottom: 4,
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--ink-3)',
              whiteSpace: 'nowrap',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {t.label}
          </div>
        )
      })}

      {hoverIdx !== null && (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-[140px] rounded-[4px] border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-2 text-[11px] shadow-[0_4px_16px_rgba(0,0,0,0.1)]"
          style={
            flip
              ? { right: `${100 - tooltipLeftPct}%`, marginRight: 8 }
              : { left: `${tooltipLeftPct}%`, marginLeft: 8 }
          }
        >
          {hoverLabel && (
            <div className="mb-1 text-[var(--ink-3)] font-mono">{hoverLabel}</div>
          )}
          <div className="space-y-0.5 font-mono tabular-nums">
            {paths.map((p) => {
              const v = p.dots[hoverIdx].v
              return (
                <div key={p.label} className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-1 text-[var(--ink-2)]">
                    <span className="inline-block w-3 h-[2px]" style={{ background: p.color }} />
                    {p.label}
                  </span>
                  <span>{formatValue ? formatValue(v, p.label) : v}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
    <div className="mt-2 font-mono text-[10px] text-[var(--ink-3)] flex flex-wrap gap-x-3 gap-y-1">
      {series.map((s) => (
        <span key={s.label} className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-[2px]" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
    </div>
  )
}
