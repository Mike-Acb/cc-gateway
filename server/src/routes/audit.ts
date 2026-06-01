// GET /api/admin/audit — paginated audit log query.
//
// Filters (all optional):
//   actor         — substring match on actor_email OR exact UUID in actor_id
//   action        — exact action id (e.g. "plan.update")
//   resource_type — exact type (plan / account / group / user / subscription / client / campaign / system)
//   since / until — ISO timestamps (inclusive), created_at range
//   limit (default 50, max 200), offset (default 0)
//
// Response: { items: [...], total: number, limit, offset }

import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { adminMiddleware } from '../middleware/admin.js'
import { query } from '../db.js'

const router = Router()

router.use(authMiddleware, adminMiddleware)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 50), 200)
    const offset = Math.max(0, Number(req.query.offset) || 0)
    const actor = String(req.query.actor ?? '').trim()
    const action = String(req.query.action ?? '').trim()
    const resourceType = String(req.query.resource_type ?? '').trim()
    const since = req.query.since ? new Date(String(req.query.since)) : null
    const until = req.query.until ? new Date(String(req.query.until)) : null

    const where: string[] = []
    const args: unknown[] = []
    if (actor) {
      if (UUID_RE.test(actor)) {
        args.push(actor)
        where.push(`actor_id = $${args.length}`)
      } else {
        args.push(`%${actor}%`)
        where.push(`actor_email ILIKE $${args.length}`)
      }
    }
    if (action) {
      args.push(action)
      where.push(`action = $${args.length}`)
    }
    if (resourceType) {
      args.push(resourceType)
      where.push(`resource_type = $${args.length}`)
    }
    if (since && !Number.isNaN(since.getTime())) {
      args.push(since.toISOString())
      where.push(`created_at >= $${args.length}`)
    }
    if (until && !Number.isNaN(until.getTime())) {
      args.push(until.toISOString())
      where.push(`created_at <= $${args.length}`)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const itemsArgs = [...args, limit, offset]
    const limitIdx = itemsArgs.length - 1
    const offsetIdx = itemsArgs.length

    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(
        `SELECT id, actor_id, actor_email, action, resource_type, resource_id,
                before, after, summary, ip, user_agent, created_at
           FROM audit_logs
           ${whereSql}
           ORDER BY created_at DESC, id DESC
           LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        itemsArgs,
      ),
      query(`SELECT COUNT(*)::int AS n FROM audit_logs ${whereSql}`, args),
    ])

    res.json({ items: rows, total: countRows[0]?.n ?? 0, limit, offset })
  } catch (err) {
    console.error('Audit query error:', err)
    res.status(500).json({ error: 'Failed to query audit log' })
  }
})

export { router as auditRouter }
export default router
