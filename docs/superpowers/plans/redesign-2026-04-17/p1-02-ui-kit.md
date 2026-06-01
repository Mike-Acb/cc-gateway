# P1 · #2 feat/ui-kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把原型里用到的 15 个 UI 组件落到 `web/src/ui/`，建立统一设计 token，让后续所有页面（Phase 2/3）直接复用。

**Architecture:** 不依赖任何 UI 组件库（不装 shadcn、不装 antd）。自己写——组件都是原型里已经验证过的纯 CSS + 最少 React。用 Tailwind v4 的 `@theme` 管 tokens；组件风格跟原型 1:1。

**Tech Stack:** React 19 / TailwindCSS v4 / TypeScript。

**Prereqs:** #1 `feat/gwbk-infra` 已合并。

---

## File Structure

**Create:**
- `web/src/ui/tokens.css` — 色板 / 字体 / 间距 token（Tailwind v4 `@theme`）
- `web/src/ui/Button.tsx`
- `web/src/ui/Checkbox.tsx`
- `web/src/ui/Radio.tsx`
- `web/src/ui/Switch.tsx`
- `web/src/ui/Segmented.tsx`
- `web/src/ui/Field.tsx`
- `web/src/ui/FilterBar.tsx`
- `web/src/ui/Pill.tsx`
- `web/src/ui/Chip.tsx`
- `web/src/ui/Table.tsx`
- `web/src/ui/StatGrid.tsx`
- `web/src/ui/Modal.tsx`
- `web/src/ui/Drawer.tsx`
- `web/src/ui/Tooltip.tsx`
- `web/src/ui/chart/StackedBars.tsx`
- `web/src/ui/chart/MultiLine.tsx`
- `web/src/ui/chart/SparkLine.tsx`
- `web/src/ui/chart/Bars.tsx`
- `web/src/ui/index.ts` — 统一 re-export
- `web/src/pages/DevKit.tsx` — 开发预览页，挂到 `/dev/kit` 路由（build-only，生产不暴露）

**Modify:**
- `web/src/index.css` — `@import 'ui/tokens.css'`
- `web/src/router.tsx` — `/dev/kit` 路由

---

## Tasks

### Task 1 · Tokens

- [ ] **Step 1: 新建 `web/src/ui/tokens.css`**

```css
@layer base {
  :root {
    --bg:        #faf9f5;
    --surface:   #ffffff;
    --ink:       #1a1a1a;
    --ink-2:     #666666;
    --ink-3:     #999999;
    --rule:      #e5e2d8;
    --rule-2:    #f2ede0;
    --mute-bg:   #f2ede0;
    --accent:    #c44444;
    --ok:        #2d7a5f;
    --warn:      #d97706;
    --info:      #245a8a;
    --err:       #a02020;
    --font-serif: 'Instrument Serif', Georgia, serif;
    --font-sans:  'IBM Plex Sans', -apple-system, sans-serif;
    --font-mono:  'JetBrains Mono', 'IBM Plex Mono', ui-monospace, monospace;
  }
  html, body { background: var(--bg); color: var(--ink); font-family: var(--font-sans); font-size: 13px; }
}
```

- [ ] **Step 2: 在 `web/src/index.css` 顶部 import**

```css
@import './ui/tokens.css';
/* ... rest of existing index.css ... */
```

- [ ] **Step 3: 加字体引入（`web/index.html` `<head>`）**

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

- [ ] **Step 4: Commit**

```bash
git add web/src/ui/tokens.css web/src/index.css web/index.html
git commit -m "feat(ui): design tokens and fonts"
```

---

### Task 2 · Button

- [ ] **Step 1: `web/src/ui/Button.tsx`**

```tsx
import { ButtonHTMLAttributes, forwardRef } from 'react'

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
```

- [ ] **Step 2: Commit**

```bash
git add web/src/ui/Button.tsx
git commit -m "feat(ui): Button"
```

---

### Task 3 · Checkbox / Radio / Switch

- [ ] **Step 1: `Checkbox.tsx`**

