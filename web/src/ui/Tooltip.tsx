import { useState, isValidElement, type ReactNode } from 'react'

export function Tooltip({ content, children }: { content: ReactNode; children: React.ReactElement }) {
  const [show, setShow] = useState(false)
  if (!isValidElement(children)) return children

  return (
    <span className="relative inline-block" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <span className="absolute -top-2 left-1/2 -translate-x-1/2 -translate-y-full bg-[var(--ink)] text-[var(--bg)] font-mono text-[10px] px-2 py-1 rounded whitespace-nowrap z-50 shadow-[0_2px_8px_rgba(0,0,0,0.15)]">
          {content}
        </span>
      )}
    </span>
  )
}
