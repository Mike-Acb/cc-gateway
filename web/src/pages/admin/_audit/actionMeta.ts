// Audit action → Chinese label + Pill tone mapping.
// Keep tones aligned with @/ui Pill: 'ok' | 'warn' | 'err' | 'info' | 'mute' | 'accent'.

type Tone = 'ok' | 'warn' | 'err' | 'info' | 'mute' | 'accent'
export type ActionMeta = { label: string; tone: Tone }

export const AUDIT_ACTION_META: Record<string, ActionMeta> = {
  // plan
  'plan.create':                 { label: '创建套餐', tone: 'accent' },
  'plan.update':                 { label: '修改套餐', tone: 'info' },
  'plan.delete':                 { label: '删除套餐', tone: 'err' },
  'plan.assign_user':            { label: '分配套餐', tone: 'info' },
  // oauth_account
  'account.create':              { label: '新增账号', tone: 'accent' },
  'account.update':              { label: '修改账号', tone: 'info' },
  'account.enable':              { label: '启用账号', tone: 'ok' },
  'account.disable':             { label: '禁用账号', tone: 'warn' },
  'account.delete':              { label: '删除账号', tone: 'err' },
  'account.reset_token':         { label: '重置 Token', tone: 'warn' },
  'oauth_account.create':        { label: '新增账号', tone: 'accent' },
  'oauth_account.update':        { label: '修改账号', tone: 'info' },
  'oauth_account.enable':        { label: '启用账号', tone: 'ok' },
  'oauth_account.disable':       { label: '禁用账号', tone: 'warn' },
  'oauth_account.delete':        { label: '删除账号', tone: 'err' },
  // group
  'group.create':                { label: '创建账号组', tone: 'accent' },
  'group.update':                { label: '修改账号组', tone: 'info' },
  'group.delete':                { label: '删除账号组', tone: 'err' },
  'group.assign_account':        { label: '账号换组', tone: 'info' },
  'group.assign_client':         { label: '客户端换组', tone: 'info' },
  // user
  'user.register':               { label: '用户注册', tone: 'mute' },
  'user.ban':                    { label: '封禁用户', tone: 'err' },
  'user.unban':                  { label: '解封用户', tone: 'ok' },
  'user.grant_role':             { label: '提升管理员', tone: 'warn' },
  'user.revoke_role':            { label: '撤销管理员', tone: 'warn' },
  'user.delete':                 { label: '删除用户', tone: 'err' },
  // subscription
  'subscription.grant':          { label: '授予订阅', tone: 'ok' },
  'subscription.revoke':         { label: '撤销订阅', tone: 'warn' },
  'subscription.adjust_balance': { label: '调整余额', tone: 'info' },
  // client
  'client.create':               { label: '新建 Client', tone: 'accent' },
  'client.update':               { label: '修改 Client', tone: 'info' },
  'client.revoke':               { label: '撤销 Client', tone: 'warn' },
  'client.rotate_key':           { label: '轮换 Key', tone: 'warn' },
  'client.delete':               { label: '删除 Client', tone: 'err' },
  // system / campaign
  'system.reload':               { label: '重载配置', tone: 'mute' },
  'system.campaign_create':      { label: '新建活动', tone: 'accent' },
  'system.campaign_update':      { label: '修改活动', tone: 'info' },
  'campaign.create':             { label: '新建活动', tone: 'accent' },
  'campaign.update':             { label: '修改活动', tone: 'info' },
  'campaign.delete':             { label: '删除活动', tone: 'err' },
}

export function actionMeta(action: string): ActionMeta {
  return AUDIT_ACTION_META[action] ?? { label: action, tone: 'mute' }
}

// Distinct resource_type values observed in backend.
export const AUDIT_RESOURCE_TYPES = [
  'plan',
  'user',
  'oauth_account',
  'group',
  'subscription',
  'client',
  'campaign',
  'system',
] as const
