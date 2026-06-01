import { query } from '../db.js'

// 与 web/src/ui/groupPalette.ts 的 GroupColorKey 保持一致。
// 服务端只做白名单校验,不关心具体色值。
const VALID_GROUP_COLORS = new Set([
  'slate', 'azure', 'teal', 'sage', 'olive',
  'amber', 'rust', 'rose', 'plum', 'indigo',
])

function normalizeColor(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null
  return VALID_GROUP_COLORS.has(v) ? v : null
}

export type AccountGroup = {
  id: string
  name: string
  description: string | null
  is_default: boolean
  cost_multiplier: number
  color: string | null
  created_at: string
  updated_at: string
}

export type AccountGroupWithCounts = AccountGroup & {
  account_count: number
  client_count: number
}

export async function listGroups(): Promise<AccountGroupWithCounts[]> {
  const { rows } = await query<AccountGroupWithCounts>(
    `SELECT g.*,
            (SELECT COUNT(*)::int FROM oauth_accounts WHERE group_id = g.id) AS account_count,
            (SELECT COUNT(*)::int FROM clients WHERE group_id = g.id)        AS client_count
       FROM account_groups g
      ORDER BY g.is_default DESC, g.name ASC`,
  )
  return rows
}

export async function getDefaultGroupId(): Promise<string> {
  const { rows } = await query<{ id: string }>(
    'SELECT id FROM account_groups WHERE is_default = true LIMIT 1',
  )
  if (rows.length === 0) throw new Error('default group missing')
  return rows[0].id
}

export async function createGroup(input: {
  name: string
  description?: string | null
  cost_multiplier?: number | null
  color?: string | null
}): Promise<AccountGroup> {
  const mult =
    input.cost_multiplier === undefined || input.cost_multiplier === null
      ? null
      : Number(input.cost_multiplier)
  const { rows } = await query<AccountGroup>(
    `INSERT INTO account_groups (name, description, cost_multiplier, color)
       VALUES ($1, $2, COALESCE($3, 1.000), $4)
       RETURNING *`,
    [
      input.name,
      input.description ?? null,
      Number.isFinite(mult as number) ? mult : null,
      normalizeColor(input.color),
    ],
  )
  return rows[0]
}

export async function updateGroup(
  id: string,
  input: {
    name?: string
    description?: string | null
    cost_multiplier?: number | null
    // 'color' missing → 不动;明确传 null / '' → 清空;字符串非法 → 服务端忽略保持原值
    color?: string | null
  },
): Promise<AccountGroup> {
  const mult =
    input.cost_multiplier === undefined || input.cost_multiplier === null
      ? null
      : Number(input.cost_multiplier)
  // color 三态:undefined 不改 / 显式 null|'' 清空 / 合法 key 写入。
  const colorChanging = Object.prototype.hasOwnProperty.call(input, 'color')
  const colorValue: string | null = colorChanging
    ? (input.color === null || input.color === '' ? null : normalizeColor(input.color))
    : null
  const { rows } = await query<AccountGroup>(
    `UPDATE account_groups
       SET name = COALESCE($2, name),
           description = COALESCE($3, description),
           cost_multiplier = COALESCE($4, cost_multiplier),
           color = CASE WHEN $5::boolean THEN $6 ELSE color END,
           updated_at = now()
     WHERE id = $1 RETURNING *`,
    [
      id,
      input.name ?? null,
      input.description ?? null,
      Number.isFinite(mult as number) ? mult : null,
      colorChanging,
      colorValue,
    ],
  )
  if (rows.length === 0) throw new Error('group not found')
  return rows[0]
}

export async function deleteGroup(id: string): Promise<void> {
  const { rows } = await query<{ is_default: boolean }>(
    'SELECT is_default FROM account_groups WHERE id = $1',
    [id],
  )
  if (rows.length === 0) throw new Error('group not found')
  if (rows[0].is_default) throw new Error('cannot delete default group')
  // Push any clients in the doomed group back to the default group.
  const fallback = await getDefaultGroupId()
  await query('UPDATE clients SET group_id = $1 WHERE group_id = $2', [fallback, id])
  // Detach oauth_accounts from the deleted group (NULL = shared pool).
  await query('UPDATE oauth_accounts SET group_id = NULL WHERE group_id = $1', [id])
  await query('DELETE FROM account_groups WHERE id = $1', [id])
}

export async function setAccountGroup(
  accountId: string,
  groupId: string | null,
): Promise<void> {
  await query('UPDATE oauth_accounts SET group_id = $2, updated_at = now() WHERE id = $1', [
    accountId,
    groupId,
  ])
}

export async function setClientGroup(
  clientId: string,
  groupId: string | null,
): Promise<void> {
  await query('UPDATE clients SET group_id = $2, updated_at = now() WHERE id = $1', [
    clientId,
    groupId,
  ])
}
