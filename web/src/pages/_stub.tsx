type Props = { name: string; note?: string }

export function PageStub({ name, note }: Props) {
  return (
    <section className="max-w-[880px]">
      <h1 className="text-[26px] font-serif mb-2">{name}</h1>
      <p className="text-[13px] text-[var(--mute)] mb-6">占位页 — 由后续分支实现。</p>
      {note && <p className="text-[13px] text-[var(--ink-2)]">{note}</p>}
      <div className="mt-8 p-4 rounded-[6px] bg-[var(--surface-2)] border border-[var(--line)] text-[12px] text-[var(--mute)] font-mono">
        TODO — {name}
      </div>
    </section>
  )
}
