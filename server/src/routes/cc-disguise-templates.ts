import { Router } from 'express'
import { query, DEPLOYMENT } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { adminMiddleware } from '../middleware/admin.js'
import { audit } from '../services/audit.js'

const router = Router()

router.use(authMiddleware, adminMiddleware)

const CC_CORE_TOOL_NAMES = new Set([
  'Task', 'Agent', 'Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep',
])
const CC_CORE_MATCH_THRESHOLD = 3

function reloadChannel(): string | null {
  switch (DEPLOYMENT) {
    case 'gw': return 'gateway_reload_gw'
    case 'gwbk': return 'gateway_reload_gwbk'
    default: return null
  }
}
async function notifyReload(): Promise<void> {
  const channel = reloadChannel()
  if (!channel) return
  try { await query(`NOTIFY ${channel}, 'reload'`) } catch (err) {
    console.warn('notifyReload failed:', err)
  }
}

type ToolLike = { name?: unknown } | unknown

function validateTools(tools: unknown, requireCCBaseline: boolean): { ok: true; normalized: any[] } | { ok: false; error: string } {
  if (!Array.isArray(tools)) return { ok: false, error: 'tools must be an array' }
  if (tools.length === 0) return { ok: false, error: 'tools must not be empty' }

  const names: string[] = []
  for (const t of tools as ToolLike[]) {
    if (!t || typeof t !== 'object') return { ok: false, error: 'each tool must be an object' }
    const n = (t as any).name
    if (typeof n !== 'string' || !n) return { ok: false, error: 'each tool must have a string name' }
    names.push(n)
  }

  if (requireCCBaseline) {
    let matches = 0
    for (const n of names) if (CC_CORE_TOOL_NAMES.has(n)) matches++
    if (matches < CC_CORE_MATCH_THRESHOLD) {
      return {
        ok: false,
        error: `tools must include at least ${CC_CORE_MATCH_THRESHOLD} of CC core [${Array.from(CC_CORE_TOOL_NAMES).join(',')}] — got only ${matches}`,
      }
    }
  }

  return { ok: true, normalized: tools as any[] }
}

function validateSystemBlocks(blocks: unknown): { ok: true; normalized: any[] } | { ok: false; error: string } {
  if (blocks === undefined || blocks === null) return { ok: true, normalized: [] }
  if (!Array.isArray(blocks)) return { ok: false, error: 'system_blocks must be an array' }
  const cleaned = blocks.filter((b: any) => {
    const text = typeof b === 'string' ? b : b?.text
    return !(typeof text === 'string' && text.startsWith('x-anthropic-billing-header'))
  })
  return { ok: true, normalized: cleaned }
}

// GET /api/admin/cc-disguise-templates — list with used_by counts
router.get('/', async (_req, res) => {
  try {
    const result = await query(
      `SELECT t.id, t.name, t.description, t.source, t.source_ua,
              t.tools, t.system_blocks, t.created_at, t.updated_at,
              t.learned_from_account_id, t.is_default,
              COALESCE(uc.used_by, 0) AS used_by,
              lfa.name AS learned_from_account_name
         FROM cc_disguise_templates t
         LEFT JOIN (
           SELECT cc_template_id, COUNT(*)::int AS used_by
             FROM oauth_accounts
            WHERE deployment = $1 AND cc_template_id IS NOT NULL
            GROUP BY cc_template_id
         ) uc ON uc.cc_template_id = t.id
         LEFT JOIN oauth_accounts lfa ON lfa.id = t.learned_from_account_id
        WHERE t.deployment = $1
        ORDER BY t.is_default DESC, t.updated_at DESC`,
      [DEPLOYMENT],
    )

    const items = result.rows.map((r: any) => {
      const tools = Array.isArray(r.tools) ? r.tools : []
      const systemBlocks = Array.isArray(r.system_blocks) ? r.system_blocks : []
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        source: r.source,
        source_ua: r.source_ua,
        is_default: !!r.is_default,
        tools_count: tools.length,
        tool_names: tools.map((t: any) => t?.name ?? t).filter(Boolean),
        system_blocks_count: systemBlocks.length,
        used_by: r.used_by,
        learned_from_account_id: r.learned_from_account_id,
        learned_from_account_name: r.learned_from_account_name,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }
    })

    res.json({ items })
  } catch (err: any) {
    console.error('List cc_disguise_templates error:', err)
    res.status(500).json({ error: err.message ?? 'Failed to list templates' })
  }
})

// GET /api/admin/cc-disguise-templates/:id — detail with full tool/system content + bound accounts
router.get('/:id', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, name, description, source, source_ua, tools, system_blocks,
              learned_from_account_id, created_at, updated_at
         FROM cc_disguise_templates
        WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Template not found' })
      return
    }
    const t = result.rows[0]

    const bound = await query(
      `SELECT id, name, status FROM oauth_accounts
        WHERE cc_template_id = $1 AND deployment = $2
        ORDER BY name`,
      [t.id, DEPLOYMENT],
    )

    res.json({
      ...t,
      bound_accounts: bound.rows,
    })
  } catch (err: any) {
    console.error('Get cc_disguise_template error:', err)
    res.status(500).json({ error: err.message ?? 'Failed to load template' })
  }
})

