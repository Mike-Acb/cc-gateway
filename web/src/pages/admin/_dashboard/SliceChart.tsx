import { useMemo } from 'react'
import { MultiLine } from '../../../ui'

export type SeriesPoint = { t: string; label: string; v: number }

const PALETTE = [
  'var(--accent)',
  'var(--info)',
  'var(--ok)',
  'var(--warn)',
  'var(--err)',
  'var(--ink-2)',
]

function colorFor(label: string): string {
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) | 0
  return PALETTE[Math.abs(h) % PALETTE.length]
}

function formatTick(raw: string, granularity: 'day' | 'hour'): string {
  // raw is ISO-ish string from PG date_trunc
  const d = new Date(raw)
  if (isNaN(d.getTime())) return String(raw).slice(5, 16)
  const pad = (n: number) => String(n).padStart(2, '0')
  if (granularity === 'hour') {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`
  }
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export default function SliceChart({
  series,
  granularity,
  height = 260,
}: {
  series: SeriesPoint[]
  granularity: 'day' | 'hour'
  height?: number
}) {
  const { xAxis, multiSeries } = useMemo(() => {
    const tSet = new Set(series.map((s) => String(s.t)))
    const xAxis = [...tSet].sort()

    const byLabel = new Map<string, Map<string, number>>()
    for (const s of series) {
      const key = String(s.t)
      if (!byLabel.has(s.label)) byLabel.set(s.label, new Map())
      byLabel.get(s.label)!.set(key, Number(s.v) || 0)
    }
    const multiSeries = [...byLabel.entries()].map(([label, m]) => ({
      label,
      color: colorFor(label),
      points: xAxis.map((t) => m.get(t) ?? 0),
    }))
    return { xAxis, multiSeries }
  }, [series])

  if (xAxis.length === 0 || multiSeries.length === 0) {
    return (
      <div className="border border-[var(--rule)] p-8 text-center text-[12px] text-[var(--ink-3)]">
        暂无数据
      </div>
    )
  }

  return (
    <MultiLine
      series={multiSeries}
      xLabels={xAxis}
      height={height}
      formatX={(raw) => formatTick(raw, granularity)}
    />
  )
}
