import crypto from 'crypto'
import { Router } from 'express'
import { query, DEPLOYMENT } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { processInviteBinding } from '../services/reward.js'

const inviteRouter = Router()

// ---------------------------------------------------------------------------
// Invite codes — mounted at /api/invite-codes
// ---------------------------------------------------------------------------

// GET /api/invite-codes — my invite codes (auth required)
inviteRouter.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await query(
      `SELECT ic.id, ic.code, ic.campaign_id, ic.max_uses, ic.used_count, ic.status, ic.created_at,
              c.name AS campaign_name
       FROM invite_codes ic
       JOIN campaigns c ON ic.campaign_id = c.id
       WHERE ic.owner_id = $1
       ORDER BY ic.created_at DESC`,
      [req.user!.userId],
    )
    res.json({ invite_codes: result.rows })
  } catch (err) {
    console.error('List invite codes error:', err)
    res.status(500).json({ error: 'Failed to list invite codes' })
  }
})

// POST /api/invite-codes — generate new invite code (auth required)
inviteRouter.post('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user!.userId

    // Find an active campaign
    const campaignResult = await query(
      `SELECT id, code_prefix, codes_per_user, max_uses
       FROM campaigns
       WHERE status = 'active'
         AND type = 'invite'
         AND (end_at IS NULL OR end_at > now())
       ORDER BY created_at DESC
       LIMIT 1`,
    )

    if (campaignResult.rows.length === 0) {
      res.status(404).json({ error: 'No active invite campaign found' })
      return
    }

    const campaign = campaignResult.rows[0]

    // Check codes_per_user limit
    const countResult = await query(
      'SELECT COUNT(*)::int AS count FROM invite_codes WHERE campaign_id = $1 AND owner_id = $2',
      [campaign.id, userId],
    )

    if (countResult.rows[0].count >= campaign.codes_per_user) {
      res.status(400).json({ error: `You have reached the maximum of ${campaign.codes_per_user} invite codes for this campaign` })
      return
    }

    // Generate code with prefix
    const prefix = campaign.code_prefix || ''
    const code = prefix + crypto.randomBytes(4).toString('hex').toUpperCase()

    const result = await query(
      `INSERT INTO invite_codes (campaign_id, owner_id, code, max_uses)
       VALUES ($1, $2, $3, $4)
       RETURNING id, code, campaign_id, max_uses, used_count, status, created_at`,
      [campaign.id, userId, code, campaign.max_uses || 10],
    )

    res.status(201).json(result.rows[0])
  } catch (err: any) {
    console.error('Generate invite code error:', err)
    if (err.code === '23505') {
      res.status(409).json({ error: 'Code collision, please try again' })
      return
    }
    res.status(500).json({ error: 'Failed to generate invite code' })
  }
})

// GET /api/invite-codes/:code/info — public lookup (no auth)
inviteRouter.get('/:code/info', async (req, res) => {
  try {
    const result = await query(
      `SELECT ic.code, ic.status, ic.max_uses, ic.used_count,
              c.name AS campaign_name, c.status AS campaign_status, c.end_at
       FROM invite_codes ic
       JOIN campaigns c ON ic.campaign_id = c.id
       WHERE ic.code = $1`,
      [req.params.code],
    )

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Invite code not found' })
      return
    }

    const row = result.rows[0]
    const valid = row.status === 'active'
      && row.campaign_status === 'active'
      && row.used_count < row.max_uses
      && (!row.end_at || new Date(row.end_at) > new Date())

    res.json({
      code: row.code,
      campaign_name: row.campaign_name,
      valid,
    })
  } catch (err) {
    console.error('Invite code info error:', err)
    res.status(500).json({ error: 'Failed to get invite code info' })
  }
})

// ---------------------------------------------------------------------------
// Invite binding & records — mounted at /api/invite
// ---------------------------------------------------------------------------

const inviteActionRouter = Router()
inviteActionRouter.use(authMiddleware)

// POST /api/invite/bind — bind invite code
inviteActionRouter.post('/bind', async (req, res) => {
  try {
    const { code } = req.body as { code?: string }
    if (!code) {
      res.status(400).json({ error: 'code is required' })
      return
    }

    const result = await processInviteBinding(req.user!.userId, code)
    if (!result.success) {
      res.status(400).json({ error: result.error })
      return
    }

    res.json({ message: 'Invite code bound successfully' })
  } catch (err) {
    console.error('Bind invite error:', err)
    res.status(500).json({ error: 'Failed to bind invite code' })
  }
})

