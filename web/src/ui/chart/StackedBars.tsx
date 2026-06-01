import { useState } from 'react'

export interface StackedSeries { label: string; color: string; values: number[] }
export function StackedBars({ series, labels, width = 600, height = 160 }: {
  series: StackedSeries[]
  labels: string[]
  width?: number
  height?: number
}) {
  const n = labels.length
  const totals = Array.from({ length: n }, (_, i) => series.reduce((s, ser) => s + ser.values[i], 0))
  const max = Math.max(...totals, 1)
  const barW = width / n - 2
  const [tip, setTip] = useState<{ x: number; y: number; i: number } | null>(null)

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
        {labels.map((_, i) => {
          let y = height - 4
          const rects = series.slice().reverse().map((ser, k) => {
            const segH = (ser.values[i] / max) * (height - 8)
            y -= segH
            return <rect key={k} x={i * (barW + 2)} y={y} width={barW} height={segH} fill={ser.color} />
          })
          return (
            <g key={i}
              onMouseMove={(e) => {
                const svg = e.currentTarget.ownerSVGElement!
                const r = svg.getBoundingClientRect()
                setTip({ x: e.clientX - r.left, y: e.clientY - r.top, i })
              }}
              onMouseLeave={() => setTip(null)}
            >
              {rects}
              <rect x={i * (barW + 2)} y={0} width={barW + 2} height={height} fill="transparent" style={{ cursor: 'crosshair' }} />
            </g>
          )
        })}
      </svg>
      {tip && (
        <div
          className="absolute bg-[var(--ink)] text-[var(--bg)] font-mono text-[10px] px-2 py-1.5 rounded pointer-events-none z-50 shadow-[0_2px_8px_rgba(0,0,0,0.15)]"
          style={{ left: tip.x, top: tip.y - 8, transform: 'translate(-50%,-100%)' }}
        >
          <div className="font-bold mb-1">{labels[tip.i]}</div>
          {series.map(s => (
            <div key={s.label}>
              <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: s.color }} />
              {s.label}: <b>{s.values[tip.i]}</b>
            </div>
          ))}
          <div className="text-[var(--ink-3)] mt-1">total: <b className="text-white">{totals[tip.i]}</b></div>
        </div>
      )}
      <div className="mt-1 font-mono text-[10px] text-[var(--ink-3)]">
        {series.map(s => (
          <span key={s.label} className="mr-3 inline-flex items-center gap-1">
            <span className="inline-block w-2.5 h-2.5" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  )
}
