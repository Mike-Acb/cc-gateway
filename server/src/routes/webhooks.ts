import { Router } from 'express'
import { query } from '../db.js'
import { requestExternal } from '../services/outbound-proxy.js'
import { authMiddleware } from '../middleware/auth.js'

const webhookRouter = Router()

webhookRouter.use(authMiddleware)

// ---------------------------------------------------------------------------
// User routes — mounted at /api/webhooks
// ---------------------------------------------------------------------------

// GET /api/webhooks — my webhook configs
webhookRouter.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, url, events, enabled, last_error, created_at
       FROM webhook_configs
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user!.userId],
    )
    res.json({ webhooks: result.rows })
  } catch (err) {
    console.error('List webhooks error:', err)
    res.status(500).json({ error: 'Failed to list webhooks' })
  }
})

// POST /api/webhooks — create
webhookRouter.post('/', async (req, res) => {
  try {
    const { url, secret, events } = req.body as { url?: string; secret?: string; events?: string[] }
    if (!url || !events || !Array.isArray(events) || events.length === 0) {
      res.status(400).json({ error: 'url and events (non-empty array) are required' })
      return
    }

    const result = await query(
      `INSERT INTO webhook_configs (user_id, url, secret, events)
       VALUES ($1, $2, $3, $4)
       RETURNING id, url, events, enabled, created_at`,
      [req.user!.userId, url, secret ?? null, events],
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    console.error('Create webhook error:', err)
    res.status(500).json({ error: 'Failed to create webhook' })
  }
})

// PATCH /api/webhooks/:id — update
webhookRouter.patch('/:id', async (req, res) => {
  try {
    // Verify ownership
    const existing = await query(
      'SELECT id FROM webhook_configs WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user!.userId],
    )
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Webhook not found' })
      return
    }

    const { url, secret, events, enabled } = req.body as {
      url?: string
      secret?: string
      events?: string[]
      enabled?: boolean
    }

    const fields: string[] = []
    const params: unknown[] = []
    let idx = 1

    if (url !== undefined) { fields.push(`url = $${idx++}`); params.push(url) }
    if (secret !== undefined) { fields.push(`secret = $${idx++}`); params.push(secret) }
    if (events !== undefined) { fields.push(`events = $${idx++}`); params.push(events) }
    if (enabled !== undefined) { fields.push(`enabled = $${idx++}`); params.push(enabled) }

    if (fields.length === 0) {
      res.status(400).json({ error: 'No fields to update' })
      return
    }

    params.push(req.params.id)
    const result = await query(
      `UPDATE webhook_configs SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, url, events, enabled, created_at`,
      params,
    )
    res.json(result.rows[0])
  } catch (err) {
    console.error('Update webhook error:', err)
    res.status(500).json({ error: 'Failed to update webhook' })
  }
})

// DELETE /api/webhooks/:id — delete
webhookRouter.delete('/:id', async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM webhook_configs WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user!.userId],
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Webhook not found' })
      return
    }
    res.json({ message: 'Webhook deleted' })
  } catch (err) {
    console.error('Delete webhook error:', err)
    res.status(500).json({ error: 'Failed to delete webhook' })
  }
})

// POST /api/webhooks/:id/test — send test event
webhookRouter.post('/:id/test', async (req, res) => {
  try {
    const result = await query(
      'SELECT id, url, secret FROM webhook_configs WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user!.userId],
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Webhook not found' })
      return
    }

    const config = result.rows[0]
    const crypto = await import('crypto')
    const body = JSON.stringify({ event: 'test', data: { message: 'Test webhook delivery' }, timestamp: Date.now() })
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }

    if (config.secret) {
      const sig = crypto.createHmac('sha256', config.secret).update(body).digest('hex')
      headers['X-Webhook-Signature'] = sig
    }

    const response = await requestExternal(config.url, { method: 'POST', headers, body, timeoutMs: 10_000 })
    if (response.statusCode < 200 || response.statusCode >= 300) {
      res.status(502).json({ error: `Webhook returned ${response.statusCode}` })
      return
    }

    res.json({ message: 'Test webhook delivered successfully' })
  } catch (err: any) {
    console.error('Test webhook error:', err)
    res.status(502).json({ error: `Webhook delivery failed: ${err.message}` })
  }
})

export { webhookRouter }
