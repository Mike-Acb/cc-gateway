import { forwardRef, type ButtonHTMLAttributes } from 'react'

type Variant = 'default' | 'primary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', className = '', ...rest }, ref
) {
  const base = 'inline-flex items-center gap-1.5 font-mono font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed border'
  const sz = size === 'sm' ? 'text-[11px] px-2 py-1' : 'text-[12px] px-3 py-1.5'
  const v = {
    default: 'bg-white border-[var(--rule)] text-[var(--ink)] hover:bg-[var(--rule-2)]',
    primary: 'bg-[var(--ink)] border-[var(--ink)] text-[var(--bg)] hover:bg-black',
    ghost:   'bg-transparent border-transparent text-[var(--ink-2)] hover:bg-[var(--rule-2)]',
    danger:  'bg-white border-[var(--err)] text-[var(--err)] hover:bg-[#fbe4e4]',
  }[variant]
  return <button ref={ref} className={`${base} ${sz} ${v} ${className}`} {...rest} />
})
