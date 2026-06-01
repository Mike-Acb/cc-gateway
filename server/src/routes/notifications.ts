import { Router } from 'express'
import { query, DEPLOYMENT } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { adminMiddleware } from '../middleware/admin.js'
import { createNotification } from '../services/notification.js'

const notificationRouter = Router()
const adminNotificationRouter = Router()

notificationRouter.use(authMiddleware)
adminNotificationRouter.use(authMiddleware, adminMiddleware)

// ---------------------------------------------------------------------------
// User routes — mounted at /api/notifications
// ---------------------------------------------------------------------------

// GET /api/notifications — list (?unread=true for unread only)
notificationRouter.get('/', async (req, res) => {
  try {
    const unreadOnly = req.query.unread === 'true'
    const sql = unreadOnly
      ? `SELECT id, type, title, content, read, created_at
         FROM notifications
         WHERE user_id = $1 AND read = false
         ORDER BY created_at DESC`
      : `SELECT id, type, title, content, read, created_at
         FROM notifications
         WHERE user_id = $1
         ORDER BY created_at DESC`

    const result = await query(sql, [req.user!.userId])
    res.json({ notifications: result.rows })
  } catch (err) {
    console.error('List notifications error:', err)
    res.status(500).json({ error: 'Failed to list notifications' })
  }
})

// GET /api/notifications/count — unread count
notificationRouter.get('/count', async (req, res) => {
  try {
    const result = await query(
      'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read = false',
      [req.user!.userId],
    )
    res.json({ count: result.rows[0].count })
  } catch (err) {
    console.error('Notification count error:', err)
    res.status(500).json({ error: 'Failed to get notification count' })
  }
})

// PATCH /api/notifications/:id/read — mark one as read
notificationRouter.patch('/:id/read', async (req, res) => {
  try {
    const result = await query(
      'UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user!.userId],
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Notification not found' })
      return
    }
    res.json({ message: 'Marked as read' })
  } catch (err) {
    console.error('Mark notification read error:', err)
    res.status(500).json({ error: 'Failed to mark notification as read' })
  }
})

// POST /api/notifications/read-all — mark all as read
notificationRouter.post('/read-all', async (req, res) => {
  try {
    await query(
      'UPDATE notifications SET read = true WHERE user_id = $1 AND read = false',
      [req.user!.userId],
    )
    res.json({ message: 'All notifications marked as read' })
  } catch (err) {
    console.error('Mark all read error:', err)
    res.status(500).json({ error: 'Failed to mark all as read' })
  }
})

// ---------------------------------------------------------------------------
// Admin routes — mounted at /api/admin/notifications
// ---------------------------------------------------------------------------

// POST /api/admin/notifications/broadcast — send to all active users
adminNotificationRouter.post('/broadcast', async (req, res) => {
  try {
    const { type, title, content } = req.body as { type?: string; title?: string; content?: string }
    if (!type || !title || !content) {
      res.status(400).json({ error: 'type, title, and content are required' })
      return
    }

    const users = await query("SELECT id FROM users WHERE status = 'active' AND deployment = $1", [DEPLOYMENT])
    let count = 0
    for (const user of users.rows) {
      await createNotification(user.id, type, title, content)
      count++
    }

    res.json({ message: `Broadcast sent to ${count} user(s)`, count })
  } catch (err) {
    console.error('Broadcast notification error:', err)
    res.status(500).json({ error: 'Failed to broadcast notification' })
  }
})

export { notificationRouter, adminNotificationRouter }
