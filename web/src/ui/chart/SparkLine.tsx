export function SparkLine({ points, width = 600, height = 100, color = 'var(--ink)' }: {
  points: number[]
  width?: number
  height?: number
  color?: string
}) {
  if (points.length < 2) return null
  const max = Math.max(...points), min = Math.min(...points)
  const range = max - min || 1
  const stepX = width / (points.length - 1)
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(1)},${(height - (v - min) / range * (height - 10) - 4).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
      {[0, 0.25, 0.5, 0.75, 1].map(g => (
        <line key={g} x1={0} x2={width} y1={g * height} y2={g * height} stroke="var(--rule-2)" strokeWidth={0.5} />
      ))}
      <path d={d} stroke={color} strokeWidth={1.5} fill="none" />
    </svg>
  )
}
