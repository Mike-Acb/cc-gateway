// Global dialog system: replaces window.confirm/alert/prompt with
// a Promise-based, ESC-closable, theme-consistent modal.
//
// Usage (in any component/handler):
//   await dialog.alert('操作完成')
//   const ok = await dialog.confirm('删除 X？', { danger: true })
//   const name = await dialog.prompt('输入名称', { initial: 'foo' })
//
// Host: render <DialogHost/> once near the root of App.

import { useEffect, useState, type ReactNode, type KeyboardEvent as ReactKeyEvent } from 'react'
import { Button } from './Button'
import { Input } from './Field'

type DialogKind = 'alert' | 'confirm' | 'prompt'

interface BaseRequest {
  id: number
  kind: DialogKind
  title: ReactNode
  body: ReactNode
  okLabel: string
  cancelLabel: string
  danger: boolean
  initial?: string
  resolve: (v: unknown) => void
}

type Listener = (reqs: BaseRequest[]) => void

let seq = 0
const queue: BaseRequest[] = []
const listeners = new Set<Listener>()

function emit() {
  for (const l of listeners) l([...queue])
}

function push(
  kind: DialogKind,
  title: ReactNode,
  body: ReactNode,
  opts: { okLabel?: string; cancelLabel?: string; danger?: boolean; initial?: string } = {},
): Promise<unknown> {
  return new Promise((resolve) => {
    const req: BaseRequest = {
      id: ++seq,
      kind,
      title,
      body,
      okLabel: opts.okLabel ?? (kind === 'alert' ? '知道了' : '确定'),
      cancelLabel: opts.cancelLabel ?? '取消',
      danger: !!opts.danger,
      initial: opts.initial,
      resolve,
    }
    queue.push(req)
    emit()
  })
}

export const dialog = {
  alert(body: ReactNode, opts: { title?: ReactNode; okLabel?: string } = {}): Promise<void> {
    return push('alert', opts.title ?? '提示', body, opts) as Promise<void>
  },
  confirm(
    body: ReactNode,
    opts: { title?: ReactNode; okLabel?: string; cancelLabel?: string; danger?: boolean } = {},
  ): Promise<boolean> {
    return push('confirm', opts.title ?? '请确认', body, opts) as Promise<boolean>
  },
  prompt(
    body: ReactNode,
    opts: { title?: ReactNode; okLabel?: string; cancelLabel?: string; initial?: string } = {},
  ): Promise<string | null> {
    return push('prompt', opts.title ?? '输入', body, opts) as Promise<string | null>
  },
}

function useQueue() {
  const [items, set] = useState<BaseRequest[]>([])
  useEffect(() => {
    const fn: Listener = (arr) => set(arr)
    listeners.add(fn)
    fn([...queue])
    return () => { listeners.delete(fn) }
  }, [])
  return items
}

function resolveTop(value: unknown) {
  const top = queue.shift()
  if (top) top.resolve(value)
  emit()
}

function DialogCard({ req }: { req: BaseRequest }) {
  const [val, setVal] = useState<string>(req.initial ?? '')

  useEffect(() => {
    setVal(req.initial ?? '')
  }, [req.id, req.initial])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (req.kind === 'alert') resolveTop(undefined)
        else if (req.kind === 'confirm') resolveTop(false)
        else resolveTop(null)
      } else if (e.key === 'Enter' && req.kind !== 'prompt') {
        // 提交（prompt 需要允许 Enter 在 Input 内换行/触发，单独在 onKeyDown 处理）
        if (req.kind === 'alert') resolveTop(undefined)
        else resolveTop(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [req.id, req.kind])

  function onPromptKey(e: ReactKeyEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      resolveTop(val)
    }
  }

  function onOk() {
    if (req.kind === 'alert') resolveTop(undefined)
    else if (req.kind === 'confirm') resolveTop(true)
    else resolveTop(val)
  }
  function onCancel() {
    if (req.kind === 'alert') resolveTop(undefined)
    else if (req.kind === 'confirm') resolveTop(false)
    else resolveTop(null)
  }

  return (
    <>
      <div
        className="fixed inset-0 bg-black/30 z-[90]"
        onClick={onCancel}
      />
      <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none px-4">
        <div
          role="dialog"
          aria-modal="true"
          className="bg-[var(--surface)] border border-[var(--rule)] shadow-[0_8px_32px_rgba(0,0,0,0.15)] w-full max-w-md pointer-events-auto"
        >
          <div className="flex items-center border-b border-[var(--rule)] px-4 py-3">
            <strong className="flex-1 font-serif font-normal text-[15px]">{req.title}</strong>
            <button
              onClick={onCancel}
              className="text-[var(--ink-3)] hover:text-[var(--ink)] w-6 h-6 grid place-items-center"
              aria-label="close"
            >×</button>
          </div>

          <div className="px-4 py-4 text-[13px] text-[var(--ink)] leading-relaxed whitespace-pre-line">
            {req.body}
            {req.kind === 'prompt' && (
              <div className="mt-3">
                <Input
                  autoFocus
                  value={val}
                  onChange={(e) => setVal(e.target.value)}
                  onKeyDown={onPromptKey}
                  className="w-full"
                />
              </div>
            )}
          </div>

          <div className="border-t border-[var(--rule)] px-4 py-3 flex gap-2 justify-end">
            {req.kind !== 'alert' && (
              <Button variant="ghost" onClick={onCancel}>{req.cancelLabel}</Button>
            )}
            <Button
              variant={req.danger ? 'danger' : 'primary'}
              onClick={onOk}
              autoFocus={req.kind !== 'prompt'}
            >
              {req.okLabel}
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}

export function DialogHost() {
  const items = useQueue()
  if (items.length === 0) return null
  // 只渲染最上面一个（栈式），后续的等前面的关闭后再显示。
  const top = items[0]
  return <DialogCard key={top.id} req={top} />
}
