import { forwardRef, type InputHTMLAttributes } from 'react'

export interface SwitchProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
}

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { label, className = '', ...rest }, ref
) {
  return (
    <label className={`inline-flex items-center gap-2 text-[11px] font-mono text-[var(--ink-2)] cursor-pointer ${className}`}>
      <span className="relative inline-block">
        <input ref={ref} type="checkbox" className="peer sr-only" {...rest} />
        <span className="block w-7 h-4 rounded-full bg-[var(--rule)] peer-checked:bg-[var(--ink)] transition-colors" />
        <span className="absolute top-[1px] left-[1px] w-[14px] h-[14px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.2)] peer-checked:translate-x-3 transition-transform" />
      </span>
      {label}
    </label>
  )
})
