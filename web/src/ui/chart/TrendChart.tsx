// TrendChart — dual-series line chart with X/Y axis, dots, and hover tooltip.
//
// Used for user/admin dashboard "请求趋势" over a user-selectable window
// (24h in hour buckets, 7d/30d in day buckets). Degrades gracefully: single
// point shows a dot, all-zero shows a muted baseline + empty hint. Hover
// shows a vertical guide line + floating card with the bucket totals.

import { useMemo, useRef, useState } from 'react'

export interface TrendPoint {
  bucket: string // ISO timestamp (start of bucket)
  success: number
  blocked: number
  total: number
}

export interface TrendChartProps {
  points: TrendPoint[]
  granularity: 'hour' | 'day'
  height?: number
}

const PAD_L = 40
const PAD_R = 12
const PAD_T = 12
const PAD_B = 24
const VB_W = 800

function niceCeiling(max: number): number {
  if (max <= 0) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(max)))
  const n = max / pow
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return step * pow
}

// 把"看起来合理"的刻度步长选出来：优先产生 4-5 个刻度。
function niceStep(max: number): number {
  if (max <= 0) return 1
  const target = 4
  const rough = max / target
  const pow = Math.pow(10, Math.floor(Math.log10(rough)))
  const n = rough / pow
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
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

function formatXLabel(iso: string, granularity: 'hour' | 'day'): string {
  const d = new Date(iso)
  if (granularity === 'hour') {
    return `${String(d.getHours()).padStart(2, '0')}:00`
  }
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function formatTooltipTime(iso: string, granularity: 'hour' | 'day'): string {
  const d = new Date(iso)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  if (granularity === 'hour') {
    const hh = String(d.getHours()).padStart(2, '0')
    return `${mm}/${dd} ${hh}:00`
  }
  return `${d.getFullYear()}/${mm}/${dd}`
}

export function TrendChart({ points, granularity, height = 180 }: TrendChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const { pathTotal, pathOk, pathBlk, dotsOk, dotsBlk, yTicks, xTicks, maxY, empty, xs } = useMemo(() => {
    const n = points.length
    const maxRaw = Math.max(
      0,
      ...points.map((p) => Math.max(p.success, p.blocked, p.total)),
    )
    const maxY = niceCeiling(maxRaw)
    const empty = maxRaw === 0

    const chartW = VB_W - PAD_L - PAD_R
    const chartH = height - PAD_T - PAD_B
    const stepX = n > 1 ? chartW / (n - 1) : 0
    const x = (i: number) => PAD_L + i * stepX
    const y = (v: number) => PAD_T + chartH - (v / (maxY || 1)) * chartH

    const xs = points.map((_, i) => x(i))

    const build = (key: 'success' | 'blocked' | 'total') => {
      if (n === 0) return { path: '', dots: [] as { x: number; y: number; v: number; iso: string }[] }
      const dots = points.map((p, i) => ({ x: x(i), y: y(p[key]), v: p[key], iso: p.bucket }))
      const path = dots
        .map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
        .join(' ')
      return { path, dots }
    }
    const totalS = build('total')
    const okS = build('success')
    const blkS = build('blocked')

    const step = niceStep(maxY)
    const yTicks: { v: number; y: number }[] = []
    for (let v = 0; v <= maxY + 1e-9; v += step) {
      yTicks.push({ v, y: PAD_T + chartH - (v / (maxY || 1)) * chartH })
      if (yTicks.length > 8) break
    }

    // Pick ~6 evenly spaced labels (keeps labels readable at any window size).
    const xTicks: { label: string; x: number }[] = []
    if (n > 0) {
      const target = Math.min(6, n)
      for (let j = 0; j < target; j++) {
        const i = Math.round((j * (n - 1)) / Math.max(1, target - 1))
        xTicks.push({ label: formatXLabel(points[i].bucket, granularity), x: x(i) })
      }
    }

    return {
      pathTotal: totalS.path,
      pathOk: okS.path,
      pathBlk: blkS.path,
      dotsOk: okS.dots,
      dotsBlk: blkS.dots,
      yTicks,
      xTicks,
      maxY,
      empty,
      xs,
    }
  }, [points, granularity, height])

  function onMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (points.length === 0) return
    const svg = e.currentTarget
    const rect = svg.getBoundingClientRect()
    // Map mouse x (in CSS px) to viewBox x (VB_W wide).
    const vbX = ((e.clientX - rect.left) / rect.width) * VB_W
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

  const hover = hoverIdx !== null ? points[hoverIdx] : null
  const hoverX = hoverIdx !== null ? xs[hoverIdx] : 0
  // Tooltip position in % of wrapper (svg uses preserveAspectRatio=none, so
  // viewBox x maps linearly to wrapper width).
  const tooltipLeftPct = (hoverX / VB_W) * 100
  const flip = tooltipLeftPct > 65

  return (
    <div ref={wrapRef} className="relative">
      <svg
        viewBox={`0 0 ${VB_W} ${height}`}
        preserveAspectRatio="none"
        className="w-full block"
        style={{ height }}
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {yTicks.map((t) => (
          <g key={t.y}>
            <line
              x1={PAD_L}
              x2={VB_W - PAD_R}
              y1={t.y}
              y2={t.y}
              stroke="var(--rule-2)"
              strokeWidth={0.5}
            />
            <text
              x={PAD_L - 6}
              y={t.y + 3}
              textAnchor="end"
              fontSize="10"
              fill="var(--ink-3)"
              fontFamily="ui-monospace, monospace"
            >
              {formatAxis(t.v)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text
            key={t.x}
            x={t.x}
            y={height - 6}
            textAnchor="middle"
            fontSize="10"
            fill="var(--ink-3)"
            fontFamily="ui-monospace, monospace"
          >
            {t.label}
          </text>
        ))}
        {!empty && (
          <>
            <path
              d={pathTotal}
              stroke="var(--ink-3)"
              strokeWidth={1}
              strokeDasharray="3 3"
              fill="none"
            />
            <path d={pathOk} stroke="var(--ink)" strokeWidth={1.5} fill="none" />
            <path d={pathBlk} stroke="var(--warn)" strokeWidth={1.5} fill="none" />
            {dotsOk.map((d, i) =>
              d.v > 0 ? (
                <circle key={`ok-${i}`} cx={d.x} cy={d.y} r={2.5} fill="var(--ink)" />
              ) : null,
            )}
            {dotsBlk.map((d, i) =>
              d.v > 0 ? (
                <circle key={`blk-${i}`} cx={d.x} cy={d.y} r={2.5} fill="var(--warn)" />
              ) : null,
            )}
          </>
        )}
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
          />
        )}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-[140px] rounded-[4px] border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-2 text-[11px] shadow-[0_4px_16px_rgba(0,0,0,0.1)]"
          style={
            flip
              ? { right: `${100 - tooltipLeftPct}%`, marginRight: 8 }
              : { left: `${tooltipLeftPct}%`, marginLeft: 8 }
          }
        >
          <div className="mb-1 text-[var(--ink-3)] font-mono">
            {formatTooltipTime(hover.bucket, granularity)}
          </div>
          <div className="space-y-0.5 font-mono tabular-nums">
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1 text-[var(--ink-2)]">
                <span className="inline-block w-3 border-t border-dashed" style={{ borderColor: 'var(--ink-3)' }} />
                总量
              </span>
              <span>{hover.total}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1 text-[var(--ink-2)]">
                <span className="inline-block w-3 h-[2px]" style={{ background: 'var(--ink)' }} />
                成功
              </span>
              <span>{hover.success}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1 text-[var(--ink-2)]">
                <span className="inline-block w-3 h-[2px]" style={{ background: 'var(--warn)' }} />
                拦截
              </span>
              <span>{hover.blocked}</span>
            </div>
          </div>
        </div>
      )}
      <div className="mt-1 flex items-center gap-4 text-[11px] text-[var(--ink-3)] font-mono">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-3 border-t border-dashed" style={{ borderColor: 'var(--ink-3)' }} />
          总量
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-[2px]" style={{ background: 'var(--ink)' }} />
          成功
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-[2px]" style={{ background: 'var(--warn)' }} />
          拦截
        </span>
        {empty && <span className="ml-auto italic">窗口内没有请求</span>}
        {!empty && <span className="ml-auto">峰值 {formatAxis(maxY)}</span>}
      </div>
    </div>
  )
}
