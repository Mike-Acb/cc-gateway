import type { ReactNode } from 'react'

export interface Column<T> {
  key: string
  header: ReactNode
  render: (row: T) => ReactNode
  className?: string
  style?: React.CSSProperties
}

export function Table<T extends { id?: string | number }>({
  rows, columns, onRowClick, emptyLabel = 'No rows.',
}: {
  rows: T[]
  columns: Column<T>[]
  onRowClick?: (row: T) => void
  emptyLabel?: string
}) {
  if (rows.length === 0) {
    return <div className="p-6 text-center text-[var(--ink-3)] text-[12px]">{emptyLabel}</div>
  }
  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-[var(--rule)] text-left font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">
            {columns.map(c => <th key={c.key} className={`px-3 py-2 whitespace-nowrap ${c.className ?? ''}`} style={c.style}>{c.header}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={(row.id ?? i) as any}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`border-b border-[var(--rule)] ${onRowClick ? 'cursor-pointer hover:bg-[var(--rule-2)]' : ''}`}
            >
              {columns.map(c => <td key={c.key} className={`px-3 py-2 ${c.className ?? ''}`}>{c.render(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
