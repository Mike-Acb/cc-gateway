import { useEffect, type ReactNode } from 'react'

export function Modal({ open, title, onClose, children, footer, size = 'md' }: {
  open: boolean
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'md' | 'lg'
}) {
  const widthCls = size === 'lg' ? 'max-w-3xl' : 'max-w-xl'
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none p-3 sm:p-4">
        <div className={`bg-[var(--surface)] border border-[var(--rule)] shadow-[0_8px_32px_rgba(0,0,0,0.15)] w-full ${widthCls} max-h-[85vh] sm:max-h-[80vh] flex flex-col pointer-events-auto rounded`}>
          <div className="flex items-center border-b border-[var(--rule)] px-4 py-3">
            <strong className="flex-1 font-serif font-normal text-[16px]">{title}</strong>
            <button onClick={onClose} className="text-[var(--ink-3)] hover:text-[var(--ink)] w-6 h-6 grid place-items-center">×</button>
          </div>
          <div className="overflow-auto p-4 flex-1">{children}</div>
          {footer && <div className="border-t border-[var(--rule)] px-4 py-3 flex gap-2 justify-end">{footer}</div>}
        </div>
      </div>
    </>
  )
}
