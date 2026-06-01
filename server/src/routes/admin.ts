import { Router } from 'express'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { query, pool, DEPLOYMENT } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { adminMiddleware } from '../middleware/admin.js'
import { audit } from '../services/audit.js'
import { resolvePlanChange, applyDecision } from '../services/plan-change.js'
import { buildCaps, computeUsable } from '../services/pool-wallet.js'

// Resolved once at module load so we don't shell out on every request.
const SYSTEM_INFO_BOOT = {
  version: (() => {
    if (process.env.npm_package_version) return process.env.npm_package_version
    try {
      const pkgPath = resolve(process.cwd(), 'package.json')
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string }
      return pkg.version ?? 'dev'
    } catch {
      return 'dev'
    }
  })(),
  commit: (() => {
    if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT
    try {
      return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    } catch {
      return 'unknown'
    }
  })(),
  deployedAt: process.env.DEPLOY_AT ?? new Date(Date.now() - process.uptime() * 1000).toISOString(),
}

const router = Router()

// All admin routes require auth + admin role
router.use(authMiddleware, adminMiddleware)

// ---------------------------------------------------------------------------
// User management
// ---------------------------------------------------------------------------

// GET /api/admin/users — list all users with pagination.
// Supports ?expand=clients to bundle each user's clients array into the row.
router.get('/users', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
    const offset = (page - 1) * limit

    const search = String(req.query.search ?? '').trim()
    const expand = String(req.query.expand ?? '').trim()
    // $1=limit, $2=offset, $3=deployment (always), $4=search (optional)
    const whereClause = search
      ? `WHERE username != '_system' AND deployment = $3 AND (username ILIKE $4 OR email ILIKE $4)`
      : `WHERE username != '_system' AND deployment = $3`
    const baseParams: unknown[] = [limit, offset, DEPLOYMENT]
    const allParams = search ? [...baseParams, `%${search}%`] : baseParams

    // For the count query, we only need deployment ($1) + optional search ($2)
    const countWhereClause = search
      ? `WHERE username != '_system' AND deployment = $1 AND (username ILIKE $2 OR email ILIKE $2)`
      : `WHERE username != '_system' AND deployment = $1`
    const countParams = search ? [DEPLOYMENT, `%${search}%`] : [DEPLOYMENT]

    const [countResult, usersResult] = await Promise.all([
      query(
        `SELECT COUNT(*)::int AS total FROM users ${countWhereClause}`,
        countParams,
      ),
      query(
        `SELECT id, username, role, status, email, free_until, discount_rate, invited_by, created_at, updated_at
         FROM users ${whereClause} ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        allParams,
      ),
    ])

    const users = usersResult.rows as Array<Record<string, unknown> & { id: string }>

    if (expand === 'clients' && users.length > 0) {
      const ids = users.map((u) => u.id)
      const { rows: clientRows } = await query(
        `SELECT c.id, c.user_id, c.name, c.status, c.group_id,
                g.name AS group_name, c.created_at, c.approved_at
           FROM clients c
           LEFT JOIN account_groups g ON g.id = c.group_id
          WHERE c.deployment = $1 AND c.user_id = ANY($2::uuid[])
          ORDER BY c.created_at DESC`,
        [DEPLOYMENT, ids],
      )
      const byUser: Record<string, Array<Record<string, unknown>>> = {}
      for (const row of clientRows as Array<Record<string, unknown> & { user_id: string }>) {
        ;(byUser[row.user_id] ??= []).push(row)
      }
      for (const u of users) (u as any).clients = byUser[u.id] ?? []
    }

    res.json({
      users,
      total: countResult.rows[0].total,
      page,
      limit,
    })
  } catch (err) {
    console.error('List users error:', err)
    res.status(500).json({ error: 'Failed to list users' })
  }
})

// POST /api/admin/users/:id/ban — mark user status='banned'
router.post('/users/:id/ban', async (req, res) => {
  try {
    const beforeRes = await query(
      `SELECT id, username, role, status FROM users WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    const before = beforeRes.rows[0] ?? null
    if (!before) { res.status(404).json({ error: 'User not found' }); return }
    const result = await query(
      `UPDATE users SET status = 'banned', updated_at = now()
       WHERE id = $1 AND deployment = $2
       RETURNING id, username, role, status, updated_at`,
      [req.params.id, DEPLOYMENT],
    )
    const after = result.rows[0]
    await audit(req, {
      action: 'user.ban',
      resource_type: 'user',
      resource_id: after.id,
      before,
      after,
      summary: `user ${after.username} banned`,
    })
    res.json(after)
  } catch (err) {
    console.error('Ban user error:', err)
    res.status(500).json({ error: 'Failed to ban user' })
  }
})

// POST /api/admin/users/:id/unban — restore user status='active'
router.post('/users/:id/unban', async (req, res) => {
  try {
    const beforeRes = await query(
      `SELECT id, username, role, status FROM users WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    const before = beforeRes.rows[0] ?? null
    if (!before) { res.status(404).json({ error: 'User not found' }); return }
    const result = await query(
      `UPDATE users SET status = 'active', updated_at = now()
       WHERE id = $1 AND deployment = $2
       RETURNING id, username, role, status, updated_at`,
      [req.params.id, DEPLOYMENT],
    )
    const after = result.rows[0]
    await audit(req, {
      action: 'user.unban',
      resource_type: 'user',
      resource_id: after.id,
      before,
      after,
      summary: `user ${after.username} unbanned`,
    })
    res.json(after)
  } catch (err) {
    console.error('Unban user error:', err)
    res.status(500).json({ error: 'Failed to unban user' })
  }
})

// POST /api/admin/users/:id/role — grant/revoke admin
router.post('/users/:id/role', async (req, res) => {
  try {
    const role = String(req.body?.role ?? '')
    if (!['user', 'admin'].includes(role)) {
      res.status(400).json({ error: 'invalid role' })
      return
    }
    const beforeRes = await query(
      `SELECT id, username, role, status FROM users WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    const before = beforeRes.rows[0] ?? null
    if (!before) { res.status(404).json({ error: 'User not found' }); return }
    const result = await query(
      `UPDATE users SET role = $1, updated_at = now()
       WHERE id = $2 AND deployment = $3
       RETURNING id, username, role, status, updated_at`,
      [role, req.params.id, DEPLOYMENT],
    )
    const after = result.rows[0]
    await audit(req, {
      action: role === 'admin' ? 'user.grant_role' : 'user.revoke_role',
      resource_type: 'user',
      resource_id: after.id,
      before,
      after,
      summary: `user ${after.username} role → ${role}`,
    })
    res.json(after)
  } catch (err) {
    console.error('Change user role error:', err)
    res.status(500).json({ error: 'Failed to change user role' })
  }
})

// GET /api/admin/users/search — search by username or email
router.get('/users/search', async (req, res) => {
  try {
    const q = String(req.query.q ?? '').trim()
    if (!q) { res.json({ users: [] }); return }
    const result = await query(
      `SELECT id, username, role, status, email, free_until, discount_rate, invited_by, invite_bound_at, created_at, updated_at
       FROM users WHERE username != '_system'
         AND deployment = $2
         AND (username ILIKE $1 OR email ILIKE $1)
       ORDER BY created_at DESC LIMIT 50`,
      [`%${q}%`, DEPLOYMENT],
    )
    res.json({ users: result.rows })
  } catch (err) {
    console.error('Search users error:', err)
    res.status(500).json({ error: 'Failed to search users' })
  }
})

// GET /api/admin/users/:id — single user detail with inviter name
router.get('/users/:id', async (req, res) => {
  try {
    const result = await query(
      `SELECT u.id, u.username, u.email, u.role, u.status,
              u.free_until, u.discount_rate, u.invited_by, u.invite_bound_at,
              u.created_at, u.updated_at,
              inv.username AS inviter_username
       FROM users u
       LEFT JOIN users inv ON inv.id = u.invited_by
       WHERE u.id = $1 AND u.deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    if (result.rows.length === 0) { res.status(404).json({ error: 'User not found' }); return }
    res.json(result.rows[0])
  } catch (err) {
    console.error('Get user error:', err)
    res.status(500).json({ error: 'Failed to get user' })
  }
})

// PATCH /api/admin/users/:id — update user role/status/free_until/discount_rate
router.patch('/users/:id', async (req, res) => {
  try {
    const updates: string[] = []
    const params: any[] = []
    let idx = 1
    const allowed = ['role', 'status', 'free_until', 'discount_rate']
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates.push(`${key} = $${idx++}`)
        params.push(req.body[key])
      }
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'Nothing to update' })
      return
    }

    const beforeRes = await query(
      `SELECT id, username, role, status, email, free_until, discount_rate
         FROM users WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    const before = beforeRes.rows[0] ?? null

    updates.push(`updated_at = now()`)
    params.push(req.params.id)
    params.push(DEPLOYMENT)
    const deploymentIdx = idx + 1

    const result = await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx} AND deployment = $${deploymentIdx}
       RETURNING id, username, role, status, email, free_until, discount_rate, created_at, updated_at`,
      params,
    )

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' })
      return
    }

    const after = result.rows[0]
    // Derive an action id from what actually changed.
    let action = 'user.update'
    if (req.body.role !== undefined && before && req.body.role !== before.role) {
      action = req.body.role === 'admin' ? 'user.grant_role' : 'user.revoke_role'
    } else if (req.body.status !== undefined && before && req.body.status !== before.status) {
      action = req.body.status === 'suspended' || req.body.status === 'banned'
        ? 'user.ban'
        : 'user.unban'
    }
    await audit(req, {
      action,
      resource_type: 'user',
      resource_id: after.id,
      before,
      after,
      summary: `user ${after.username} ${action.split('.')[1] ?? 'updated'}`,
    })
    res.json(after)
  } catch (err) {
    console.error('Update user error:', err)
    res.status(500).json({ error: 'Failed to update user' })
  }
})

// GET /api/admin/users/:id/clients — user's API keys
router.get('/users/:id/clients', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, token, status, group_id, created_at, approved_at, suspended_at, suspend_reason
       FROM clients WHERE user_id = $1 AND deployment = $2 ORDER BY created_at DESC`,
      [req.params.id, DEPLOYMENT],
    )
    res.json({ clients: result.rows })
  } catch (err) {
    console.error('List user clients error:', err)
    res.status(500).json({ error: 'Failed to list clients' })
  }
})

// GET /api/admin/users/:id/subscriptions — user's subscriptions.
// Pool subs include 4-cap state (limit + current-window used) so the admin UI
// can render per-window usage without a second query.
router.get('/users/:id/subscriptions', async (req, res) => {
  try {
    const result = await query(
      `SELECT s.*, p.name AS plan_name, p.type AS plan_type, p.price AS plan_price,
              p.limit_5h_usd, p.limit_1d_usd, p.limit_7d_usd, p.limit_30d_usd
       FROM subscriptions s
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE s.user_id = $1 ORDER BY s.created_at DESC`,
      [req.params.id],
    )
    const subs = (result.rows as any[]).map((r) => {
      if (r.plan_type !== 'pool') return r
      return { ...r, usable: computeUsable(r), caps: buildCaps(r) }
    })
    res.json({ subscriptions: subs })
  } catch (err) {
    console.error('List user subscriptions error:', err)
    res.status(500).json({ error: 'Failed to list subscriptions' })
  }
})

// GET /api/admin/users/:id/invites — inviter + invitees
router.get('/users/:id/invites', async (req, res) => {
  try {
    // Who invited this user
    const inviterResult = await query(
      `SELECT inv.id, inv.username, inv.email, ib.bound_at
       FROM users u
       JOIN users inv ON inv.id = u.invited_by
       LEFT JOIN invite_bindings ib ON ib.invitee_id = u.id
       WHERE u.id = $1 AND u.deployment = $2 AND inv.deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    // Who this user invited
    const inviteesResult = await query(
      `SELECT u.id, u.username, u.email, ib.bound_at, ib.status,
              ic.code
       FROM invite_bindings ib
       JOIN users u ON u.id = ib.invitee_id
       JOIN invite_codes ic ON ic.id = ib.invite_code_id
       WHERE ib.inviter_id = $1 AND u.deployment = $2
       ORDER BY ib.bound_at DESC`,
      [req.params.id, DEPLOYMENT],
    )
    res.json({
      inviter: inviterResult.rows[0] ?? null,
      invitees: inviteesResult.rows,
    })
  } catch (err) {
    console.error('List user invites error:', err)
    res.status(500).json({ error: 'Failed to list invites' })
  }
})

// GET /api/admin/users/:id/rewards — user's rewards
router.get('/users/:id/rewards', async (req, res) => {
  try {
    const result = await query(
      `SELECT r.*, c.name AS campaign_name
       FROM rewards r
       LEFT JOIN campaigns c ON c.id = r.campaign_id
       WHERE r.user_id = $1 ORDER BY r.created_at DESC`,
      [req.params.id],
    )
    res.json({ rewards: result.rows })
  } catch (err) {
    console.error('List user rewards error:', err)
    res.status(500).json({ error: 'Failed to list rewards' })
  }
})

// POST /api/admin/users/:id/subscriptions/preview — preview grant impact
router.post('/users/:id/subscriptions/preview', async (req, res) => {
  try {
    let { plan_id, balance, expires_at } = req.body as {
      plan_id?: string
      balance?: number | string
      expires_at?: string | null
    }
    const userId = req.params.id

    if (!plan_id) {
      const defaultPlan = await query(
        `SELECT id FROM plans WHERE type = 'quota' AND COALESCE(is_system, false) = false ORDER BY created_at LIMIT 1`
      )
      if (defaultPlan.rows.length === 0) {
        res.status(400).json({ error: 'No quota plan available' })
        return
      }
      plan_id = defaultPlan.rows[0].id
    }

    const resolved = await resolvePlanChange(userId, plan_id!, { balance, expires_at })
    if ('error' in resolved) {
      res.status(404).json({ error: resolved.error })
      return
    }
    res.json(resolved.decision)
  } catch (err) {
    console.error('Preview grant error:', err)
    res.status(500).json({ error: 'Failed to preview grant' })
  }
})

// POST /api/admin/users/:id/subscriptions — grant subscription to user via decision engine.
router.post('/users/:id/subscriptions', async (req, res) => {
  try {
    let { plan_id, balance, expires_at } = req.body as {
      plan_id?: string
      balance?: number | string
      expires_at?: string | null
    }
    const userId = req.params.id

    if (!plan_id) {
      const defaultPlan = await query(
        `SELECT id FROM plans WHERE type = 'quota' AND COALESCE(is_system, false) = false ORDER BY created_at LIMIT 1`
      )
      if (defaultPlan.rows.length === 0) {
        res.status(400).json({ error: 'No quota plan available' })
        return
      }
      plan_id = defaultPlan.rows[0].id
    }

    const resolved = await resolvePlanChange(userId, plan_id!, { balance, expires_at })
    if ('error' in resolved) {
      res.status(404).json({ error: resolved.error })
      return
    }
    const decision = resolved.decision

    const beforeRes = decision.target_sub_id
      ? await query('SELECT * FROM subscriptions WHERE id = $1', [decision.target_sub_id])
      : { rows: [] as any[] }
    const before = beforeRes.rows[0] ?? null

    const { subscription_id } = await applyDecision(userId, decision)
    const afterRes = await query('SELECT * FROM subscriptions WHERE id = $1', [subscription_id])
    const after = afterRes.rows[0]

    await audit(req, {
      action: 'subscription.grant',
      resource_type: 'subscription',
      resource_id: subscription_id,
      before,
      after,
      summary: `subscription granted to user ${userId} (${decision.kind} ${decision.plan.name})`,
    })
    await audit(req, {
      action: 'plan.assign_user',
      resource_type: 'user',
      resource_id: userId,
      before: null,
      after: { user_id: userId, plan_id, subscription_id, decision_kind: decision.kind },
      summary: `plan ${decision.plan.name} assigned to user ${userId} via ${decision.kind}`,
    })

    res.status(201).json(after)
  } catch (err) {
    console.error('Create subscription error:', err)
    res.status(500).json({ error: 'Failed to create subscription' })
  }
})

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

// GET /api/admin/payments — all payments with user/plan info
router.get('/payments', async (_req, res) => {
  try {
    const result = await query(`
      SELECT p.*, u.username, u.email,
             pl.name AS plan_name, pl.type AS plan_type
      FROM payments p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN subscriptions s ON s.id = p.subscription_id
      LEFT JOIN plans pl ON pl.id = s.plan_id
      WHERE u.deployment = $1
      ORDER BY p.created_at DESC LIMIT 200
    `, [DEPLOYMENT])
    res.json(result.rows)
  } catch (err) {
    console.error('Admin list payments error:', err)
    res.status(500).json({ error: 'Failed to list payments' })
  }
})

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

// GET /api/admin/system/stats — system stats
router.get('/system/stats', (_req, res) => {
  res.json({
    pg_pool_size: pool.totalCount,
    uptime: process.uptime(),
    node_version: process.version,
  })
})

// GET /api/admin/system/info — static build / deployment metadata for System page.
router.get('/system/info', (_req, res) => {
  res.json({
    version: SYSTEM_INFO_BOOT.version,
    commit: SYSTEM_INFO_BOOT.commit,
    deployedAt: SYSTEM_INFO_BOOT.deployedAt,
    deployment: DEPLOYMENT,
    nodeVersion: process.version,
    uptimeSec: Math.round(process.uptime()),
  })
})

// GET /api/admin/webhooks — all webhooks across users (admin view, no secrets).
router.get('/webhooks', async (_req, res) => {
  try {
    const result = await query(
      `SELECT w.id, w.url, w.events, w.enabled, w.last_error, w.created_at,
              u.id AS user_id, u.username, u.email
         FROM webhook_configs w
         JOIN users u ON u.id = w.user_id
        WHERE u.deployment = $1
        ORDER BY w.created_at DESC
        LIMIT 200`,
      [DEPLOYMENT],
    )
    res.json({ webhooks: result.rows })
  } catch (err) {
    console.error('Admin list webhooks error:', err)
    res.status(500).json({ error: 'Failed to list webhooks' })
  }
})

// GET /api/admin/system/gateway — proxy health check to gateway
router.get('/system/gateway', async (_req, res) => {
  try {
    const gwUrl = process.env.GATEWAY_HEALTH_URL ?? 'https://127.0.0.1:8443/_health'
    const resp = await fetch(gwUrl, {
      signal: AbortSignal.timeout(5000),
    })
    const data = await resp.json()
    res.json(data)
  } catch (err: any) {
    res.status(502).json({ error: 'Gateway unreachable', detail: err.message })
  }
})

// POST /api/admin/system/reload — synchronously reload gateway pool.
// Calls the gateway's localhost /_reload endpoint, waits for completion, and
// returns the full before/after diff so the admin UI can display exactly what
// changed. Falls back to PG NOTIFY if the HTTP call fails (e.g. gateway
// mid-restart).
router.post('/system/reload', async (req, res) => {
  const gwUrl = process.env.GATEWAY_RELOAD_URL ?? 'https://127.0.0.1:8443/_reload'
  const started = Date.now()
  try {
    const resp = await fetch(gwUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
    })
    const data = await resp.json() as any
    if (!resp.ok) {
      res.status(resp.status).json({
        ok: false,
        error: data.error ?? 'Gateway reload returned non-2xx',
        detail: data,
        elapsed_ms: Date.now() - started,
      })
      return
    }
    await audit(req, {
      action: 'system.reload',
      resource_type: 'system',
      resource_id: 'gateway',
      before: null,
      after: { elapsed_ms: Date.now() - started, mode: 'http' },
      summary: `gateway reload ok (${Date.now() - started}ms)`,
    })
    res.json(data)
  } catch (err: any) {
    try {
      // NOTIFY channel must be a Postgres identifier (not a bind param).
      // Only allow the hardcoded deployment tags we accept in db.ts so we
      // cannot be tricked into a malformed channel name.
      const channel = reloadChannelForDeployment(DEPLOYMENT)
      await query(`NOTIFY ${channel}, 'reload'`)
      await audit(req, {
        action: 'system.reload',
        resource_type: 'system',
        resource_id: 'gateway',
        before: null,
        after: { elapsed_ms: Date.now() - started, mode: 'notify-fallback', channel },
        summary: `gateway reload via NOTIFY fallback (${Date.now() - started}ms)`,
      })
      res.status(202).json({
        ok: true,
        mode: 'async-fallback',
        channel,
        message: `Gateway HTTP reload failed (${err.message}); NOTIFY sent instead.`,
        elapsed_ms: Date.now() - started,
      })
    } catch (notifyErr: any) {
      res.status(500).json({
        ok: false,
        error: 'Both HTTP reload and PG NOTIFY failed',
        http_error: err.message,
        notify_error: notifyErr.message,
      })
    }
  }
})

// Whitelist-guarded mapping from deployment tag to NOTIFY channel name.
// Postgres NOTIFY channel names are identifiers, not bind parameters, so we
// MUST NOT interpolate env input directly.
function reloadChannelForDeployment(deployment: string): string {
  switch (deployment) {
    case 'gw':
      return 'gateway_reload_gw'
    case 'gwbk':
      return 'gateway_reload_gwbk'
    default:
      throw new Error(`Unsupported deployment tag for NOTIFY: ${deployment}`)
  }
}

// ---------------------------------------------------------------------------
// System Settings
// ---------------------------------------------------------------------------

// GET /api/admin/settings — all settings
router.get('/settings', async (_req, res) => {
  try {
    const result = await query('SELECT key, value, updated_at FROM system_settings ORDER BY key')
    res.json(result.rows)
  } catch (err) {
    console.error('List settings error:', err)
    res.status(500).json({ error: 'Failed to list settings' })
  }
})

// PUT /api/admin/settings/:key — create or update a setting
router.put('/settings/:key', async (req, res) => {
  try {
    const { value } = req.body
    if (value === undefined || value === null) {
      res.status(400).json({ error: 'value is required' })
      return
    }
    const result = await query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()
       RETURNING key, value, updated_at`,
      [req.params.key, String(value)]
    )
    res.json(result.rows[0])
  } catch (err) {
    console.error('Update setting error:', err)
    res.status(500).json({ error: 'Failed to update setting' })
  }
})

export { router as adminRouter }
export default router