```tsx
import { InputHTMLAttributes, forwardRef } from 'react'

export interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, className = '', ...rest }, ref
) {
  return (
    <label className={`inline-flex items-center gap-1.5 text-[11px] font-mono text-[var(--ink-2)] cursor-pointer select-none ${className}`}>
      <span className="relative">
        <input ref={ref} type="checkbox" className="peer sr-only" {...rest} />
        <span className="block w-[14px] h-[14px] border rounded-[2px] border-[var(--rule)] bg-[var(--surface)] peer-checked:bg-[var(--ink)] peer-checked:border-[var(--ink)] transition-all" />
        <span className="absolute top-[2px] left-[4px] w-[4px] h-[7px] border-[1.5px] border-t-0 border-l-0 border-[var(--bg)] rotate-[40deg] hidden peer-checked:block" />
      </span>
      {label}
    </label>
  )
})
```

- [ ] **Step 2: `Radio.tsx`**

```tsx
import { InputHTMLAttributes, forwardRef } from 'react'

export interface RadioProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { label, className = '', ...rest }, ref
) {
  return (
    <label className={`inline-flex items-center gap-1.5 text-[11px] font-mono text-[var(--ink-2)] cursor-pointer select-none ${className}`}>
      <span className="relative">
        <input ref={ref} type="radio" className="peer sr-only" {...rest} />
        <span className="block w-[14px] h-[14px] border border-[var(--rule)] rounded-full bg-[var(--surface)] peer-checked:border-[var(--ink)] transition-all" />
        <span className="absolute top-[4px] left-[4px] w-[6px] h-[6px] bg-[var(--ink)] rounded-full hidden peer-checked:block" />
      </span>
      {label}
    </label>
  )
})
```

- [ ] **Step 3: `Switch.tsx`**

```tsx
import { InputHTMLAttributes, forwardRef } from 'react'

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
```

- [ ] **Step 4: Commit**

```bash
git add web/src/ui/Checkbox.tsx web/src/ui/Radio.tsx web/src/ui/Switch.tsx
git commit -m "feat(ui): Checkbox / Radio / Switch"
```

---

### Task 4 · Segmented / Field / FilterBar

- [ ] **Step 1: `Segmented.tsx`**

```tsx
export interface SegmentedOption<T extends string> { value: T; label: string }
export interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[]
  value: T
  onChange: (v: T) => void
  className?: string
}

export function Segmented<T extends string>({ options, value, onChange, className = '' }: SegmentedProps<T>) {
  return (
    <div className={`inline-flex border border-[var(--rule)] rounded-[3px] overflow-hidden font-mono text-[11px] ${className}`}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`px-3 py-1 transition-colors ${value === o.value ? 'bg-[var(--ink)] text-[var(--bg)]' : 'bg-[var(--surface)] text-[var(--ink-2)] hover:bg-[var(--rule-2)]'} ${i < options.length - 1 ? 'border-r border-[var(--rule)]' : ''}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: `Field.tsx`**

```tsx
import { InputHTMLAttributes, SelectHTMLAttributes, ReactNode } from 'react'

interface FieldProps { label: string; hint?: string; children: ReactNode; className?: string }
export function Field({ label, hint, children, className = '' }: FieldProps) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <span className="text-[10px] uppercase tracking-wider font-mono text-[var(--ink-3)]">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-[var(--ink-3)]">{hint}</span>}
    </div>
  )
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-1.5 font-mono text-[12px] text-[var(--ink)] rounded focus:outline-none focus:border-[var(--ink)] focus:shadow-[0_0_0_3px_rgba(26,26,26,0.06)] transition-shadow ${props.className ?? ''}`}
    />
  )
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`appearance-none border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-1.5 pr-6 font-mono text-[12px] text-[var(--ink)] rounded focus:outline-none focus:border-[var(--ink)] focus:shadow-[0_0_0_3px_rgba(26,26,26,0.06)] transition-shadow bg-[linear-gradient(45deg,transparent_50%,var(--ink-2)_50%),linear-gradient(135deg,var(--ink-2)_50%,transparent_50%)] bg-[position:calc(100%-12px)_50%,calc(100%-8px)_50%] bg-[size:4px_4px] bg-no-repeat ${props.className ?? ''}`}
    />
  )
}
```

- [ ] **Step 3: `FilterBar.tsx`**

```tsx
import { ReactNode } from 'react'

