import { Router } from 'express'
import { query, DEPLOYMENT } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { adminMiddleware } from '../middleware/admin.js'

const router = Router()
router.use(authMiddleware, adminMiddleware)

// GET /api/admin/identity-profiles — list all profiles with usage count
router.get('/', async (_req, res) => {
  try {
    const result = await query(
      `SELECT ip.id, ip.name, ip.is_default, ip.profile, ip.created_at, ip.updated_at,
              (SELECT COUNT(*) FROM oauth_accounts WHERE identity_profile_id = ip.id AND deployment = $1) AS account_count
       FROM identity_profiles ip
       ORDER BY ip.is_default DESC, ip.name`,
      [DEPLOYMENT],
    )
    res.json({ profiles: result.rows })
  } catch (err) {
    console.error('List identity profiles error:', err)
    res.status(500).json({ error: 'Failed to list profiles' })
  }
})

// GET /api/admin/identity-profiles/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM identity_profiles WHERE id = $1`, [req.params.id])
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Profile not found' })
      return
    }
    res.json(result.rows[0])
  } catch (err) {
    console.error('Get identity profile error:', err)
    res.status(500).json({ error: 'Failed to get profile' })
  }
})

// POST /api/admin/identity-profiles — create
router.post('/', async (req, res) => {
  try {
    const { name, profile, is_default } = req.body
    if (!name || !profile) {
      res.status(400).json({ error: 'name and profile are required' })
      return
    }
    // If marked default, unset existing default first (unique partial index enforces one)
    if (is_default) {
      await query(`UPDATE identity_profiles SET is_default = FALSE WHERE is_default = TRUE`)
    }
    const result = await query(
      `INSERT INTO identity_profiles (name, profile, is_default)
       VALUES ($1, $2, $3) RETURNING *`,
      [name, JSON.stringify(profile), !!is_default],
    )
    res.json(result.rows[0])
  } catch (err) {
    console.error('Create identity profile error:', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create profile' })
  }
})

// PATCH /api/admin/identity-profiles/:id — update
router.patch('/:id', async (req, res) => {
  try {
    const fields: string[] = []
    const params: any[] = []
    let idx = 1

    if (req.body.name !== undefined) {
      fields.push(`name = $${idx++}`)
      params.push(req.body.name)
    }
    if (req.body.profile !== undefined) {
      fields.push(`profile = $${idx++}`)
      params.push(JSON.stringify(req.body.profile))
    }
    if (req.body.is_default !== undefined) {
      if (req.body.is_default) {
        await query(`UPDATE identity_profiles SET is_default = FALSE WHERE is_default = TRUE AND id <> $1`, [req.params.id])
      }
      fields.push(`is_default = $${idx++}`)
      params.push(!!req.body.is_default)
    }

    if (fields.length === 0) {
      res.status(400).json({ error: 'Nothing to update' })
      return
    }
    fields.push(`updated_at = now()`)
    params.push(req.params.id)
    const result = await query(
      `UPDATE identity_profiles SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params,
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Profile not found' })
      return
    }
    res.json(result.rows[0])
  } catch (err) {
    console.error('Update identity profile error:', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update profile' })
  }
})

// DELETE /api/admin/identity-profiles/:id — refuse if in use
router.delete('/:id', async (req, res) => {
  try {
    const inUse = await query(
      `SELECT COUNT(*)::int AS n FROM oauth_accounts WHERE identity_profile_id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    if (inUse.rows[0].n > 0) {
      res.status(409).json({ error: `Profile is used by ${inUse.rows[0].n} account(s). Reassign first.` })
      return
    }
    const def = await query(`SELECT is_default FROM identity_profiles WHERE id = $1`, [req.params.id])
    if (def.rows.length === 0) {
      res.status(404).json({ error: 'Profile not found' })
      return
    }
    if (def.rows[0].is_default) {
      res.status(409).json({ error: 'Cannot delete the default profile. Mark another as default first.' })
      return
    }
    await query(`DELETE FROM identity_profiles WHERE id = $1`, [req.params.id])
    res.json({ ok: true })
  } catch (err) {
    console.error('Delete identity profile error:', err)
    res.status(500).json({ error: 'Failed to delete profile' })
  }
})

export { router as identityProfilesRouter }
export default router
