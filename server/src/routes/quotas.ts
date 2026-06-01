import { Router } from 'express'
import { query, DEPLOYMENT } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { adminMiddleware } from '../middleware/admin.js'

const quotaRouter = Router()
const adminQuotaRouter = Router()

// All routes require authentication
quotaRouter.use(authMiddleware)
adminQuotaRouter.use(authMiddleware, adminMiddleware)

// ---------------------------------------------------------------------------
// User routes — mounted at /api/quotas
// ---------------------------------------------------------------------------

// GET /api/quotas — my quota rules (rules targeting my user_id or my client_ids)
quotaRouter.get('/', async (req, res) => {
  try {
    const userId = req.user!.userId
    const result = await query(
      `SELECT id, target_type, target_id, metric, "window", max_value, action, enabled, created_at       FROM quota_rules
       WHERE (target_type = 'user' AND target_id = $1)
          OR (target_type = 'client' AND target_id IN (SELECT id::text FROM clients WHERE user_id = $1 AND deployment = $2))
       ORDER BY created_at DESC`,
      [userId, DEPLOYMENT]
    )
    res.json(result.rows)
  } catch (err) {
    console.error('List user quotas error:', err)
    res.status(500).json({ error: 'Failed to list quotas' })
  }
})

// GET /api/quotas/status — current consumption vs each rule
quotaRouter.get('/status', async (req, res) => {
  try {
    const userId = req.user!.userId

    // Get all rules targeting this user or their clients
    const rulesResult = await query(
      `SELECT id, target_type, target_id, metric, "window", max_value, action, enabled
       FROM quota_rules
       WHERE enabled = true
         AND ((target_type = 'user' AND target_id = $1)
           OR (target_type = 'client' AND target_id IN (SELECT id::text FROM clients WHERE user_id = $1 AND deployment = $2)))
       ORDER BY created_at DESC`,
      [userId, DEPLOYMENT]
    )

    const statuses = []
    for (const rule of rulesResult.rows) {
      let usedResult
      if (rule.target_type === 'user') {
        usedResult = await query(
          `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read + cache_write), 0) as used
           FROM usage_records
           WHERE client_id IN (SELECT id FROM clients WHERE user_id = $1 AND deployment = $3)
             AND created_at > now() - $2::interval`,
          [userId, rule.window, DEPLOYMENT]
        )
      } else {
        // target_type === 'client'
        usedResult = await query(
          `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read + cache_write), 0) as used
           FROM usage_records
           WHERE client_id = $1::uuid
             AND created_at > now() - $2::interval`,
          [rule.target_id, rule.window]
        )
      }

      const used = Number(usedResult.rows[0].used)
      const maxValue = Number(rule.max_value)
      const remaining = Math.max(0, maxValue - used)
      const percentage = maxValue > 0 ? Math.round((used / maxValue) * 10000) / 100 : 0

      statuses.push({
        rule_id: rule.id,
        target_type: rule.target_type,
        target_id: rule.target_id,
        metric: rule.metric,
        window: rule.window,
        max_value: maxValue,
        action: rule.action,
        used,
        remaining,
        percentage,
      })
    }

    res.json(statuses)
  } catch (err) {
    console.error('Quota status error:', err)
    res.status(500).json({ error: 'Failed to get quota status' })
  }
})

// ---------------------------------------------------------------------------
// Admin routes — mounted at /api/admin/quotas and /api/admin/rate-limits
// ---------------------------------------------------------------------------

// --- Quota Rules ---

