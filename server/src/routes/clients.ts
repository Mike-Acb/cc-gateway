import { Router } from 'express'
import crypto from 'crypto'
import { query, DEPLOYMENT } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { adminMiddleware } from '../middleware/admin.js'
import { audit } from '../services/audit.js'

const router = Router()
const adminRouter = Router()

// All routes require authentication
router.use(authMiddleware)
adminRouter.use(authMiddleware, adminMiddleware)

// ---------------------------------------------------------------------------
// User routes — mounted at /api/clients
// ---------------------------------------------------------------------------

// GET /api/clients — list MY clients only (user-view).
// Admin-view uses /api/admin/users/:id/clients or /api/admin/clients/pending.
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT c.id, c.user_id, c.name, c.token, c.status, c.approved_by, c.approved_at,
              c.group_id, g.name AS group_name, c.quota_usd, c.reserved_usd, COALESCE(c.external_client, false) AS external_client,
              c.created_at, c.updated_at,
              COALESCE((
                SELECT SUM(cost) FROM usage_records WHERE client_id = c.id
              ), 0)::numeric AS used_usd,
              COALESCE((
                SELECT COUNT(*) FROM usage_records WHERE client_id = c.id
              ), 0)::bigint AS used_requests
       FROM clients c
       LEFT JOIN account_groups g ON g.id = c.group_id
       WHERE c.user_id = $1 AND c.deployment = $2
       ORDER BY c.created_at DESC`,
      [req.user!.userId, DEPLOYMENT]
    )
    res.json(result.rows)
  } catch (err) {
    console.error('List clients error:', err)
    res.status(500).json({ error: 'Failed to list clients' })
  }
})

// POST /api/clients — create a new client
router.post('/', async (req, res) => {
  try {
    const { name } = req.body
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'name is required' })
      return
    }

    const token = 'sk-' + crypto.randomBytes(32).toString('hex')

    const settingRow = await query(
      "SELECT value FROM system_settings WHERE key = 'client_require_approval'"
    )
    const requireApproval = settingRow.rows[0]?.value !== 'false'

    const result = requireApproval
      ? await query(
          `INSERT INTO clients (user_id, name, token, status, deployment)
           VALUES ($1, $2, $3, 'pending', $4)
           RETURNING id, user_id, name, token, status, created_at`,
          [req.user!.userId, name.trim(), token, DEPLOYMENT]
        )
      : await query(
          `INSERT INTO clients (user_id, name, token, status, approved_by, approved_at, deployment)
           VALUES ($1, $2, $3, 'active', $1, now(), $4)
           RETURNING id, user_id, name, token, status, created_at`,
          [req.user!.userId, name.trim(), token, DEPLOYMENT]
        )
    const client = result.rows[0]
    await audit(req, {
      action: 'client.create',
      resource_type: 'client',
      resource_id: client.id,
      before: null,
      after: client, // audit.sanitize will scrub client.token
      summary: `client ${client.name} created by user ${req.user!.userId}`,
    })
    res.status(201).json(client)
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: '客户端名称已存在，请使用其他名称' })
      return
    }
    console.error('Create client error:', err)
    res.status(500).json({ error: '创建客户端失败，请稍后重试' })
  }
})

// GET /api/clients/:id — detail (owner or admin)
router.get('/:id', async (req, res) => {
  try {
    const result = await query(
      `SELECT c.id, c.user_id, c.name, c.token, c.status, c.approved_by, c.approved_at,
              c.group_id, g.name AS group_name, c.created_at, c.updated_at
       FROM clients c
       LEFT JOIN account_groups g ON g.id = c.group_id
       WHERE c.id = $1 AND c.deployment = $2`,
      [req.params.id, DEPLOYMENT]
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Client not found' })
      return
    }
    const client = result.rows[0]
    if (client.user_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Access denied' })
      return
    }
    res.json(client)
  } catch (err) {
    console.error('Get client error:', err)
    res.status(500).json({ error: 'Failed to get client' })
  }
})

// PATCH /api/clients/:id — update name / quota_usd / group_id (owner or admin)
// quota_usd: number or null (null = 无限)
// group_id:  uuid string, null, or 'auto' (null/'auto' = 调度器自动选最低倍率组)
router.patch('/:id', async (req, res) => {
  try {
    const { name, quota_usd, group_id, external_client } = req.body ?? {}

    // Ownership check
    const existing = await query(
      'SELECT user_id FROM clients WHERE id = $1 AND deployment = $2',
      [req.params.id, DEPLOYMENT],
    )
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Client not found' })
      return
    }
    if (existing.rows[0].user_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    // Build dynamic SET clause
    const sets: string[] = []
    const params: any[] = []
    let idx = 1

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        res.status(400).json({ error: 'name must be a non-empty string' })
        return
      }
      sets.push(`name = $${idx++}`)
      params.push(name.trim())
    }

    if (quota_usd !== undefined) {
      if (quota_usd === null) {
        sets.push(`quota_usd = NULL`)
      } else {
        const n = Number(quota_usd)
        if (!Number.isFinite(n) || n < 0) {
          res.status(400).json({ error: 'quota_usd must be a non-negative number or null' })
          return
        }
        sets.push(`quota_usd = $${idx++}`)
        params.push(n)
      }
    }

    if (group_id !== undefined) {
      if (group_id === null || group_id === 'auto' || group_id === '') {
        sets.push(`group_id = NULL`)
      } else {
        const g = await query(
          'SELECT id FROM account_groups WHERE id = $1',
          [group_id],
        )
        if (g.rows.length === 0) {
          res.status(400).json({ error: 'invalid group_id' })
          return
        }
        sets.push(`group_id = $${idx++}`)
        params.push(group_id)
      }
    }


    if (external_client !== undefined) {
      if (typeof external_client !== 'boolean') {
        res.status(400).json({ error: 'external_client must be boolean' })
        return
      }
      sets.push(`external_client = $${idx++}`)
      params.push(external_client)
    }

    if (sets.length === 0) {
      res.status(400).json({ error: 'no fields to update' })
      return
    }

    const beforeRes = await query(
      `SELECT id, user_id, name, status, group_id, quota_usd FROM clients WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    const before = beforeRes.rows[0] ?? null

    sets.push(`updated_at = now()`)
    params.push(req.params.id, DEPLOYMENT)
    const result = await query(
      `UPDATE clients SET ${sets.join(', ')}
       WHERE id = $${idx++} AND deployment = $${idx}
       RETURNING id, user_id, name, token, status, approved_by, approved_at,
                 group_id, quota_usd, created_at, updated_at`,
      params,
    )
    const after = result.rows[0]
    await audit(req, {
      action: 'client.update',
      resource_type: 'client',
      resource_id: after?.id,
      before,
      after,
      summary: `client ${after?.name ?? req.params.id} updated`,
    })
    res.json(after)
  } catch (err) {
    console.error('Update client error:', err)
    res.status(500).json({ error: 'Failed to update client' })
  }
})

