import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { adminMiddleware } from '../middleware/admin.js'
import { query } from '../db.js'
import {
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  setAccountGroup,
  setClientGroup,
} from '../services/groups.js'
import { audit } from '../services/audit.js'

const router = Router()

// All group admin routes require auth + admin role (mirrors other admin routers).
router.use(authMiddleware, adminMiddleware)

// GET /api/admin/groups
router.get('/', async (_req, res) => {
  try {
    res.json({ items: await listGroups() })
  } catch (err) {
    console.error('List groups error:', err)
    res.status(500).json({ error: 'Failed to list groups' })
  }
})

// POST /api/admin/groups
router.post('/', async (req, res) => {
  try {
    const { name, description, cost_multiplier, color } = req.body ?? {}
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name required' })
      return
    }
    const group = await createGroup({ name, description, cost_multiplier, color })
    await audit(req, {
      action: 'group.create',
      resource_type: 'group',
      resource_id: group.id,
      before: null,
      after: group,
      summary: `group ${group.name} created`,
    })
    res.status(201).json(group)
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({ error: 'group name already exists' })
      return
    }
    console.error('Create group error:', err)
    res.status(500).json({ error: 'Failed to create group' })
  }
})

// PATCH /api/admin/groups/:id
router.patch('/:id', async (req, res) => {
  try {
    const beforeRes = await query('SELECT * FROM account_groups WHERE id = $1', [req.params.id])
    const before = beforeRes.rows[0] ?? null
    const group = await updateGroup(req.params.id, req.body ?? {})
    await audit(req, {
      action: 'group.update',
      resource_type: 'group',
      resource_id: group.id,
      before,
      after: group,
      summary: `group ${group.name} updated`,
    })
    res.json(group)
  } catch (err: any) {
    if (err?.message === 'group not found') {
      res.status(404).json({ error: 'group not found' })
      return
    }
    if (err?.code === '23505') {
      res.status(409).json({ error: 'group name already exists' })
      return
    }
    console.error('Update group error:', err)
    res.status(500).json({ error: 'Failed to update group' })
  }
})

// DELETE /api/admin/groups/:id
router.delete('/:id', async (req, res) => {
  try {
    const beforeRes = await query('SELECT * FROM account_groups WHERE id = $1', [req.params.id])
    const before = beforeRes.rows[0] ?? null
    await deleteGroup(req.params.id)
    await audit(req, {
      action: 'group.delete',
      resource_type: 'group',
      resource_id: req.params.id,
      before,
      after: null,
      summary: `group ${before?.name ?? req.params.id} deleted`,
    })
    res.json({ ok: true })
  } catch (err: any) {
    if (err?.message === 'cannot delete default group') {
      res.status(400).json({ error: 'cannot delete default group' })
      return
    }
    if (err?.message === 'group not found') {
      res.status(404).json({ error: 'group not found' })
      return
    }
    console.error('Delete group error:', err)
    res.status(500).json({ error: 'Failed to delete group' })
  }
})

// POST /api/admin/groups/accounts/:accountId
router.post('/accounts/:accountId', async (req, res) => {
  try {
    const { groupId } = req.body ?? {}
    const beforeRes = await query(
      'SELECT id, name, group_id FROM oauth_accounts WHERE id = $1',
      [req.params.accountId],
    )
    const before = beforeRes.rows[0] ?? null
    await setAccountGroup(req.params.accountId, groupId ?? null)
    const afterRes = await query(
      'SELECT id, name, group_id FROM oauth_accounts WHERE id = $1',
      [req.params.accountId],
    )
    await audit(req, {
      action: 'group.assign_account',
      resource_type: 'account',
      resource_id: req.params.accountId,
      before,
      after: afterRes.rows[0] ?? null,
      summary: `account ${before?.name ?? req.params.accountId} → group ${groupId ?? 'shared'}`,
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('Assign account group error:', err)
    res.status(500).json({ error: 'Failed to assign account group' })
  }
})

// POST /api/admin/groups/clients/:clientId
// groupId may be null / 'auto' / omitted — means NULL in DB (auto-pick at dispatch).
router.post('/clients/:clientId', async (req, res) => {
  try {
    const raw = (req.body ?? {}).groupId
    const normalized: string | null =
      raw === null || raw === undefined || raw === '' || raw === 'auto'
        ? null
        : typeof raw === 'string'
          ? raw
          : null
    const beforeRes = await query(
      'SELECT id, name, group_id FROM clients WHERE id = $1',
      [req.params.clientId],
    )
    const before = beforeRes.rows[0] ?? null
    await setClientGroup(req.params.clientId, normalized)
    const afterRes = await query(
      'SELECT id, name, group_id FROM clients WHERE id = $1',
      [req.params.clientId],
    )
    await audit(req, {
      action: 'group.assign_client',
      resource_type: 'client',
      resource_id: req.params.clientId,
      before,
      after: afterRes.rows[0] ?? null,
      summary: `client ${before?.name ?? req.params.clientId} → group ${normalized ?? 'auto'}`,
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('Assign client group error:', err)
    res.status(500).json({ error: 'Failed to assign client group' })
  }
})

// ---------------------------------------------------------------------------
// User-facing router — mounted at /api/groups
//普通已登录用户可以列出可用的调度组(令牌管理页的下拉选项),
// 仅返回非敏感字段。
// ---------------------------------------------------------------------------
const userGroupsRouter = Router()
userGroupsRouter.use(authMiddleware)

userGroupsRouter.get('/', async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, name, description, cost_multiplier, is_default
       FROM account_groups
       ORDER BY cost_multiplier ASC, name ASC`,
    )
    res.json({ items: result.rows })
  } catch (err) {
    console.error('List user groups error:', err)
    res.status(500).json({ error: 'Failed to list groups' })
  }
})

export { router as groupsRouter, userGroupsRouter }
export default router
