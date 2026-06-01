import type { ReactNode } from 'react'

export function FilterBar({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-wrap gap-2 items-center p-2.5 bg-[var(--surface)] border border-[var(--rule)] rounded ${className}`}>
      {children}
    </div>
  )
}