// POST /api/admin/cc-disguise-templates — manual or skill import
router.post('/', async (req, res) => {
  try {
    const body = req.body ?? {}
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) { res.status(400).json({ error: 'name required' }); return }
    const description = typeof body.description === 'string' ? body.description : null
    const source_ua = typeof body.source_ua === 'string' ? body.source_ua : null
    const rawSource = typeof body.source === 'string' ? body.source : 'manual'
    const source = ['manual', 'cloned', 'imported'].includes(rawSource) ? rawSource : 'manual'

    const tv = validateTools(body.tools, true)
    if (!tv.ok) { res.status(400).json({ error: tv.error }); return }
    const sv = validateSystemBlocks(body.system_blocks)
    if (!sv.ok) { res.status(400).json({ error: sv.error }); return }

    const inserted = await query(
      `INSERT INTO cc_disguise_templates
         (deployment, name, description, tools, system_blocks, source, source_ua)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
       RETURNING *`,
      [DEPLOYMENT, name, description, JSON.stringify(tv.normalized),
        JSON.stringify(sv.normalized), source, source_ua],
    )
    const row = inserted.rows[0]

    await audit(req, {
      action: 'cc_disguise_template.create',
      resource_type: 'cc_disguise_template',
      resource_id: row.id,
      before: null,
      after: { id: row.id, name: row.name, source: row.source },
      summary: `template ${row.name} created (manual)`,
    })

    res.status(201).json(row)
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({ error: 'template name already exists' })
      return
    }
    console.error('Create cc_disguise_template error:', err)
    res.status(500).json({ error: err.message ?? 'Failed to create template' })
  }
})

