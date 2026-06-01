import { Router } from 'express'
import { query, DEPLOYMENT } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { verifySign, createPaymentUrl, getReturnUrl } from '../services/payment.js'

const paymentRouter = Router()

// ---------------------------------------------------------------------------
// POST /api/payments/create — initiate payment (requires auth)
// ---------------------------------------------------------------------------
paymentRouter.post('/create', authMiddleware, async (req, res) => {
  try {
    const { invoice_id, coupon_id } = req.body as { invoice_id?: string; coupon_id?: string }

    if (!invoice_id) {
      res.status(400).json({ error: 'invoice_id is required' })
      return
    }

    // 1. Verify invoice exists, belongs to user, status is 'issued' or 'overdue'
    const invoiceResult = await query(
      `SELECT id, user_id, total_due, status FROM invoices WHERE id = $1`,
      [invoice_id],
    )
    if (invoiceResult.rows.length === 0) {
      res.status(404).json({ error: 'Invoice not found' })
      return
    }
    const invoice = invoiceResult.rows[0]

    if (invoice.user_id !== req.user!.userId) {
      res.status(404).json({ error: 'Invoice not found' })
      return
    }

    if (invoice.status !== 'issued' && invoice.status !== 'overdue') {
      res.status(400).json({ error: `Invoice status is '${invoice.status}', cannot pay` })
      return
    }

    let finalAmount = Number(invoice.total_due)
    let couponAmount = 0

    // 2. If coupon_id: verify coupon belongs to user, is unused, not expired, meets min_order
    if (coupon_id) {
      const couponResult = await query(
        `SELECT id, user_id, amount, min_order, used, expires_at
         FROM coupons WHERE id = $1`,
        [coupon_id],
      )
      if (couponResult.rows.length === 0) {
        res.status(404).json({ error: 'Coupon not found' })
        return
      }
      const coupon = couponResult.rows[0]

      if (coupon.user_id !== req.user!.userId) {
        res.status(403).json({ error: 'Coupon does not belong to you' })
        return
      }
      if (coupon.used) {
        res.status(400).json({ error: 'Coupon already used' })
        return
      }
      if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
        res.status(400).json({ error: 'Coupon has expired' })
        return
      }
      if (coupon.min_order && finalAmount < Number(coupon.min_order)) {
        res.status(400).json({ error: `Order amount does not meet coupon minimum of ${coupon.min_order}` })
        return
      }

      couponAmount = Number(coupon.amount)
    }

    // 3. Calculate final amount
    finalAmount = Math.max(0, finalAmount - couponAmount)
    const amountStr = finalAmount.toFixed(2)

    // 4. Generate out_trade_no
    const outTradeNo = 'CCG-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)

    // 5. Create payment record in DB
    await query(
      `INSERT INTO payments (user_id, invoice_id, out_trade_no, amount, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [req.user!.userId, invoice_id, outTradeNo, amountStr],
    )

    // 6. If coupon used: update invoice coupon fields
    if (coupon_id) {
      await query(
        `UPDATE invoices SET coupon_id = $1, coupon_amount = $2 WHERE id = $3`,
        [coupon_id, couponAmount, invoice_id],
      )
    }

    // 7. Generate pay_url
    const payUrl = await createPaymentUrl(outTradeNo, amountStr, `Invoice ${invoice_id}`)

    // 8. Return
    res.json({ pay_url: payUrl, out_trade_no: outTradeNo })
  } catch (err) {
    console.error('Create payment error:', err)
    res.status(500).json({ error: 'Failed to create payment' })
  }
})

// ---------------------------------------------------------------------------
// POST /api/payments/notify — 易支付 async callback (NO auth)
// ---------------------------------------------------------------------------
paymentRouter.post('/notify', async (req, res) => {
  try {
    // Params come as query string or form body
    const params: Record<string, string> = {}
    const source = { ...req.query, ...req.body } as Record<string, unknown>
    for (const [k, v] of Object.entries(source)) {
      if (typeof v === 'string') params[k] = v
    }

    // 1. Verify sign
    if (!(await verifySign(params))) {
      res.type('text').send('fail')
      return
    }

    // 2. Check trade_status
    if (params.trade_status !== 'TRADE_SUCCESS') {
      res.type('text').send('fail')
      return
    }

    // 3. Find payment by out_trade_no
    const paymentResult = await query(
      `SELECT id, user_id, invoice_id, status FROM payments WHERE out_trade_no = $1`,
      [params.out_trade_no],
    )
    if (paymentResult.rows.length === 0) {
      res.type('text').send('fail')
      return
    }
    const payment = paymentResult.rows[0]

    // Idempotent: if already paid, just return success
    if (payment.status === 'paid') {
      res.type('text').send('success')
      return
    }

    const now = new Date().toISOString()

    // 4. Update payment
    await query(
      `UPDATE payments
       SET status = 'paid', trade_no = $1, paid_at = $2, raw_callback = $3
       WHERE id = $4`,
      [params.trade_no, now, JSON.stringify(params), payment.id],
    )

    // 5. Update invoice
    await query(
      `UPDATE invoices SET status = 'paid', paid_at = $1 WHERE id = $2`,
      [now, payment.invoice_id],
    )

    // Mark coupon as used if invoice had one
    await query(
      `UPDATE coupons SET used = true
       WHERE id = (SELECT coupon_id FROM invoices WHERE id = $1 AND coupon_id IS NOT NULL)`,
      [payment.invoice_id],
    )

    // 6. Check if user has any remaining overdue invoices
    const overdueResult = await query(
      `SELECT COUNT(*) AS cnt FROM invoices WHERE user_id = $1 AND status = 'overdue'`,
      [payment.user_id],
    )
    const hasOverdue = Number(overdueResult.rows[0].cnt) > 0

    // 7. If no overdue invoices: restore all suspended clients
    if (!hasOverdue) {
      await query(
        `UPDATE clients SET status = 'active', suspend_reason = NULL
         WHERE user_id = $1 AND status = 'suspended' AND deployment = $2`,
        [payment.user_id, DEPLOYMENT],
      )
    }

    // 8. Return plain text 'success'
    res.type('text').send('success')
  } catch (err) {
    console.error('Payment notify error:', err)
    res.type('text').send('fail')
  }
})

// ---------------------------------------------------------------------------
// GET /api/payments/return — 易支付 sync redirect (NO auth), preserves query
// ---------------------------------------------------------------------------
paymentRouter.get('/return', async (req, res) => {
  const returnUrl = await getReturnUrl()
  const qs = new URLSearchParams(req.query as Record<string, string>).toString()
  res.redirect(qs ? `${returnUrl}?${qs}` : returnUrl)
})

// ---------------------------------------------------------------------------
// GET /api/payments — my payment history (requires auth)
// ---------------------------------------------------------------------------
paymentRouter.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await query(
      `SELECT p.id, p.out_trade_no, p.trade_no, p.amount, p.status, p.paid_at, p.created_at,
              p.subscription_id,
              i.period_start, i.period_end, i.total_due AS invoice_total_due, i.status AS invoice_status,
              s.plan_id, pl.name AS plan_name, pl.type AS plan_type
       FROM payments p
       LEFT JOIN invoices i ON i.id = p.invoice_id
       LEFT JOIN subscriptions s ON s.id = p.subscription_id
       LEFT JOIN plans pl ON pl.id = s.plan_id
       WHERE p.user_id = $1
       ORDER BY p.created_at DESC`,
      [req.user!.userId],
    )
    res.json({ payments: result.rows })
  } catch (err) {
    console.error('List payments error:', err)
    res.status(500).json({ error: 'Failed to list payments' })
  }
})

export { paymentRouter }
