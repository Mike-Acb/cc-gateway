export function Chip({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <span className={`inline-block px-1.5 py-[1px] rounded-[3px] text-[10px] font-mono bg-[var(--mute-bg)] text-[var(--ink-2)] ${className}`}>{children}</span>
}
