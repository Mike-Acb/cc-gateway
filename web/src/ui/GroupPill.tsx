import { resolveGroupColor } from './groupPalette'

/**
 * 账号组 pill。
 * - id=null → 灰底 "共享池" (与 mute 语义一致,代表未关联组)
 * - 有 color (DB 显式指定) → 用调色板对应色
 * - 没 color → 按组名哈希落到 10 色之一
 *
 * CJK 4-6 字单行不折:whitespace-nowrap + min-w 由调用方在列定义里给。
 */
export function GroupPill({
  id,
  name,
  color,
}: {
  id: string | null
  name: string | null
  color?: string | null
}) {
  if (!id) {
    return (
      <span className="inline-block px-2 py-[2px] rounded text-[11px] font-mono whitespace-nowrap bg-[var(--mute-bg)] text-[var(--ink-2)]">
        共享池
      </span>
    )
  }
  const label = name ?? id.slice(0, 6)
  const c = resolveGroupColor({ color, name: label })
  return (
    <span
      className="inline-block px-2 py-[2px] rounded text-[11px] font-mono whitespace-nowrap"
      style={{ background: c.bg, color: c.fg }}
      title={label}
    >
      {label}
    </span>
  )
}
