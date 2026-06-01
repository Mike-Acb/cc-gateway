import crypto from 'crypto'
import { query, DEPLOYMENT } from '../db.js'

// Process invite code binding (called during registration or within 5-day window)
export async function processInviteBinding(inviteeId: string, inviteCode: string): Promise<{ success: boolean; error?: string }> {
  // 1. Find invite code with campaign
  const ic = await query(
    `SELECT ic.id, ic.campaign_id, ic.owner_id, ic.max_uses, ic.used_count, ic.status,
            c.status AS campaign_status, c.end_at, c.bind_window,
            c.inviter_rewards, c.invitee_rewards
     FROM invite_codes ic
     JOIN campaigns c ON ic.campaign_id = c.id
     WHERE ic.code = $1`, [inviteCode])
  if (ic.rows.length === 0) return { success: false, error: 'Invalid invite code' }

  const invite = ic.rows[0]

  // 2. Validate
  if (invite.status !== 'active') return { success: false, error: 'Invite code is no longer active' }
  if (invite.campaign_status !== 'active') return { success: false, error: 'Campaign is not active' }
  if (invite.end_at && new Date(invite.end_at) < new Date()) return { success: false, error: 'Campaign has ended' }
  if (invite.used_count >= invite.max_uses) return { success: false, error: 'Invite code is exhausted' }
  if (invite.owner_id === inviteeId) return { success: false, error: 'Cannot use your own invite code' }

  // Check bind window (user must have registered within bind_window)
  const userResult = await query('SELECT created_at, invited_by FROM users WHERE id = $1 AND deployment = $2', [inviteeId, DEPLOYMENT])
  if (userResult.rows.length === 0) return { success: false, error: 'User not found' }
  if (userResult.rows[0].invited_by) return { success: false, error: 'Already bound to an invite code' }

  // Check if within bind window
  if (invite.bind_window) {
    const createdAt = new Date(userResult.rows[0].created_at)
    const windowResult = await query("SELECT ($1::timestamptz + $2::interval) AS deadline", [createdAt, invite.bind_window])
    if (new Date() > new Date(windowResult.rows[0].deadline)) {
      return { success: false, error: 'Bind window has expired' }
    }
  }

  // Check for duplicate binding
  const existing = await query('SELECT id FROM invite_bindings WHERE invitee_id = $1', [inviteeId])
  if (existing.rows.length > 0) return { success: false, error: 'Already bound' }

  // 3. Create binding
  const binding = await query(
    'INSERT INTO invite_bindings (invite_code_id, inviter_id, invitee_id) VALUES ($1, $2, $3) RETURNING id',
    [invite.id, invite.owner_id, inviteeId])

  // 4. Update invite code usage
  await query(
    `UPDATE invite_codes SET used_count = used_count + 1,
     status = CASE WHEN used_count + 1 >= max_uses THEN 'exhausted' ELSE status END
     WHERE id = $1`, [invite.id])
  await query('UPDATE campaigns SET current_uses = current_uses + 1 WHERE id = $1', [invite.campaign_id])
  await query('UPDATE users SET invited_by = $1, invite_bound_at = now() WHERE id = $2 AND deployment = $3', [invite.owner_id, inviteeId, DEPLOYMENT])

  // 5. Issue rewards
  const bindingId = binding.rows[0].id
  if (invite.inviter_rewards) {
    const rewards = typeof invite.inviter_rewards === 'string' ? JSON.parse(invite.inviter_rewards) : invite.inviter_rewards
    for (const r of rewards) {
      await issueReward(invite.owner_id, invite.campaign_id, bindingId, r)
    }
  }
  if (invite.invitee_rewards) {
    const rewards = typeof invite.invitee_rewards === 'string' ? JSON.parse(invite.invitee_rewards) : invite.invitee_rewards
    for (const r of rewards) {
      await issueReward(inviteeId, invite.campaign_id, bindingId, r)
    }
  }

  // Mark binding as rewarded
  await query("UPDATE invite_bindings SET status = 'rewarded' WHERE id = $1", [bindingId])

  return { success: true }
}

// Issue a single reward to a user
async function issueReward(userId: string, campaignId: string, bindingId: string, config: any): Promise<void> {
  const expiresAt = config.valid_days ? new Date(Date.now() + config.valid_days * 86400000) : null

  if (config.type === 'coupon') {
    const couponCode = 'CPN-' + crypto.randomBytes(6).toString('hex').toUpperCase()
    const coupon = await query(
      `INSERT INTO coupons (user_id, code, amount, min_order, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userId, couponCode, config.amount, config.min_order ?? 0, expiresAt ?? new Date(Date.now() + 30 * 86400000)])
    await query(
      `INSERT INTO rewards (user_id, campaign_id, binding_id, type, coupon_id, expires_at)
       VALUES ($1, $2, $3, 'coupon', $4, $5)`,
      [userId, campaignId, bindingId, coupon.rows[0].id, expiresAt])
  } else if (config.type === 'tokens') {
    await query(
      `INSERT INTO rewards (user_id, campaign_id, binding_id, type, token_amount, token_remaining, expires_at)
       VALUES ($1, $2, $3, 'tokens', $4, $4, $5)`,
      [userId, campaignId, bindingId, config.amount, expiresAt])
  } else if (config.type === 'free_days') {
    const freeUntil = new Date(Date.now() + (config.days ?? 7) * 86400000)
    await query(
      `INSERT INTO rewards (user_id, campaign_id, binding_id, type, free_until, expires_at)
       VALUES ($1, $2, $3, 'free_days', $4, $4)`,
      [userId, campaignId, bindingId, freeUntil])
    // Also update user's free_until if this extends it
    await query(
      'UPDATE users SET free_until = GREATEST(COALESCE(free_until, $1), $1) WHERE id = $2 AND deployment = $3',
      [freeUntil, userId, DEPLOYMENT])
  } else if (config.type === 'discount') {
    await query(
      `INSERT INTO rewards (user_id, campaign_id, binding_id, type, discount_rate, discount_periods_left, expires_at)
       VALUES ($1, $2, $3, 'discount', $4, $5, $6)`,
      [userId, campaignId, bindingId, config.rate, config.periods ?? 1, expiresAt])
    // Update user's discount_rate if this is better
    await query(
      'UPDATE users SET discount_rate = LEAST(COALESCE(discount_rate, 1.0), $1) WHERE id = $2 AND deployment = $3',
      [config.rate, userId, DEPLOYMENT])
  }
}