export function FilterBar({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-wrap gap-2 items-center p-2.5 bg-[var(--surface)] border border-[var(--rule)] rounded ${className}`}>
      {children}
    </div>
  )
}
```

- [ ] **Step 4: Commit**

```bash
git add web/src/ui/Segmented.tsx web/src/ui/Field.tsx web/src/ui/FilterBar.tsx
git commit -m "feat(ui): Segmented / Field / FilterBar"
```

---

### Task 5 · Pill / Chip

- [ ] **Step 1: `Pill.tsx`**

```tsx
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
```

- [ ] **Step 2: `Chip.tsx`**

```tsx
export function Chip({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <span className={`inline-block px-1.5 py-[1px] rounded-[3px] text-[10px] font-mono bg-[var(--mute-bg)] text-[var(--ink-2)] ${className}`}>{children}</span>
}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/ui/Pill.tsx web/src/ui/Chip.tsx
git commit -m "feat(ui): Pill / Chip"
```

---

### Task 6 · Table / StatGrid

- [ ] **Step 1: `Table.tsx`**

```tsx
import { ReactNode } from 'react'

export interface Column<T> {
  key: string
  header: ReactNode
  render: (row: T) => ReactNode
  className?: string
  style?: React.CSSProperties
}

export function Table<T extends { id?: string | number }>({
  rows, columns, onRowClick, emptyLabel = 'No rows.',
}: {
  rows: T[]
  columns: Column<T>[]
  onRowClick?: (row: T) => void
  emptyLabel?: string
}) {
  if (rows.length === 0) {
    return <div className="p-6 text-center text-[var(--ink-3)] text-[12px]">{emptyLabel}</div>
  }
  return (
    <table className="w-full border-collapse text-[12px]">
      <thead>
        <tr className="border-b border-[var(--rule)] text-left font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">
          {columns.map(c => <th key={c.key} className={`px-3 py-2 ${c.className ?? ''}`} style={c.style}>{c.header}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr
            key={(row.id ?? i) as any}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={`border-b border-[var(--rule)] ${onRowClick ? 'cursor-pointer hover:bg-[var(--rule-2)]' : ''}`}
          >
            {columns.map(c => <td key={c.key} className={`px-3 py-2 ${c.className ?? ''}`}>{c.render(row)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
```

- [ ] **Step 2: `StatGrid.tsx`**

```tsx
import { ReactNode } from 'react'

export interface StatItem { label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'warn' | 'err' | '' }
export function StatGrid({ items, cols = 4 }: { items: StatItem[]; cols?: 2 | 3 | 4 | 5 }) {
  const colsCls = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4', 5: 'grid-cols-5' }[cols]
  return (
    <div className={`grid gap-2.5 ${colsCls}`}>
      {items.map((it, i) => (
        <div key={i} className="bg-[var(--surface)] border border-[var(--rule)] p-3.5">
          <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">{it.label}</div>
          <div className={`font-serif text-[28px] leading-tight mt-1 tabular-nums ${it.tone === 'ok' ? 'text-[var(--ok)]' : it.tone === 'warn' ? 'text-[var(--warn)]' : it.tone === 'err' ? 'text-[var(--err)]' : ''}`}>
            {it.value}
          </div>
          {it.sub && <div className="text-[11px] text-[var(--ink-3)] mt-0.5">{it.sub}</div>}
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/ui/Table.tsx web/src/ui/StatGrid.tsx
git commit -m "feat(ui): Table / StatGrid"
```

---

### Task 7 · Modal / Drawer / Tooltip

- [ ] **Step 1: `Modal.tsx`**

```tsx
import { ReactNode, useEffect } from 'react'

export function Modal({ open, title, onClose, children, footer }: {
  open: boolean
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
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
      <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
        <div className="bg-[var(--surface)] border border-[var(--rule)] shadow-[0_8px_32px_rgba(0,0,0,0.15)] w-full max-w-xl max-h-[80vh] flex flex-col pointer-events-auto">
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
```

- [ ] **Step 2: `Drawer.tsx`**

```tsx
import { ReactNode, useEffect } from 'react'

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
        style={{ width }}
        className={`fixed top-0 right-0 bottom-0 bg-[var(--surface)] border-l border-[var(--rule)] z-50 flex flex-col transition-transform ${open ? 'translate-x-0' : 'translate-x-full'}`}
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
```

- [ ] **Step 3: `Tooltip.tsx`**

```tsx
import { ReactNode, useState, cloneElement, isValidElement } from 'react'

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
```

- [ ] **Step 4: Commit**

```bash
git add web/src/ui/Modal.tsx web/src/ui/Drawer.tsx web/src/ui/Tooltip.tsx
git commit -m "feat(ui): Modal / Drawer / Tooltip"
```

---

### Task 8 · Charts

- [ ] **Step 1: `chart/SparkLine.tsx`**

```tsx
export function SparkLine({ points, width = 600, height = 100, color = 'var(--ink)' }: {
  points: number[]
  width?: number
  height?: number
  color?: string
}) {
  if (points.length < 2) return null
  const max = Math.max(...points), min = Math.min(...points)
  const range = max - min || 1
  const stepX = width / (points.length - 1)
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(1)},${(height - (v - min) / range * (height - 10) - 4).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
      {[0, 0.25, 0.5, 0.75, 1].map(g => (
        <line key={g} x1={0} x2={width} y1={g * height} y2={g * height} stroke="var(--rule-2)" strokeWidth={0.5} />
      ))}
      <path d={d} stroke={color} strokeWidth={1.5} fill="none" />
    </svg>
  )
}
```

- [ ] **Step 2: `chart/Bars.tsx`**

```tsx
export function Bars({ points, width = 600, height = 100, color = 'var(--ink)' }: {
  points: number[]; width?: number; height?: number; color?: string
}) {
  const max = Math.max(...points, 1)
  const barW = width / points.length - 2
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
      {points.map((v, i) => (
        <rect key={i} x={i * (barW + 2)} y={height - (v / max) * (height - 4)} width={barW} height={(v / max) * (height - 4)} fill={color} />
      ))}
    </svg>
  )
}
```

- [ ] **Step 3: `chart/StackedBars.tsx`**

```tsx
import { useState } from 'react'

export interface StackedSeries { label: string; color: string; values: number[] }
export function StackedBars({ series, labels, width = 600, height = 160 }: {
  series: StackedSeries[]
  labels: string[]
  width?: number
  height?: number
}) {
  const n = labels.length
  const totals = Array.from({ length: n }, (_, i) => series.reduce((s, ser) => s + ser.values[i], 0))
  const max = Math.max(...totals, 1)
  const barW = width / n - 2
  const [tip, setTip] = useState<{ x: number; y: number; i: number } | null>(null)

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
        {labels.map((_, i) => {
          let y = height - 4
          const rects = series.slice().reverse().map((ser, k) => {
            const segH = (ser.values[i] / max) * (height - 8)
            y -= segH
            return <rect key={k} x={i * (barW + 2)} y={y} width={barW} height={segH} fill={ser.color} />
          })
          return (
            <g key={i}
              onMouseMove={(e) => {
                const svg = e.currentTarget.ownerSVGElement!
                const r = svg.getBoundingClientRect()
                setTip({ x: e.clientX - r.left, y: e.clientY - r.top, i })
              }}
              onMouseLeave={() => setTip(null)}
            >
              {rects}
              <rect x={i * (barW + 2)} y={0} width={barW + 2} height={height} fill="transparent" style={{ cursor: 'crosshair' }} />
            </g>
          )
        })}
      </svg>
      {tip && (
        <div
          className="absolute bg-[var(--ink)] text-[var(--bg)] font-mono text-[10px] px-2 py-1.5 rounded pointer-events-none z-50 shadow-[0_2px_8px_rgba(0,0,0,0.15)]"
          style={{ left: tip.x, top: tip.y - 8, transform: 'translate(-50%,-100%)' }}
        >
          <div className="font-bold mb-1">{labels[tip.i]}</div>
          {series.map(s => (
            <div key={s.label}>
              <span className="inline-block w-2 h-2 rounded-full mr-1 align-middle" style={{ background: s.color }} />
              {s.label}: <b>{s.values[tip.i]}</b>
            </div>
          ))}
          <div className="text-[var(--ink-3)] mt-1">total: <b className="text-white">{totals[tip.i]}</b></div>
        </div>
      )}
      <div className="mt-1 font-mono text-[10px] text-[var(--ink-3)]">
        {series.map(s => (
          <span key={s.label} className="mr-3 inline-flex items-center gap-1">
            <span className="inline-block w-2.5 h-2.5" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: `chart/MultiLine.tsx`**

```tsx
export interface LineSeries { label: string; color: string; points: number[] }
export function MultiLine({ series, width = 600, height = 160 }: {
  series: LineSeries[]
  width?: number
  height?: number
}) {
  const allValues = series.flatMap(s => s.points)
  if (allValues.length === 0) return null
  const max = Math.max(...allValues), min = Math.min(...allValues)
  const range = max - min || 1
  const len = series[0].points.length
  const stepX = width / (len - 1)

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
        {[0, 0.25, 0.5, 0.75, 1].map(g => (
          <line key={g} x1={0} x2={width} y1={g * height} y2={g * height} stroke="var(--rule-2)" strokeWidth={0.5} />
        ))}
        {series.map(s => {
          const d = s.points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(1)},${(height - (v - min) / range * (height - 10) - 4).toFixed(1)}`).join(' ')
          return <path key={s.label} d={d} stroke={s.color} strokeWidth={1.5} fill="none" />
        })}
      </svg>
      <div className="mt-1 font-mono text-[10px] text-[var(--ink-3)]">
        {series.map(s => (
          <span key={s.label} className="mr-3 inline-flex items-center gap-1">
            <span className="inline-block w-3 h-[2px]" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add web/src/ui/chart
git commit -m "feat(ui): chart components (Bars/SparkLine/StackedBars/MultiLine)"
```

---

### Task 9 · Index re-export + DevKit 预览页

- [ ] **Step 1: `web/src/ui/index.ts`**

```ts
export * from './Button'
export * from './Checkbox'
export * from './Radio'
export * from './Switch'
export * from './Segmented'
export * from './Field'
export * from './FilterBar'
export * from './Pill'
export * from './Chip'
export * from './Table'
export * from './StatGrid'
export * from './Modal'
export * from './Drawer'
export * from './Tooltip'
export { SparkLine } from './chart/SparkLine'
export { Bars } from './chart/Bars'
export { StackedBars } from './chart/StackedBars'
export { MultiLine } from './chart/MultiLine'
```

- [ ] **Step 2: `web/src/pages/DevKit.tsx`**

至少把每个组件渲染一次，标题 + 组件实例；目的是人工肉眼核对和后续调试。

```tsx
import { useState } from 'react'
import {
  Button, Checkbox, Radio, Switch, Segmented, Field, Input, Select, FilterBar,
  Pill, Chip, Table, StatGrid, Modal, Drawer, Tooltip,
  SparkLine, Bars, StackedBars, MultiLine,
} from '../ui'

export default function DevKit() {
  const [drawer, setDrawer] = useState(false)
  const [modal, setModal] = useState(false)
  const [seg, setSeg] = useState<'a' | 'b' | 'c'>('a')

  return (
    <div className="p-8 space-y-8 max-w-4xl">
      <h1 className="font-serif text-4xl">UI Kit</h1>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl">Buttons</h2>
        <div className="flex gap-2">
          <Button>Default</Button>
          <Button variant="primary">Primary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button disabled>Disabled</Button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl">Form controls</h2>
        <div className="flex gap-4 items-center">
          <Checkbox label="勾选" />
          <Radio name="r" label="Radio A" />
          <Radio name="r" label="Radio B" defaultChecked />
          <Switch label="开关" />
        </div>
        <Segmented options={[{value:'a',label:'A'},{value:'b',label:'B'},{value:'c',label:'C'}]} value={seg} onChange={setSeg} />
        <div className="grid grid-cols-2 gap-3 max-w-lg">
          <Field label="Input"><Input placeholder="hello" /></Field>
          <Field label="Select"><Select defaultValue="1"><option value="1">One</option><option value="2">Two</option></Select></Field>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl">Pill / Chip</h2>
        <div className="flex gap-2">
          <Pill tone="ok">ok</Pill>
          <Pill tone="warn">warn</Pill>
          <Pill tone="err">err</Pill>
          <Pill tone="info">info</Pill>
          <Pill tone="mute">mute</Pill>
          <Chip>chip</Chip>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl">StatGrid</h2>
        <StatGrid items={[
          { label: '账号', value: '12' },
          { label: 'QPS', value: '38.4' },
          { label: '可用', value: '98.7%', tone: 'ok' },
          { label: '错误', value: '0.3%', tone: 'err' },
        ]} />
      </section>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl">Charts</h2>
        <SparkLine points={[1,3,2,5,4,7,6,9]} />
        <Bars points={[2,4,6,3,5,8,7,9]} color="var(--info)" />
        <StackedBars
          labels={['Mo','Tu','We','Th','Fr','Sa','Su']}
          series={[
            { label: 'opus',   color: 'var(--ink)',    values: [5,7,8,6,9,4,10] },
            { label: 'sonnet', color: 'var(--info)',   values: [3,4,6,5,7,3,6] },
            { label: 'haiku',  color: 'var(--ink-3)',  values: [2,1,3,2,2,1,2] },
          ]}
        />
        <MultiLine series={[
          { label: 'p50', color: 'var(--ok)',     points: [100,110,90,120,115,108] },
          { label: 'p99', color: 'var(--accent)', points: [220,300,250,340,400,310] },
        ]} />
      </section>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl">Overlays</h2>
        <Button onClick={() => setDrawer(true)}>Open Drawer</Button>
        <Button onClick={() => setModal(true)}>Open Modal</Button>
        <Tooltip content="hello tip"><Button variant="ghost">hover me</Button></Tooltip>
        <Drawer open={drawer} title="Drawer" onClose={() => setDrawer(false)}>Drawer body.</Drawer>
        <Modal  open={modal}  title="Modal"  onClose={() => setModal(false)}>Modal body.</Modal>
      </section>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl">Table</h2>
        <FilterBar>
          <Input placeholder="搜索..." />
          <Button variant="primary">查询</Button>
        </FilterBar>
        <div className="bg-white border border-[var(--rule)]">
          <Table
            rows={[{id:1,name:'a',v:10},{id:2,name:'b',v:20}]}
            columns={[
              { key: 'name', header: 'Name', render: r => r.name },
              { key: 'v',    header: 'Value', render: r => <span className="font-mono">{r.v}</span> },
            ]}
          />
        </div>
      </section>
    </div>
  )
}
```

- [ ] **Step 3: 挂路由 `web/src/router.tsx`**

在 `<Routes>` 里加：

```tsx
import DevKit from './pages/DevKit'
// ...
<Route path="/dev/kit" element={<DevKit />} />
```

（不放在 `ProtectedRoute` 里，dev 路径不需要登录。）

- [ ] **Step 4: 本地启动 + 肉眼验证**

```bash
cd web && npm run dev
```

访问 `http://localhost:5173/dev/kit`：每个 section 能正常渲染，过 drawer/modal 能开关，图表能画。

- [ ] **Step 5: Commit**

```bash
git add web/src/ui/index.ts web/src/pages/DevKit.tsx web/src/router.tsx
git commit -m "feat(ui): DevKit preview page at /dev/kit"
```

---

### Task 10 · 合并

- [ ] **Step 1: 跑 lint + build 确保无 TS 报错**

```bash
cd web && npm run lint && npm run build
```

Expected：无 error。

- [ ] **Step 2: 部署到 gwbk 并访问 `https://gwbk.example.com/dev/kit`**

```bash
./scripts/deploy-gwbk.sh
```

- [ ] **Step 3: merge**

```bash
git checkout main && git merge --no-ff feat/ui-kit -m "merge: feat/ui-kit"
git branch -d feat/ui-kit
```

---

## Self-Review

- ✅ 15 个组件全部实现
- ✅ DevKit 页同时演示所有组件
- ✅ tokens.css 覆盖色板 / 字体 / 间距
- ✅ 无渐变色（符合 memory 要求）
- ✅ 类型签名一致（`Column<T>` / `SegmentedOption<T>` 泛型）

## Acceptance

1. `https://gwbk.example.com/dev/kit` 显示全部组件
2. 交互：Drawer / Modal / Segmented 切换正常
3. 图表悬停显示 tooltip
4. `npm run build` 无 TS 报错