// POST /api/clients/:id/rotate — rotate token (owner or admin)
router.post('/:id/rotate', async (req, res) => {
  try {
    const existing = await query(
      'SELECT user_id FROM clients WHERE id = $1 AND deployment = $2',
      [req.params.id, DEPLOYMENT]
    )
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Client not found' })
      return
    }
    if (existing.rows[0].user_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    const beforeRes = await query(
      `SELECT id, user_id, name, token, status FROM clients WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    const before = beforeRes.rows[0] ?? null

    const newToken = 'sk-' + crypto.randomBytes(32).toString('hex')
    const result = await query(
      `UPDATE clients SET token = $1, updated_at = now() WHERE id = $2 AND deployment = $3
       RETURNING id, user_id, name, token, status, updated_at`,
      [newToken, req.params.id, DEPLOYMENT]
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Client not found' })
      return
    }
    const after = result.rows[0]
    await audit(req, {
      action: 'client.rotate_key',
      resource_type: 'client',
      resource_id: after.id,
      before, // audit.sanitize scrubs token field
      after,  // audit.sanitize scrubs token field
      summary: `client ${after.name} token rotated`,
    })
    // Return the new token to the caller (NOT scrubbed — user needs it once).
    res.json({ id: after.id, name: after.name, token: after.token, status: after.status })
  } catch (err) {
    console.error('Rotate client token error:', err)
    res.status(500).json({ error: 'Failed to rotate client token' })
  }
})

// DELETE /api/clients/:id — delete (owner or admin)
router.delete('/:id', async (req, res) => {
  try {
    const existing = await query('SELECT user_id FROM clients WHERE id = $1 AND deployment = $2', [req.params.id, DEPLOYMENT])
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Client not found' })
      return
    }
    if (existing.rows[0].user_id !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    const beforeRes = await query(
      `SELECT id, user_id, name, status FROM clients WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    const before = beforeRes.rows[0] ?? null
    await query('DELETE FROM clients WHERE id = $1 AND deployment = $2', [req.params.id, DEPLOYMENT])
    await audit(req, {
      action: 'client.revoke',
      resource_type: 'client',
      resource_id: req.params.id,
      before,
      after: null,
      summary: `client ${before?.name ?? req.params.id} deleted`,
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('Delete client error:', err)
    res.status(500).json({ error: 'Failed to delete client' })
  }
})

// POST /api/clients/:id/suspend — admin: set status='suspended'
router.post('/:id/suspend', adminMiddleware, async (req, res) => {
  try {
    const beforeRes = await query(
      `SELECT id, user_id, name, status FROM clients WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    const before = beforeRes.rows[0] ?? null
    const result = await query(
      `UPDATE clients SET status = 'suspended', updated_at = now() WHERE id = $1 AND deployment = $2
       RETURNING id, user_id, name, status, updated_at`,
      [req.params.id, DEPLOYMENT]
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Client not found' })
      return
    }
    const after = result.rows[0]
    await audit(req, {
      action: 'client.revoke',
      resource_type: 'client',
      resource_id: after.id,
      before,
      after,
      summary: `client ${after.name} suspended`,
    })
    res.json(after)
  } catch (err) {
    console.error('Suspend client error:', err)
    res.status(500).json({ error: 'Failed to suspend client' })
  }
})

// POST /api/clients/:id/activate — admin: set status='active'
router.post('/:id/activate', adminMiddleware, async (req, res) => {
  try {
    const beforeRes = await query(
      `SELECT id, user_id, name, status FROM clients WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    const before = beforeRes.rows[0] ?? null
    const result = await query(
      `UPDATE clients SET status = 'active', updated_at = now() WHERE id = $1 AND deployment = $2
       RETURNING id, user_id, name, status, updated_at`,
      [req.params.id, DEPLOYMENT]
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Client not found' })
      return
    }
    const after = result.rows[0]
    await audit(req, {
      action: 'client.update',
      resource_type: 'client',
      resource_id: after.id,
      before,
      after,
      summary: `client ${after.name} activated`,
    })
    res.json(after)
  } catch (err) {
    console.error('Activate client error:', err)
    res.status(500).json({ error: 'Failed to activate client' })
  }
})

// ---------------------------------------------------------------------------
// Admin routes — mounted at /api/admin/clients
// ---------------------------------------------------------------------------

// GET /api/admin/clients/pending — list pending clients
adminRouter.get('/pending', async (_req, res) => {
  try {
    const result = await query(
      `SELECT c.id, c.user_id, c.name, c.token, c.status, c.group_id,
              g.name AS group_name, c.created_at,
              u.username AS owner_username
       FROM clients c
       JOIN users u ON c.user_id = u.id
       LEFT JOIN account_groups g ON g.id = c.group_id
       WHERE c.status = 'pending' AND c.deployment = $1 AND u.deployment = $1
       ORDER BY c.created_at ASC`,
      [DEPLOYMENT]
    )
    res.json(result.rows)
  } catch (err) {
    console.error('List pending clients error:', err)
    res.status(500).json({ error: 'Failed to list pending clients' })
  }
})

// POST /api/admin/clients/:id/approve — approve a pending client
adminRouter.post('/:id/approve', async (req, res) => {
  try {
    const beforeRes = await query(
      `SELECT id, user_id, name, status FROM clients WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    const before = beforeRes.rows[0] ?? null
    const result = await query(
      `UPDATE clients SET status = 'active', approved_by = $1, approved_at = now(), updated_at = now()
       WHERE id = $2 AND status = 'pending' AND deployment = $3
       RETURNING id, user_id, name, status, approved_by, approved_at, updated_at`,
      [req.user!.userId, req.params.id, DEPLOYMENT]
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Pending client not found' })
      return
    }
    const after = result.rows[0]
    await audit(req, {
      action: 'client.update',
      resource_type: 'client',
      resource_id: after.id,
      before,
      after,
      summary: `client ${after.name} approved`,
    })
    res.json(after)
  } catch (err) {
    console.error('Approve client error:', err)
    res.status(500).json({ error: 'Failed to approve client' })
  }
})

// POST /api/admin/clients/:id/reject — reject (delete) a pending client
adminRouter.post('/:id/reject', async (req, res) => {
  try {
    const beforeRes = await query(
      `SELECT id, user_id, name, status FROM clients WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    const before = beforeRes.rows[0] ?? null
    const result = await query(
      `DELETE FROM clients WHERE id = $1 AND status = 'pending' AND deployment = $2 RETURNING id`,
      [req.params.id, DEPLOYMENT]
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Pending client not found' })
      return
    }
    await audit(req, {
      action: 'client.revoke',
      resource_type: 'client',
      resource_id: req.params.id,
      before,
      after: null,
      summary: `pending client ${before?.name ?? req.params.id} rejected`,
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('Reject client error:', err)
    res.status(500).json({ error: 'Failed to reject client' })
  }
})

export { router as clientRouter, adminRouter as adminClientRouter }
export default router