// GET /api/admin/quotas — all quota rules
adminQuotaRouter.get('/', async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, target_type, target_id, metric, "window", max_value, action, enabled, created_at
       FROM quota_rules ORDER BY created_at DESC`
    )
    res.json(result.rows)
  } catch (err) {
    console.error('Admin list quotas error:', err)
    res.status(500).json({ error: 'Failed to list quota rules' })
  }
})

// POST /api/admin/quotas — create rule
adminQuotaRouter.post('/', async (req, res) => {
  try {
    const { target_type, target_id, metric, window, max_value, action, enabled } = req.body
    if (!target_type || !target_id || !metric || !window || max_value == null || !action) {
      res.status(400).json({ error: 'target_type, target_id, metric, window, max_value, and action are required' })
      return
    }

    const result = await query(
      `INSERT INTO quota_rules (target_type, target_id, metric, "window", max_value, action, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, target_type, target_id, metric, "window", max_value, action, enabled, created_at, updated_at`,
      [target_type, target_id, metric, window, max_value, action, enabled ?? true]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    console.error('Admin create quota error:', err)
    res.status(500).json({ error: 'Failed to create quota rule' })
  }
})

// PATCH /api/admin/quotas/:id — update rule
adminQuotaRouter.patch('/:id', async (req, res) => {
  try {
    const fields: string[] = []
    const values: any[] = []
    let idx = 1

    for (const col of ['target_type', 'target_id', 'metric', 'max_value', 'action', 'enabled'] as const) {
      if (req.body[col] !== undefined) {
        fields.push(`${col} = $${idx++}`)
        values.push(req.body[col])
      }
    }
    // Handle "window" separately due to quoting
    if (req.body.window !== undefined) {
      fields.push(`"window" = $${idx++}`)
      values.push(req.body.window)
    }

    if (fields.length === 0) {
      res.status(400).json({ error: 'No fields to update' })
      return
    }

    fields.push(`updated_at = now()`)
    values.push(req.params.id)

    const result = await query(
      `UPDATE quota_rules SET ${fields.join(', ')} WHERE id = $${idx}
       RETURNING id, target_type, target_id, metric, "window", max_value, action, enabled, created_at, updated_at`,
      values
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Quota rule not found' })
      return
    }
    res.json(result.rows[0])
  } catch (err) {
    console.error('Admin update quota error:', err)
    res.status(500).json({ error: 'Failed to update quota rule' })
  }
})

// DELETE /api/admin/quotas/:id — delete rule
adminQuotaRouter.delete('/:id', async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM quota_rules WHERE id = $1 RETURNING id',
      [req.params.id]
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Quota rule not found' })
      return
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('Admin delete quota error:', err)
    res.status(500).json({ error: 'Failed to delete quota rule' })
  }
})

// --- Rate Limits ---

const rateLimitRouter = Router()

// GET /api/admin/rate-limits — all rate limits
rateLimitRouter.get('/', async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, target_type, target_id, max_rpm, max_rph, enabled, created_at       FROM rate_limits ORDER BY created_at DESC`
    )
    res.json(result.rows)
  } catch (err) {
    console.error('Admin list rate limits error:', err)
    res.status(500).json({ error: 'Failed to list rate limits' })
  }
})

// POST /api/admin/rate-limits — create
rateLimitRouter.post('/', async (req, res) => {
  try {
    const { target_type, target_id, max_rpm, max_rph, enabled } = req.body
    if (!target_type || !target_id || max_rpm == null || max_rph == null) {
      res.status(400).json({ error: 'target_type, target_id, max_rpm, and max_rph are required' })
      return
    }

    const result = await query(
      `INSERT INTO rate_limits (target_type, target_id, max_rpm, max_rph, enabled)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, target_type, target_id, max_rpm, max_rph, enabled, created_at, updated_at`,
      [target_type, target_id, max_rpm, max_rph, enabled ?? true]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    console.error('Admin create rate limit error:', err)
    res.status(500).json({ error: 'Failed to create rate limit' })
  }
})

// PATCH /api/admin/rate-limits/:id — update
rateLimitRouter.patch('/:id', async (req, res) => {
  try {
    const fields: string[] = []
    const values: any[] = []
    let idx = 1

    for (const col of ['target_type', 'target_id', 'max_rpm', 'max_rph', 'enabled'] as const) {
      if (req.body[col] !== undefined) {
        fields.push(`${col} = $${idx++}`)
        values.push(req.body[col])
      }
    }

    if (fields.length === 0) {
      res.status(400).json({ error: 'No fields to update' })
      return
    }

    fields.push(`updated_at = now()`)
    values.push(req.params.id)

    const result = await query(
      `UPDATE rate_limits SET ${fields.join(', ')} WHERE id = $${idx}
       RETURNING id, target_type, target_id, max_rpm, max_rph, enabled, created_at, updated_at`,
      values
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Rate limit not found' })
      return
    }
    res.json(result.rows[0])
  } catch (err) {
    console.error('Admin update rate limit error:', err)
    res.status(500).json({ error: 'Failed to update rate limit' })
  }
})

// DELETE /api/admin/rate-limits/:id — delete
rateLimitRouter.delete('/:id', async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM rate_limits WHERE id = $1 RETURNING id',
      [req.params.id]
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Rate limit not found' })
      return
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('Admin delete rate limit error:', err)
    res.status(500).json({ error: 'Failed to delete rate limit' })
  }
})

// Mount rate-limit routes under the admin quota router won't work since they're at different paths,
// so we export the rate limit router separately and let app.ts mount it.
export { quotaRouter, adminQuotaRouter, rateLimitRouter as adminRateLimitRouter }
