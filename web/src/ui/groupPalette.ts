// 账号组调色板。
// 设计原则:
//   * 与 tokens.css 现有 ink/surface 在 #faf9f5 米白背景下饱和度对齐(都是低饱和柔色),
//     不和现有 ok/warn/err/info 语义色撞;
//   * 10 种色相覆盖一圈色轮(蓝/青/绿/橄榄/橘黄/橘红/红/玫红/紫/灰蓝),
//     相邻组随便挑都能一眼区分;
//   * bg 是文字色的浅化(L 约 92,S 约 30),保证文本对比 ≥ AA;
//   * 故意不渐变(memory: 禁渐变),只纯色块。

export type GroupColorKey =
  | 'slate'
  | 'azure'
  | 'teal'
  | 'sage'
  | 'olive'
  | 'amber'
  | 'rust'
  | 'rose'
  | 'plum'
  | 'indigo'

export interface GroupColor {
  key: GroupColorKey
  label: string  // 中文短名,管理端 swatch 旁显示
  bg: string     // pill 背景
  fg: string     // pill 文字
  dot: string    // 选色器 swatch 圆点
}

export const GROUP_COLORS: readonly GroupColor[] = [
  { key: 'slate',  label: '石板蓝', bg: '#e3e8ef', fg: '#3b4a5a', dot: '#5b6b80' },
  { key: 'azure',  label: '海蓝',   bg: '#e6edf4', fg: '#245a8a', dot: '#3a7ab4' },
  { key: 'teal',   label: '青碧',   bg: '#dbecea', fg: '#1f6b66', dot: '#2c8f87' },
  { key: 'sage',   label: '苔绿',   bg: '#e7f1ec', fg: '#2d7a5f', dot: '#3f9d7a' },
  { key: 'olive',  label: '橄榄',   bg: '#ecedd6', fg: '#5d6a1f', dot: '#7e8f31' },
  { key: 'amber',  label: '琥珀',   bg: '#fbefd7', fg: '#8a5410', dot: '#d97706' },
  { key: 'rust',   label: '赭红',   bg: '#f5e2d4', fg: '#8a3d1a', dot: '#b85622' },
  { key: 'rose',   label: '玫红',   bg: '#fbe4e4', fg: '#a02020', dot: '#c44444' },
  { key: 'plum',   label: '紫梅',   bg: '#ebe1ee', fg: '#6b2e7e', dot: '#9244a8' },
  { key: 'indigo', label: '靛蓝',   bg: '#e1e3f1', fg: '#3a3e8a', dot: '#5b60b8' },
] as const

const COLOR_MAP: Record<GroupColorKey, GroupColor> =
  Object.fromEntries(GROUP_COLORS.map((c) => [c.key, c])) as Record<GroupColorKey, GroupColor>

function isGroupColorKey(v: unknown): v is GroupColorKey {
  return typeof v === 'string' && v in COLOR_MAP
}

/**
 * 根据组名生成稳定 hash → 落到 GROUP_COLORS 索引。
 * 仅在组没显式指定 color 时兜底用。
 */
function hashColor(name: string): GroupColor {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return GROUP_COLORS[Math.abs(h) % GROUP_COLORS.length]
}

/**
 * 解析组的最终配色:
 *  - 数据库里有 color 字段且是合法 key → 用它
 *  - 否则按 name 哈希分配
 *  - 没传 name (id 也没匹配) → 兜底 'slate'
 */
export function resolveGroupColor(input: {
  color?: string | null
  name?: string | null
}): GroupColor {
  if (isGroupColorKey(input.color)) return COLOR_MAP[input.color]
  if (input.name && input.name.length > 0) return hashColor(input.name)
  return COLOR_MAP.slate
}
