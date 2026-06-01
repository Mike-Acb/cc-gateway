import { forwardRef, type InputHTMLAttributes } from 'react'

export interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, className = '', ...rest }, ref
) {
  return (
    <label className={`inline-flex items-center gap-1.5 text-[11px] font-mono text-[var(--ink-2)] cursor-pointer select-none ${className}`}>
      <span className="relative">
        <input ref={ref} type="checkbox" className="peer sr-only" {...rest} />
        <span className="block w-[14px] h-[14px] border rounded-[2px] border-[var(--rule)] bg-[var(--surface)] peer-checked:bg-[var(--ink)] peer-checked:border-[var(--ink)] transition-all" />
        <span className="absolute top-[2px] left-[4px] w-[4px] h-[7px] border-[1.5px] border-t-0 border-l-0 border-[var(--bg)] rotate-[40deg] hidden peer-checked:block" />
      </span>
      {label}
    </label>
  )
})