// GET /api/invite/records — my invite records (who I invited)
inviteActionRouter.get('/records', async (req, res) => {
  try {
    const result = await query(
      `SELECT ib.id, ib.invitee_id, u.username AS invitee_username, ib.status, ib.created_at,
              ic.code AS invite_code
       FROM invite_bindings ib
       JOIN users u ON ib.invitee_id = u.id
       JOIN invite_codes ic ON ib.invite_code_id = ic.id
       WHERE ib.inviter_id = $1 AND u.deployment = $2
       ORDER BY ib.created_at DESC`,
      [req.user!.userId, DEPLOYMENT],
    )
    res.json({ records: result.rows })
  } catch (err) {
    console.error('Invite records error:', err)
    res.status(500).json({ error: 'Failed to list invite records' })
  }
})

// ---------------------------------------------------------------------------
// Rewards — mounted at /api/rewards
// ---------------------------------------------------------------------------

const rewardRouter = Router()
rewardRouter.use(authMiddleware)

// GET /api/rewards — my rewards list
rewardRouter.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT r.id, r.type, r.token_amount, r.token_remaining, r.free_until,
              r.discount_rate, r.discount_periods_left, r.coupon_id, r.status,
              r.expires_at, r.created_at,
              c.name AS campaign_name
       FROM rewards r
       JOIN campaigns c ON r.campaign_id = c.id
       WHERE r.user_id = $1
       ORDER BY r.created_at DESC`,
      [req.user!.userId],
    )
    res.json({ rewards: result.rows })
  } catch (err) {
    console.error('List rewards error:', err)
    res.status(500).json({ error: 'Failed to list rewards' })
  }
})

// ---------------------------------------------------------------------------
// Coupons — mounted at /api/coupons
// ---------------------------------------------------------------------------

const couponRouter = Router()
couponRouter.use(authMiddleware)

// GET /api/coupons — my coupons list
couponRouter.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, code, amount, min_order, status, expires_at, used_at, created_at
       FROM coupons
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user!.userId],
    )
    res.json({ coupons: result.rows })
  } catch (err) {
    console.error('List coupons error:', err)
    res.status(500).json({ error: 'Failed to list coupons' })
  }
})

// POST /api/coupons/:id/apply — apply coupon to invoice
couponRouter.post('/:id/apply', async (req, res) => {
  try {
    const couponId = req.params.id
    const { invoice_id } = req.body as { invoice_id?: string }

    if (!invoice_id) {
      res.status(400).json({ error: 'invoice_id is required' })
      return
    }

    // Verify coupon belongs to user, is unused, not expired
    const couponResult = await query(
      `SELECT id, amount, min_order, status, expires_at
       FROM coupons
       WHERE id = $1 AND user_id = $2`,
      [couponId, req.user!.userId],
    )

    if (couponResult.rows.length === 0) {
      res.status(404).json({ error: 'Coupon not found' })
      return
    }

    const coupon = couponResult.rows[0]

    if (coupon.status !== 'unused') {
      res.status(400).json({ error: 'Coupon has already been used' })
      return
    }

    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
      res.status(400).json({ error: 'Coupon has expired' })
      return
    }

    // Verify invoice belongs to user
    const invoiceResult = await query(
      `SELECT id, total_due, status
       FROM invoices
       WHERE id = $1 AND user_id = $2`,
      [invoice_id, req.user!.userId],
    )

    if (invoiceResult.rows.length === 0) {
      res.status(404).json({ error: 'Invoice not found' })
      return
    }

    const invoice = invoiceResult.rows[0]

    if (invoice.status === 'paid') {
      res.status(400).json({ error: 'Invoice is already paid' })
      return
    }

    // Check min_order
    if (coupon.min_order && Number(invoice.total_due) < Number(coupon.min_order)) {
      res.status(400).json({ error: `Invoice total must be at least ${coupon.min_order} to use this coupon` })
      return
    }

    // Apply coupon
    const discount = Math.min(Number(coupon.amount), Number(invoice.total_due))
    const newTotal = Math.max(0, Number(invoice.total_due) - discount)

    await query(
      `UPDATE invoices SET coupon_id = $1, coupon_amount = $2, total_due = $3 WHERE id = $4`,
      [couponId, discount, newTotal, invoice_id],
    )

    await query(
      `UPDATE coupons SET status = 'used', used_at = now() WHERE id = $1`,
      [couponId],
    )

    res.json({
      message: 'Coupon applied successfully',
      discount,
      new_total: newTotal,
    })
  } catch (err) {
    console.error('Apply coupon error:', err)
    res.status(500).json({ error: 'Failed to apply coupon' })
  }
})

export { inviteRouter, inviteActionRouter, rewardRouter, couponRouter }
