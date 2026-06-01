import { forwardRef, type InputHTMLAttributes } from 'react'

export interface RadioProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { label, className = '', ...rest }, ref
) {
  return (
    <label className={`inline-flex items-center gap-1.5 text-[11px] font-mono text-[var(--ink-2)] cursor-pointer select-none ${className}`}>
      <span className="relative">
        <input ref={ref} type="radio" className="peer sr-only" {...rest} />
        <span className="block w-[14px] h-[14px] border border-[var(--rule)] rounded-full bg-[var(--surface)] peer-checked:border-[var(--ink)] transition-all" />
        <span className="absolute top-[4px] left-[4px] w-[6px] h-[6px] bg-[var(--ink)] rounded-full hidden peer-checked:block" />
      </span>
      {label}
    </label>
  )
})
