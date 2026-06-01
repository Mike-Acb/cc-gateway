import { useEffect, type ReactNode } from 'react'

export function Drawer({ open, title, onClose, children, footer, width = 520 }: {
  open: boolean
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <>
      <div className={`fixed inset-0 bg-black/30 z-40 transition-opacity ${open ? 'opacity-100' : 'opacity-0 pointer-events-none'}`} onClick={onClose} />
      <aside
        style={{ width: `min(100vw, ${width}px)` }}
        className={`fixed top-0 right-0 bottom-0 max-w-full bg-[var(--surface)] border-l border-[var(--rule)] z-50 flex flex-col transition-transform ${open ? 'translate-x-0' : 'translate-x-full'}`}
      >
        <div className="flex items-center border-b border-[var(--rule)] px-4 py-3">
          <strong className="flex-1 font-serif font-normal text-[16px]">{title}</strong>
          <button onClick={onClose} className="text-[var(--ink-3)] hover:text-[var(--ink)] w-6 h-6 grid place-items-center">×</button>
        </div>
        <div className="overflow-auto p-4 flex-1">{children}</div>
        {footer && <div className="border-t border-[var(--rule)] px-4 py-3 flex gap-2 justify-end">{footer}</div>}
      </aside>
    </>
  )
}
