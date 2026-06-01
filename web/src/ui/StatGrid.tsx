import type { ReactNode } from 'react'

export interface StatItem { label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'warn' | 'err' | '' }
export function StatGrid({ items, cols = 4 }: { items: StatItem[]; cols?: 2 | 3 | 4 | 5 }) {
  const colsCls = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4', 5: 'grid-cols-5' }[cols]
  return (
    <div className={`grid gap-2.5 ${colsCls}`}>
      {items.map((it, i) => (
        <div key={i} className="bg-[var(--surface)] border border-[var(--rule)] p-3.5">
          <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">{it.label}</div>
          <div className={`font-serif text-[28px] leading-tight mt-1 tabular-nums ${it.tone === 'ok' ? 'text-[var(--ok)]' : it.tone === 'warn' ? 'text-[var(--warn)]' : it.tone === 'err' ? 'text-[var(--err)]' : ''}`}>
            {it.value}
          </div>
          {it.sub && <div className="text-[11px] text-[var(--ink-3)] mt-0.5">{it.sub}</div>}
        </div>
      ))}
    </div>
  )
}