// PATCH /api/admin/cc-disguise-templates/:id — edit name/description/tools/system/ua
router.patch('/:id', async (req, res) => {
  try {
    const existing = await query(
      `SELECT * FROM cc_disguise_templates WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Template not found' })
      return
    }
    const before = existing.rows[0]

    const body = req.body ?? {}
    const updates: string[] = []
    const values: any[] = []

    if (typeof body.name === 'string') {
      const n = body.name.trim()
      if (!n) { res.status(400).json({ error: 'name cannot be empty' }); return }
      updates.push(`name = $${values.length + 1}`)
      values.push(n)
    }
    if (body.description !== undefined) {
      updates.push(`description = $${values.length + 1}`)
      values.push(typeof body.description === 'string' ? body.description : null)
    }
    if (body.source_ua !== undefined) {
      updates.push(`source_ua = $${values.length + 1}`)
      values.push(typeof body.source_ua === 'string' ? body.source_ua : null)
    }
    if (body.tools !== undefined) {
      const tv = validateTools(body.tools, true)
      if (!tv.ok) { res.status(400).json({ error: tv.error }); return }
      updates.push(`tools = $${values.length + 1}::jsonb`)
      values.push(JSON.stringify(tv.normalized))
    }
    if (body.system_blocks !== undefined) {
      const sv = validateSystemBlocks(body.system_blocks)
      if (!sv.ok) { res.status(400).json({ error: sv.error }); return }
      updates.push(`system_blocks = $${values.length + 1}::jsonb`)
      values.push(JSON.stringify(sv.normalized))
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'no updatable fields provided' })
      return
    }

    updates.push(`updated_at = now()`)
    values.push(req.params.id)
    values.push(DEPLOYMENT)

    const updated = await query(
      `UPDATE cc_disguise_templates
          SET ${updates.join(', ')}
        WHERE id = $${values.length - 1} AND deployment = $${values.length}
        RETURNING *`,
      values,
    )
    const after = updated.rows[0]

    await audit(req, {
      action: 'cc_disguise_template.update',
      resource_type: 'cc_disguise_template',
      resource_id: after.id,
      before: { name: before.name, source: before.source, tools_count: (before.tools ?? []).length },
      after: { name: after.name, source: after.source, tools_count: (after.tools ?? []).length },
      summary: `template ${after.name} updated`,
    })

    await notifyReload()
    res.json(after)
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({ error: 'template name already exists' })
      return
    }
    console.error('Update cc_disguise_template error:', err)
    res.status(500).json({ error: err.message ?? 'Failed to update template' })
  }
})

// POST /api/admin/cc-disguise-templates/:id/clone — duplicate as new template
router.post('/:id/clone', async (req, res) => {
  try {
    const src = await query(
      `SELECT * FROM cc_disguise_templates WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    if (src.rows.length === 0) {
      res.status(404).json({ error: 'Template not found' })
      return
    }
    const s = src.rows[0]

    const reqName = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    let name = reqName || `${s.name} (copy)`
    // de-dupe by suffix if needed
    for (let i = 2; i < 100; i++) {
      const existing = await query(
        `SELECT 1 FROM cc_disguise_templates WHERE deployment = $1 AND name = $2`,
        [DEPLOYMENT, name],
      )
      if (existing.rows.length === 0) break
      name = `${s.name} (copy ${i})`
    }

    const inserted = await query(
      `INSERT INTO cc_disguise_templates
         (deployment, name, description, tools, system_blocks, source, source_ua)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 'cloned', $6)
       RETURNING *`,
      [DEPLOYMENT, name, s.description, JSON.stringify(s.tools ?? []),
        JSON.stringify(s.system_blocks ?? []), s.source_ua],
    )
    const row = inserted.rows[0]

    await audit(req, {
      action: 'cc_disguise_template.clone',
      resource_type: 'cc_disguise_template',
      resource_id: row.id,
      before: { source_template_id: s.id, source_name: s.name },
      after: { id: row.id, name: row.name },
      summary: `template ${row.name} cloned from ${s.name}`,
    })

    res.status(201).json(row)
  } catch (err: any) {
    console.error('Clone cc_disguise_template error:', err)
    res.status(500).json({ error: err.message ?? 'Failed to clone template' })
  }
})

// DELETE /api/admin/cc-disguise-templates/:id — remove (accounts auto-unbind via FK)
router.delete('/:id', async (req, res) => {
  try {
    const existing = await query(
      `SELECT id, name FROM cc_disguise_templates WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Template not found' })
      return
    }

    const boundCount = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM oauth_accounts
        WHERE cc_template_id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )

    await query(
      `DELETE FROM cc_disguise_templates WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )

    await audit(req, {
      action: 'cc_disguise_template.delete',
      resource_type: 'cc_disguise_template',
      resource_id: req.params.id,
      before: { name: existing.rows[0].name, unbound_accounts: boundCount.rows[0]?.n ?? 0 },
      after: null,
      summary: `template ${existing.rows[0].name} deleted (unbound ${boundCount.rows[0]?.n ?? 0} accounts)`,
    })

    await notifyReload()
    res.json({ deleted: true, unbound_accounts: boundCount.rows[0]?.n ?? 0 })
  } catch (err: any) {
    console.error('Delete cc_disguise_template error:', err)
    res.status(500).json({ error: err.message ?? 'Failed to delete template' })
  }
})

// POST /api/admin/cc-disguise-templates/:id/set-default — make this the deployment default
router.post('/:id/set-default', async (req, res) => {
  try {
    const existing = await query(
      `SELECT id, name FROM cc_disguise_templates WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Template not found' })
      return
    }
    await query('BEGIN')
    try {
      await query(
        `UPDATE cc_disguise_templates SET is_default = FALSE WHERE deployment = $1 AND is_default = TRUE`,
        [DEPLOYMENT],
      )
      await query(
        `UPDATE cc_disguise_templates SET is_default = TRUE, updated_at = now() WHERE id = $1 AND deployment = $2`,
        [req.params.id, DEPLOYMENT],
      )
      await query('COMMIT')
    } catch (err) {
      await query('ROLLBACK')
      throw err
    }
    await audit(req, {
      action: 'cc_disguise_template.set_default',
      resource_type: 'cc_disguise_template',
      resource_id: req.params.id,
      before: null,
      after: { id: req.params.id, name: existing.rows[0].name, is_default: true },
      summary: `template ${existing.rows[0].name} set as default`,
    })
    res.json({ id: req.params.id, is_default: true })
  } catch (err: any) {
    console.error('set-default error:', err)
    res.status(500).json({ error: err.message ?? 'Failed to set default' })
  }
})

// POST /api/admin/cc-disguise-templates/:id/bulk-bind — bind this template to every OAuth account whose cc_template_id IS NULL
router.post('/:id/bulk-bind', async (req, res) => {
  try {
    const existing = await query(
      `SELECT id, name FROM cc_disguise_templates WHERE id = $1 AND deployment = $2`,
      [req.params.id, DEPLOYMENT],
    )
    if (existing.rows.length === 0) {
      res.status(404).json({ error: 'Template not found' })
      return
    }
    const result = await query(
      `UPDATE oauth_accounts
          SET cc_template_id = $1, updated_at = now()
        WHERE deployment = $2
          AND auth_kind = 'oauth'
          AND cc_template_id IS NULL
        RETURNING id, name`,
      [req.params.id, DEPLOYMENT],
    )
    await audit(req, {
      action: 'cc_disguise_template.bulk_bind',
      resource_type: 'cc_disguise_template',
      resource_id: req.params.id,
      before: null,
      after: { template_id: req.params.id, template_name: existing.rows[0].name, bound_count: result.rowCount },
      summary: `template ${existing.rows[0].name} bulk-bound to ${result.rowCount} accounts`,
    })
    await notifyReload()
    res.json({ bound_count: result.rowCount ?? 0, accounts: result.rows })
  } catch (err: any) {
    console.error('bulk-bind error:', err)
    res.status(500).json({ error: err.message ?? 'Failed to bulk-bind' })
  }
})

export { router as ccDisguiseTemplatesRouter }
