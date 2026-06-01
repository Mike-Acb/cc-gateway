import type { InputHTMLAttributes, SelectHTMLAttributes, ReactNode } from 'react'

interface FieldProps { label: string; hint?: string; children: ReactNode; className?: string }
export function Field({ label, hint, children, className = '' }: FieldProps) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <span className="text-[10px] uppercase tracking-wider font-mono text-[var(--ink-3)]">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-[var(--ink-3)]">{hint}</span>}
    </div>
  )
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-1.5 font-mono text-[12px] text-[var(--ink)] rounded focus:outline-none focus:border-[var(--ink)] focus:shadow-[0_0_0_3px_rgba(26,26,26,0.06)] transition-shadow ${props.className ?? ''}`}
    />
  )
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, ...rest } = props
  return (
    <div className="relative inline-block w-full">
      <select
        {...rest}
        className={`appearance-none w-full border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-1.5 pr-7 font-mono text-[12px] text-[var(--ink)] rounded focus:outline-none focus:border-[var(--ink)] focus:shadow-[0_0_0_3px_rgba(26,26,26,0.06)] transition-shadow ${className ?? ''}`}
      />
      <svg
        aria-hidden
        viewBox="0 0 10 6"
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-2.5 h-1.5 text-[var(--ink-2)]"
      >
        <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}
