// HBarList — horizontal bar list for Top-N rankings.
//
// Replaces the old vertical `Bars` block on dashboard. Each row is a
// label + inline bar (width ∝ value / max) + right-aligned count. Works
// with 1–N rows; empty state shows a single muted line.

export interface HBarListItem {
  label: string
  value: number
}

export interface HBarListProps {
  items: HBarListItem[]
  emptyLabel?: string
  formatValue?: (v: number) => string
}

export function HBarList({ items, emptyLabel = '近期没有数据。', formatValue }: HBarListProps) {
  if (items.length === 0) {
    return <div className="text-[12px] text-[var(--ink-3)] py-4">{emptyLabel}</div>
  }
  const max = Math.max(...items.map((i) => i.value), 1)
  return (
    <ul className="space-y-2 text-[12px]">
      {items.map((it) => {
        const pct = Math.round((it.value / max) * 100)
        return (
          <li key={it.label} className="flex items-center gap-3">
            <span className="w-[40%] truncate text-[var(--ink-2)]">{it.label}</span>
            <div className="flex-1 h-[6px] bg-[var(--rule-2)] rounded-[2px] overflow-hidden">
              <div
                className="h-full bg-[var(--ink)]"
                style={{ width: `${Math.max(pct, 2)}%` }}
              />
            </div>
            <span className="w-14 tabular-nums text-right text-[var(--ink-3)] font-mono">
              {formatValue ? formatValue(it.value) : it.value.toLocaleString()}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
