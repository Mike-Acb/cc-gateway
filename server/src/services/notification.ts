import crypto from 'crypto'
import { query } from '../db.js'
import { requestExternal } from './outbound-proxy.js'

// Create notification and trigger webhooks
export async function createNotification(userId: string, type: string, title: string, content: string): Promise<void> {
  await query(
    'INSERT INTO notifications (user_id, type, title, content) VALUES ($1, $2, $3, $4)',
    [userId, type, title, content]
  )
  // Fire webhooks asynchronously (don't await — fire and forget)
  triggerWebhooks(userId, type, { title, content }).catch(err => {
    console.error('Webhook delivery failed:', err)
  })
}

// Send webhook to all matching configs for this user
async function triggerWebhooks(userId: string, eventType: string, payload: any): Promise<void> {
  const configs = await query(
    "SELECT id, url, secret, events FROM webhook_configs WHERE user_id = $1 AND enabled = true AND $2 = ANY(events)",
    [userId, eventType]
  )

  for (const config of configs.rows) {
    try {
      await sendWebhook(config.url, config.secret, eventType, payload)
    } catch (err: any) {
      // Update last_error
      await query('UPDATE webhook_configs SET last_error = $1 WHERE id = $2', [err.message, config.id])
    }
  }
}

// POST to webhook URL with HMAC signature
async function sendWebhook(url: string, secret: string | null, event: string, payload: any): Promise<void> {
  const body = JSON.stringify({ event, data: payload, timestamp: Date.now() })
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  if (secret) {
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex')
    headers['X-Webhook-Signature'] = sig
  }

  const res = await requestExternal(url, { method: 'POST', headers, body, timeoutMs: 10_000 })
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`Webhook returned ${res.statusCode}`)
}
