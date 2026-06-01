import { Router } from 'express'
import { query } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { adminMiddleware } from '../middleware/admin.js'
import { generateMonthlyInvoices } from '../services/billing.js'

const invoiceRouter = Router()
const adminInvoiceRouter = Router()

invoiceRouter.use(authMiddleware)
adminInvoiceRouter.use(authMiddleware, adminMiddleware)

// ---------------------------------------------------------------------------
// User routes — mounted at /api/invoices
// ---------------------------------------------------------------------------

// GET /api/invoices — my invoices list
invoiceRouter.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, period_start, period_end, original_amount, discount_rate,
              token_credit_used, total_due, status, due_date, issued_at, paid_at, created_at
       FROM invoices
       WHERE user_id = $1
       ORDER BY period_start DESC`,
      [req.user!.userId],
    )
    res.json({ invoices: result.rows })
  } catch (err) {
    console.error('List invoices error:', err)
    res.status(500).json({ error: 'Failed to list invoices' })
  }
})

// GET /api/invoices/:id — invoice detail with items
invoiceRouter.get('/:id', async (req, res) => {
  try {
    const invoiceResult = await query(
      `SELECT id, user_id, period_start, period_end, original_amount, coupon_id,
              coupon_amount, discount_rate, token_credit_used, total_due,
              status, due_date, issued_at, paid_at, created_at
       FROM invoices
       WHERE id = $1`,
      [req.params.id],
    )

    if (invoiceResult.rows.length === 0) {
      res.status(404).json({ error: 'Invoice not found' })
      return
    }

    const invoice = invoiceResult.rows[0]

    // Verify ownership (non-admin)
    if (req.user!.role !== 'admin' && invoice.user_id !== req.user!.userId) {
      res.status(404).json({ error: 'Invoice not found' })
      return
    }

    const itemsResult = await query(
      `SELECT id, type, model, input_tokens, output_tokens, unit_cost, subtotal,
              total_cost, user_tokens, all_tokens, share_ratio, created_at
       FROM invoice_items
       WHERE invoice_id = $1
       ORDER BY type, model`,
      [invoice.id],
    )

    res.json({ invoice, items: itemsResult.rows })
  } catch (err) {
    console.error('Invoice detail error:', err)
    res.status(500).json({ error: 'Failed to get invoice detail' })
  }
})

// ---------------------------------------------------------------------------
// Admin routes — mounted at /api/admin/invoices (and sub-paths)
// ---------------------------------------------------------------------------

// POST /api/admin/invoices/generate — trigger invoice generation
adminInvoiceRouter.post('/generate', async (req, res) => {
  try {
    const { period_start, period_end } = req.body as { period_start?: string; period_end?: string }
    if (!period_start || !period_end) {
      res.status(400).json({ error: 'period_start and period_end are required (YYYY-MM-DD)' })
      return
    }

    const start = new Date(period_start + 'T00:00:00.000Z')
    const end = new Date(period_end + 'T23:59:59.999Z')

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      res.status(400).json({ error: 'Invalid date format' })
      return
    }

    const count = await generateMonthlyInvoices(start, end)
    res.json({ message: `Generated ${count} invoice(s)`, count })
  } catch (err) {
    console.error('Invoice generation error:', err)
    res.status(500).json({ error: 'Failed to generate invoices' })
  }
})

// ---------------------------------------------------------------------------
// Model pricing
// ---------------------------------------------------------------------------

// GET /api/admin/model-pricing
adminInvoiceRouter.get('/model-pricing', async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, model_pattern, input_mtok, output_mtok, cache_read_mtok, cache_write_mtok,
              effective_from, created_at
       FROM model_pricing
       ORDER BY model_pattern, effective_from DESC`,
    )
    res.json({ model_pricing: result.rows })
  } catch (err) {
    console.error('List model pricing error:', err)
    res.status(500).json({ error: 'Failed to list model pricing' })
  }
})

// POST /api/admin/model-pricing
adminInvoiceRouter.post('/model-pricing', async (req, res) => {
  try {
    const { model_pattern, input_mtok, output_mtok, cache_read_mtok, cache_write_mtok, effective_from } =
      req.body as {
        model_pattern?: string
        input_mtok?: number
        output_mtok?: number
        cache_read_mtok?: number
        cache_write_mtok?: number
        effective_from?: string
      }

    if (!model_pattern || input_mtok == null || output_mtok == null) {
      res.status(400).json({ error: 'model_pattern, input_mtok, and output_mtok are required' })
      return
    }

    const result = await query(
      `INSERT INTO model_pricing (model_pattern, input_mtok, output_mtok, cache_read_mtok, cache_write_mtok, effective_from)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        model_pattern,
        input_mtok,
        output_mtok,
        cache_read_mtok ?? 0,
        cache_write_mtok ?? 0,
        effective_from ?? new Date().toISOString().slice(0, 10),
      ],
    )
    res.status(201).json(result.rows[0])
  } catch (err: any) {
    console.error('Create model pricing error:', err)
    if (err.code === '23505') {
      res.status(409).json({ error: 'Pricing for this model_pattern + effective_from already exists' })
      return
    }
    res.status(500).json({ error: 'Failed to create model pricing' })
  }
})

// PATCH /api/admin/model-pricing/:id
adminInvoiceRouter.patch('/model-pricing/:id', async (req, res) => {
  try {
    const { input_mtok, output_mtok, cache_read_mtok, cache_write_mtok, effective_from } =
      req.body as {
        input_mtok?: number
        output_mtok?: number
        cache_read_mtok?: number
        cache_write_mtok?: number
        effective_from?: string
      }

    const fields: string[] = []
    const params: unknown[] = []
    let idx = 1

    if (input_mtok != null) { fields.push(`input_mtok = $${idx++}`); params.push(input_mtok) }
    if (output_mtok != null) { fields.push(`output_mtok = $${idx++}`); params.push(output_mtok) }
    if (cache_read_mtok != null) { fields.push(`cache_read_mtok = $${idx++}`); params.push(cache_read_mtok) }
    if (cache_write_mtok != null) { fields.push(`cache_write_mtok = $${idx++}`); params.push(cache_write_mtok) }
    if (effective_from !== undefined) { fields.push(`effective_from = $${idx++}`); params.push(effective_from) }

    if (fields.length === 0) {
      res.status(400).json({ error: 'No fields to update' })
      return
    }

    params.push(req.params.id)
    const result = await query(
      `UPDATE model_pricing SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params,
    )

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Model pricing not found' })
      return
    }

    res.json(result.rows[0])
  } catch (err: any) {
    console.error('Update model pricing error:', err)
    if (err.code === '23505') {
      res.status(409).json({ error: 'Pricing for this model_pattern + effective_from already exists' })
      return
    }
    res.status(500).json({ error: 'Failed to update model pricing' })
  }
})

export { invoiceRouter, adminInvoiceRouter }
