export function Bars({ points, width = 600, height = 100, color = 'var(--ink)' }: {
  points: number[]; width?: number; height?: number; color?: string
}) {
  const max = Math.max(...points, 1)
  const barW = width / points.length - 2
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
      {points.map((v, i) => (
        <rect key={i} x={i * (barW + 2)} y={height - (v / max) * (height - 4)} width={barW} height={(v / max) * (height - 4)} fill={color} />
      ))}
    </svg>
  )
}
