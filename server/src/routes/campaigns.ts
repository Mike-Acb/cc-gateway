import { Router } from 'express'
import { query, DEPLOYMENT } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { adminMiddleware } from '../middleware/admin.js'
import { audit } from '../services/audit.js'

const adminCampaignRouter = Router()
adminCampaignRouter.use(authMiddleware, adminMiddleware)

// ---------------------------------------------------------------------------
// Admin routes — mounted at /api/admin/campaigns
// ---------------------------------------------------------------------------

// GET /api/admin/campaigns — list all campaigns
adminCampaignRouter.get('/', async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, name, type, status, start_at, end_at, max_uses, current_uses,
              invite_required, code_prefix, codes_per_user, bind_window,
              inviter_rewards, invitee_rewards, created_at
       FROM campaigns
       ORDER BY created_at DESC`,
    )
    res.json({ campaigns: result.rows })
  } catch (err) {
    console.error('List campaigns error:', err)
    res.status(500).json({ error: 'Failed to list campaigns' })
  }
})

// POST /api/admin/campaigns — create campaign
adminCampaignRouter.post('/', async (req, res) => {
  try {
    const {
      name, type, status, start_at, end_at, max_uses,
      invite_required, code_prefix, codes_per_user, bind_window,
      inviter_rewards, invitee_rewards,
    } = req.body as {
      name?: string
      type?: string
      status?: string
      start_at?: string
      end_at?: string
      max_uses?: number
      invite_required?: boolean
      code_prefix?: string
      codes_per_user?: number
      bind_window?: string
      inviter_rewards?: any
      invitee_rewards?: any
    }

    if (!name) {
      res.status(400).json({ error: 'name is required' })
      return
    }

    const result = await query(
      `INSERT INTO campaigns (name, type, status, start_at, end_at, max_uses,
                              invite_required, code_prefix, codes_per_user, bind_window,
                              inviter_rewards, invitee_rewards)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        name,
        type ?? 'invite',
        status ?? 'active',
        start_at ?? null,
        end_at ?? null,
        max_uses ?? 0,
        invite_required ?? true,
        code_prefix ?? '',
        codes_per_user ?? 1,
        bind_window ?? '5 days',
        inviter_rewards ? JSON.stringify(inviter_rewards) : null,
        invitee_rewards ? JSON.stringify(invitee_rewards) : null,
      ],
    )
    const campaign = result.rows[0]
    await audit(req, {
      action: 'system.campaign_create',
      resource_type: 'campaign',
      resource_id: campaign.id,
      before: null,
      after: campaign,
      summary: `campaign ${campaign.name} created`,
    })
    res.status(201).json(campaign)
  } catch (err) {
    console.error('Create campaign error:', err)
    res.status(500).json({ error: 'Failed to create campaign' })
  }
})

// PATCH /api/admin/campaigns/:id — update campaign
adminCampaignRouter.patch('/:id', async (req, res) => {
  try {
    const allowed = [
      'name', 'type', 'status', 'start_at', 'end_at', 'max_uses',
      'invite_required', 'code_prefix', 'codes_per_user', 'bind_window',
      'inviter_rewards', 'invitee_rewards',
    ]

    const fields: string[] = []
    const params: unknown[] = []
    let idx = 1

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        const value = (key === 'inviter_rewards' || key === 'invitee_rewards')
          ? JSON.stringify(req.body[key])
          : req.body[key]
        fields.push(`${key} = $${idx++}`)
        params.push(value)
      }
    }

    if (fields.length === 0) {
      res.status(400).json({ error: 'No fields to update' })
      return
    }

    const beforeRes = await query('SELECT * FROM campaigns WHERE id = $1', [req.params.id])
    const before = beforeRes.rows[0] ?? null

    params.push(req.params.id)
    const result = await query(
      `UPDATE campaigns SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params,
    )

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Campaign not found' })
      return
    }

    const after = result.rows[0]
    await audit(req, {
      action: 'system.campaign_update',
      resource_type: 'campaign',
      resource_id: after.id,
      before,
      after,
      summary: `campaign ${after.name} updated`,
    })
    res.json(after)
  } catch (err) {
    console.error('Update campaign error:', err)
    res.status(500).json({ error: 'Failed to update campaign' })
  }
})

// DELETE /api/admin/campaigns/:id — delete campaign (only if no invite codes)
adminCampaignRouter.delete('/:id', async (req, res) => {
  try {
    const beforeRes = await query('SELECT * FROM campaigns WHERE id = $1', [req.params.id])
    if (beforeRes.rows.length === 0) {
      res.status(404).json({ error: 'Campaign not found' })
      return
    }
    const before = beforeRes.rows[0]

    const codeRes = await query(
      'SELECT COUNT(*)::int AS count FROM invite_codes WHERE campaign_id = $1',
      [req.params.id],
    )
    if (codeRes.rows[0].count > 0) {
      res.status(409).json({ error: 'Cannot delete campaign with existing invite codes' })
      return
    }

    await query('DELETE FROM campaigns WHERE id = $1', [req.params.id])

    await audit(req, {
      action: 'system.campaign_delete',
      resource_type: 'campaign',
      resource_id: before.id,
      before,
      after: null,
      summary: `campaign ${before.name} deleted`,
    })

    res.status(204).send()
  } catch (err) {
    console.error('Delete campaign error:', err)
    res.status(500).json({ error: 'Failed to delete campaign' })
  }
})

// GET /api/admin/campaigns/:id/stats — campaign statistics
adminCampaignRouter.get('/:id/stats', async (req, res) => {
  try {
    const campaignId = req.params.id

    const campaignResult = await query('SELECT id, name FROM campaigns WHERE id = $1', [campaignId])
    if (campaignResult.rows.length === 0) {
      res.status(404).json({ error: 'Campaign not found' })
      return
    }

    const codesResult = await query(
      'SELECT COUNT(*)::int AS total_codes FROM invite_codes WHERE campaign_id = $1',
      [campaignId],
    )

    const usesResult = await query(
      `SELECT COALESCE(SUM(used_count), 0)::int AS total_uses FROM invite_codes WHERE campaign_id = $1`,
      [campaignId],
    )

    const rewardsResult = await query(
      'SELECT COUNT(*)::int AS total_rewards_issued FROM rewards WHERE campaign_id = $1',
      [campaignId],
    )

    const topInvitersResult = await query(
      `SELECT u.username AS user, COUNT(*)::int AS count
       FROM invite_bindings ib
       JOIN invite_codes ic ON ib.invite_code_id = ic.id
       JOIN users u ON ib.inviter_id = u.id
       WHERE ic.campaign_id = $1 AND u.deployment = $2
       GROUP BY u.username
       ORDER BY count DESC
       LIMIT 10`,
      [campaignId, DEPLOYMENT],
    )

    res.json({
      total_codes: codesResult.rows[0].total_codes,
      total_uses: usesResult.rows[0].total_uses,
      total_rewards_issued: rewardsResult.rows[0].total_rewards_issued,
      top_inviters: topInvitersResult.rows,
    })
  } catch (err) {
    console.error('Campaign stats error:', err)
    res.status(500).json({ error: 'Failed to get campaign stats' })
  }
})

export { adminCampaignRouter }
