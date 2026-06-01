export interface SegmentedOption<T extends string> { value: T; label: string }
export interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[]
  value: T
  onChange: (v: T) => void
  className?: string
}

export function Segmented<T extends string>({ options, value, onChange, className = '' }: SegmentedProps<T>) {
  return (
    <div className={`inline-flex border border-[var(--rule)] rounded-[3px] overflow-hidden font-mono text-[11px] ${className}`}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`px-3 py-1 transition-colors ${value === o.value ? 'bg-[var(--ink)] text-[var(--bg)]' : 'bg-[var(--surface)] text-[var(--ink-2)] hover:bg-[var(--rule-2)]'} ${i < options.length - 1 ? 'border-r border-[var(--rule)]' : ''}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
