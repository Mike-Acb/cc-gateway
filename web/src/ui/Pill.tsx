type PillTone = 'ok' | 'warn' | 'err' | 'info' | 'mute' | 'accent'
const tones: Record<PillTone, string> = {
  ok: 'bg-[#e7f1ec] text-[var(--ok)]',
  warn: 'bg-[#fbefd7] text-[var(--warn)]',
  err: 'bg-[#fbe4e4] text-[var(--err)]',
  info: 'bg-[#e6edf4] text-[var(--info)]',
  mute: 'bg-[var(--mute-bg)] text-[var(--ink-2)]',
  accent: 'bg-[#fbe4e4] text-[var(--accent)]',
}
export function Pill({ tone = 'mute', children }: { tone?: PillTone; children: React.ReactNode }) {
  return <span className={`inline-block px-2 py-[2px] rounded text-[10px] uppercase tracking-wider font-mono ${tones[tone]}`}>{children}</span>
}
