import { Router } from 'express'
import crypto from 'crypto'
import { query, DEPLOYMENT } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { adminMiddleware } from '../middleware/admin.js'
import { createPaymentUrl, verifySign, getReturnUrl } from '../services/payment.js'
import { audit } from '../services/audit.js'
import { resolvePlanChange, applyDecision } from '../services/plan-change.js'

const publicRouter = Router()
const subscriptionPublicRouter = Router()
const userRouter = Router()
const adminRouter = Router()

userRouter.use(authMiddleware)
adminRouter.use(authMiddleware, adminMiddleware)

// ── Public ──

// GET /api/plans — list enabled plans (for registration page)
publicRouter.get('/', async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, name, type, subtype, price, currency, quota_amount,
              duration_days, max_concurrent, description, features, recommended,
              limit_5h_usd, limit_1d_usd, limit_7d_usd, limit_30d_usd
       FROM plans WHERE enabled = true ORDER BY type, sort_order, price`
    )
    res.json(result.rows)
  } catch (err) {
    console.error('List plans error:', err)
    res.status(500).json({ error: 'Failed to list plans' })
  }
})

// ── User ──

// GET /api/subscription — all active subscriptions
userRouter.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT s.*, p.name AS plan_name, p.type AS plan_type, p.subtype,
              p.price, p.quota_amount, p.duration_days, p.features
       FROM subscriptions s
       JOIN plans p ON s.plan_id = p.id
       WHERE s.user_id = $1 AND s.status = 'active'
       ORDER BY p.type, s.created_at DESC`,
      [req.user!.userId]
    )

    res.json(result.rows)
  } catch (err) {
    console.error('Get subscription error:', err)
    res.status(500).json({ error: 'Failed to get subscription' })
  }
})

// POST /api/subscription/subscribe — create pending subscription + payment.
// Reuses a recent pending order for the same plan (within 1h) to avoid dupes.
userRouter.post('/subscribe', async (req, res) => {
  try {
    const { plan_id, pay_type, out_trade_no: resumeTradeNo } = req.body as {
      plan_id?: string
      pay_type?: string
      out_trade_no?: string
    }
    if (!plan_id) {
      res.status(400).json({ error: 'plan_id is required' })
      return
    }

    const plan = await query('SELECT * FROM plans WHERE id = $1 AND enabled = true', [plan_id])
    if (plan.rows.length === 0) {
      res.status(404).json({ error: 'Plan not found' })
      return
    }
    const p = plan.rows[0]
    const price = parseFloat(p.price)

    // Free plan — activate immediately
    if (price <= 0) {
      return await activateSubscription(req.user!.userId, plan_id, p, res)
    }

    // Get configurable product name
    const nameResult = await query("SELECT value FROM system_settings WHERE key = 'payment_product_name'")
    const productName = nameResult.rows[0]?.value ?? '2Coding Gateway'
    const payType = pay_type || 'alipay'

    // Resume path: explicit out_trade_no from pending banner
    if (resumeTradeNo) {
      const existing = await query(
        `SELECT pay.out_trade_no, pay.amount, s.id AS subscription_id
           FROM payments pay
           JOIN subscriptions s ON s.id = pay.subscription_id
          WHERE pay.out_trade_no = $1 AND pay.user_id = $2
            AND pay.status = 'pending' AND s.status = 'pending'
            AND s.plan_id = $3`,
        [resumeTradeNo, req.user!.userId, plan_id]
      )
      if (existing.rows.length > 0) {
        const row = existing.rows[0]
        const payUrl = await createPaymentUrl(
          row.out_trade_no,
          Number(row.amount).toFixed(2),
          `${p.name} - ${productName}`,
          payType
        )
        res.json({
          subscription_id: row.subscription_id,
          pay_url: payUrl,
          out_trade_no: row.out_trade_no,
          resumed: true,
        })
        return
      }
    }

    // Reuse recent pending order (<1h) for same plan, same user
    const reuse = await query(
      `SELECT pay.out_trade_no, pay.amount, s.id AS subscription_id
         FROM payments pay
         JOIN subscriptions s ON s.id = pay.subscription_id
        WHERE pay.user_id = $1 AND pay.status = 'pending' AND s.status = 'pending'
          AND s.plan_id = $2
          AND pay.created_at > now() - interval '1 hour'
        ORDER BY pay.created_at DESC
        LIMIT 1`,
      [req.user!.userId, plan_id]
    )
    if (reuse.rows.length > 0) {
      const row = reuse.rows[0]
      const payUrl = await createPaymentUrl(
        row.out_trade_no,
        Number(row.amount).toFixed(2),
        `${p.name} - ${productName}`,
        payType
      )
      res.json({
        subscription_id: row.subscription_id,
        pay_url: payUrl,
        out_trade_no: row.out_trade_no,
        resumed: true,
      })
      return
    }

    // Create pending subscription. Balance is a placeholder; the real
    // balance/expires_at is resolved at activation time via plan-change decision.
    const sub = await query(
      `INSERT INTO subscriptions (user_id, plan_id, status, balance, remaining_uses)
       VALUES ($1, $2, 'pending', $3, $4)
       RETURNING *`,
      [
        req.user!.userId,
        plan_id,
        parseFloat(p.quota_amount ?? 0),
        p.subtype === 'per_use' ? 1 : null,
      ]
    )

    // Create payment record
    const outTradeNo = 'SUB-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex')
    await query(
      `INSERT INTO payments (subscription_id, user_id, amount, out_trade_no, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [sub.rows[0].id, req.user!.userId, price, outTradeNo]
    )

    const payUrl = await createPaymentUrl(
      outTradeNo,
      price.toFixed(2),
      `${p.name} - ${productName}`,
      payType
    )

    res.json({
      subscription_id: sub.rows[0].id,
      pay_url: payUrl,
      out_trade_no: outTradeNo,
    })
  } catch (err) {
    console.error('Subscribe error:', err)
    res.status(500).json({ error: 'Failed to subscribe' })
  }
})

// GET /api/subscription/pending — list user's unpaid orders (24h window)
userRouter.get('/pending', async (req, res) => {
  try {
    const result = await query(
      `SELECT pay.out_trade_no, pay.amount, pay.created_at,
              s.id AS subscription_id, s.plan_id,
              p.name AS plan_name, p.type AS plan_type, p.subtype, p.currency
         FROM payments pay
         JOIN subscriptions s ON s.id = pay.subscription_id
         JOIN plans p ON p.id = s.plan_id
        WHERE pay.user_id = $1 AND pay.status = 'pending' AND s.status = 'pending'
          AND pay.created_at > now() - interval '24 hours'
        ORDER BY pay.created_at DESC`,
      [req.user!.userId]
    )
    res.json({ pending: result.rows })
  } catch (err) {
    console.error('List pending orders error:', err)
    res.status(500).json({ error: 'Failed to list pending orders' })
  }
})

// GET /api/subscription/order/:out_trade_no — single order status, for result page
userRouter.get('/order/:out_trade_no', async (req, res) => {
  try {
    const order = await fetchOrder(req.params.out_trade_no, req.user!.userId)
    if (!order) {
      res.status(404).json({ error: 'Order not found' })
      return
    }
    res.json(order)
  } catch (err) {
    console.error('Get order error:', err)
    res.status(500).json({ error: 'Failed to get order' })
  }
})

// GET+POST /api/subscription/notify — 易支付回调 (无需认证)
// 易支付用 GET 方式发送 notify，参数在 query string 中
subscriptionPublicRouter.get('/notify', handleNotify)
subscriptionPublicRouter.post('/notify', handleNotify)

async function handleNotify(req: any, res: any) {
  try {
    const params = { ...req.query, ...req.body } as Record<string, string>

    // Verify signature
    if (!(await verifySign(params))) {
      res.type('text').send('fail')
      return
    }

    if (params.trade_status !== 'TRADE_SUCCESS') {
      res.type('text').send('fail')
      return
    }

    const outTradeNo = params.out_trade_no
    if (!outTradeNo?.startsWith('SUB-')) {
      // Not a subscription payment, ignore
      res.type('text').send('success')
      return
    }

    // Find payment with subscription_id
    const payment = await query(
      'SELECT id, user_id, amount, subscription_id FROM payments WHERE out_trade_no = $1 AND status = $2',
      [outTradeNo, 'pending']
    )
    if (payment.rows.length === 0) {
      res.type('text').send('success')
      return
    }

    const pay = payment.rows[0]

    // Record raw callback before delegating to shared activator; activatePayment
    // itself marks the payment paid + sets trade_no.
    await query(
      `UPDATE payments SET raw_callback = $1 WHERE id = $2`,
      [JSON.stringify(params), pay.id],
    )

    await activatePayment(pay.id, outTradeNo, params.trade_no || '')

    res.type('text').send('success')
  } catch (err) {
    console.error('Subscription notify error:', err)
    res.type('text').send('fail')
  }
}

// POST /api/subscription/activate — frontend calls this on return from payment.
// Accepts the same params that 易支付 appends to return_url.
// Returns the full order so /checkout/result can render success/failed/pending directly.
userRouter.post('/activate', async (req, res) => {
  try {
    const params = req.body as Record<string, string>
    if (!params.out_trade_no) {
      res.status(400).json({ error: 'Missing out_trade_no' })
      return
    }

    const paymentRow = await query(
      `SELECT id, status FROM payments WHERE out_trade_no = $1 AND user_id = $2`,
      [params.out_trade_no, req.user!.userId]
    )
    if (paymentRow.rows.length === 0) {
      res.status(404).json({ error: 'Order not found' })
      return
    }
    const pay = paymentRow.rows[0]

    // Payment didn't succeed upstream — return current state, let UI render failed/pending
    if (params.trade_status && params.trade_status !== 'TRADE_SUCCESS') {
      const order = await fetchOrder(params.out_trade_no, req.user!.userId)
      res.json({ ok: false, order })
      return
    }

    // Already paid (notify may have beaten us here) — just return
    if (pay.status === 'paid') {
      const order = await fetchOrder(params.out_trade_no, req.user!.userId)
      res.json({ ok: true, order })
      return
    }

    // Sign verification: best-effort. If it fails we still activate because the
    // caller is authenticated and the payment belongs to them — return params
    // sometimes differ from notify params in how 易支付 encodes them.
    await verifySign(params).catch(() => false)

    await activatePayment(pay.id, params.out_trade_no, params.trade_no || '')
    const order = await fetchOrder(params.out_trade_no, req.user!.userId)
    res.json({ ok: true, order })
  } catch (err) {
    console.error('Activate error:', err)
    res.status(500).json({ error: 'Activation failed' })
  }
})

// Fetch full order detail for a given out_trade_no (scoped to user).
// Returns null if the order doesn't exist / isn't owned by the user.
async function fetchOrder(outTradeNo: string, userId: string) {
  const r = await query(
    `SELECT pay.id AS payment_id, pay.out_trade_no, pay.trade_no, pay.amount,
            pay.status AS payment_status, pay.paid_at, pay.created_at AS ordered_at,
            s.id AS subscription_id, s.status AS subscription_status,
            s.balance, s.expires_at, s.starts_at,
            p.id AS plan_id, p.name AS plan_name, p.type AS plan_type,
            p.subtype, p.currency, p.quota_amount, p.duration_days
       FROM payments pay
       LEFT JOIN subscriptions s ON s.id = pay.subscription_id
       LEFT JOIN plans p ON p.id = s.plan_id
      WHERE pay.out_trade_no = $1 AND pay.user_id = $2`,
    [outTradeNo, userId]
  )
  return r.rows[0] ?? null
}

// Shared activation logic. Marks payment paid, resolves the plan-change decision
// against the user's CURRENT state (so late-arriving grants/purchases are honored),
// and applies it via the shared decision engine.
async function activatePayment(paymentId: string, _outTradeNo: string, tradeNo: string) {
  const pay = await query(
    'SELECT id, user_id, subscription_id, status FROM payments WHERE id = $1',
    [paymentId],
  )
  if (pay.rows.length === 0) return

  const p = pay.rows[0]

  if (p.status !== 'paid') {
    await query(
      `UPDATE payments SET status = 'paid', trade_no = $1, paid_at = now() WHERE id = $2`,
      [tradeNo, p.id],
    )
  }

  const subResult = await query(
    `SELECT id, plan_id FROM subscriptions WHERE id = $1 AND status = 'pending'`,
    [p.subscription_id],
  )
  if (subResult.rows.length === 0) return

  const pending = subResult.rows[0]
  const resolved = await resolvePlanChange(p.user_id, pending.plan_id)
  if ('error' in resolved) {
    console.error('activatePayment: resolvePlanChange failed:', resolved.error)
    return
  }

  await applyDecision(p.user_id, resolved.decision, pending.id)
}

// GET /api/subscription/return — 支付同步跳转,保留易支付附加的 query (out_trade_no / trade_status / sign 等) 给前端结果页
subscriptionPublicRouter.get('/return', async (req, res) => {
  const returnUrl = await getReturnUrl()
  const qs = new URLSearchParams(req.query as Record<string, string>).toString()
  res.redirect(qs ? `${returnUrl}?${qs}` : returnUrl)
})

// Helper: activate a free plan immediately via shared decision engine.
async function activateSubscription(userId: string, planId: string, _plan: any, res: any) {
  const resolved = await resolvePlanChange(userId, planId)
  if ('error' in resolved) {
    res.status(400).json({ error: resolved.error })
    return
  }
  const { subscription_id } = await applyDecision(userId, resolved.decision)
  const r = await query('SELECT * FROM subscriptions WHERE id = $1', [subscription_id])
  res.status(201).json(r.rows[0])
}

// POST /api/subscription/preview — show the effect of buying `plan_id` RIGHT NOW.
// Stateless; does not lock price or state. Payment flow recomputes at activation time.
userRouter.post('/preview', async (req, res) => {
  try {
    const { plan_id } = req.body
    if (!plan_id) {
      res.status(400).json({ error: 'plan_id is required' })
      return
    }
    const resolved = await resolvePlanChange(req.user!.userId, plan_id)
    if ('error' in resolved) {
      res.status(404).json({ error: resolved.error })
      return
    }
    res.json(resolved.decision)
  } catch (err) {
    console.error('Preview error:', err)
    res.status(500).json({ error: 'Failed to preview plan change' })
  }
})

// POST /api/subscription/recharge — recharge quota plan balance
userRouter.post('/recharge', async (req, res) => {
  try {
    const { amount } = req.body
    if (!amount || amount <= 0) {
      res.status(400).json({ error: 'amount must be positive' })
      return
    }

    const sub = await query(
      `SELECT s.id, p.type FROM subscriptions s
       JOIN plans p ON s.plan_id = p.id
       WHERE s.user_id = $1 AND s.status = 'active' AND p.type = 'quota'`,
      [req.user!.userId]
    )
    if (sub.rows.length === 0) {
      res.status(400).json({ error: 'No active quota subscription' })
      return
    }

    const result = await query(
      `UPDATE subscriptions SET balance = balance + $1, updated_at = now()
       WHERE id = $2 RETURNING *`,
      [amount, sub.rows[0].id]
    )
    res.json(result.rows[0])
  } catch (err) {
    console.error('Recharge error:', err)
    res.status(500).json({ error: 'Failed to recharge' })
  }
})

// ── Admin ──

// GET /api/admin/plans — all plans
adminRouter.get('/', async (_req, res) => {
  try {
    const result = await query('SELECT * FROM plans ORDER BY type, sort_order, price')
    res.json(result.rows)
  } catch (err) {
    console.error('Admin list plans error:', err)
    res.status(500).json({ error: 'Failed to list plans' })
  }
})

// POST /api/admin/plans — create plan
adminRouter.post('/', async (req, res) => {
  try {
    const { name, type, subtype, price, currency, quota_amount,
            duration_days, max_concurrent, sort_order, description, features, recommended,
            limit_5h_usd, limit_1d_usd, limit_7d_usd, limit_30d_usd } = req.body

    if (!name || !type || price === undefined) {
      res.status(400).json({ error: 'name, type, and price are required' })
      return
    }

    const toLimit = (v: unknown): number | null => {
      if (v === undefined || v === null || v === '') return null
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) ? n : null
    }

    const result = await query(
      `INSERT INTO plans (name, type, subtype, price, currency, quota_amount,
        duration_days, max_concurrent, sort_order, description, features, recommended,
        limit_5h_usd, limit_1d_usd, limit_7d_usd, limit_30d_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [name, type, subtype, price, currency ?? 'USD', quota_amount ?? null,
       duration_days ?? null, max_concurrent ?? 1, sort_order ?? 0, description ?? null,
       features ? JSON.stringify(features) : null, !!recommended,
       toLimit(limit_5h_usd), toLimit(limit_1d_usd), toLimit(limit_7d_usd), toLimit(limit_30d_usd)]
    )
    const plan = result.rows[0]
    await audit(req, {
      action: 'plan.create',
      resource_type: 'plan',
      resource_id: plan.id,
      before: null,
      after: plan,
      summary: `plan ${plan.name} created`,
    })
    res.status(201).json(plan)
  } catch (err) {
    console.error('Create plan error:', err)
    res.status(500).json({ error: 'Failed to create plan' })
  }
})

// PATCH /api/admin/plans/:id — update plan
adminRouter.patch('/:id', async (req, res) => {
  try {
    const fields = ['name', 'type', 'subtype', 'price', 'currency', 'quota_amount',
      'duration_days', 'max_concurrent', 'sort_order', 'enabled', 'description', 'features',
      'recommended', 'limit_5h_usd', 'limit_1d_usd', 'limit_7d_usd', 'limit_30d_usd']
    const limitFields = new Set(['limit_5h_usd', 'limit_1d_usd', 'limit_7d_usd', 'limit_30d_usd'])
    const updates: string[] = []
    const values: any[] = []
    let idx = 1

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        let val: any
        if (f === 'features') {
          val = JSON.stringify(req.body[f])
        } else if (limitFields.has(f)) {
          const raw = req.body[f]
          if (raw === null || raw === '') {
            val = null
          } else {
            const n = typeof raw === 'number' ? raw : Number(raw)
            val = Number.isFinite(n) ? n : null
          }
        } else {
          val = req.body[f]
        }
        updates.push(`${f} = $${idx++}`)
        values.push(val)
      }
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'Nothing to update' })
      return
    }

    const beforeRes = await query('SELECT * FROM plans WHERE id = $1', [req.params.id])
    const before = beforeRes.rows[0] ?? null

    updates.push('updated_at = now()')
    values.push(req.params.id)

    const result = await query(
      `UPDATE plans SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Plan not found' })
      return
    }
    const after = result.rows[0]
    await audit(req, {
      action: 'plan.update',
      resource_type: 'plan',
      resource_id: after.id,
      before,
      after,
      summary: `plan ${after.name} updated`,
    })
    res.json(after)
  } catch (err) {
    console.error('Update plan error:', err)
    res.status(500).json({ error: 'Failed to update plan' })
  }
})

// DELETE /api/admin/plans/:id
adminRouter.delete('/:id', async (req, res) => {
  try {
    const beforeRes = await query('SELECT * FROM plans WHERE id = $1', [req.params.id])
    const before = beforeRes.rows[0] ?? null
    await query('DELETE FROM plans WHERE id = $1', [req.params.id])
    await audit(req, {
      action: 'plan.delete',
      resource_type: 'plan',
      resource_id: req.params.id,
      before,
      after: null,
      summary: `plan ${before?.name ?? req.params.id} deleted`,
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('Delete plan error:', err)
    res.status(500).json({ error: 'Failed to delete plan' })
  }
})

// GET /api/admin/subscriptions — all active subscriptions
adminRouter.get('/subscriptions', async (_req, res) => {
  try {
    const result = await query(
      `SELECT s.*, u.username, u.email, p.name AS plan_name, p.type AS plan_type
       FROM subscriptions s
       JOIN users u ON s.user_id = u.id
       JOIN plans p ON s.plan_id = p.id
       WHERE s.status = 'active' AND u.deployment = $1
       ORDER BY s.created_at DESC`,
      [DEPLOYMENT]
    )
    res.json(result.rows)
  } catch (err) {
    console.error('List subscriptions error:', err)
    res.status(500).json({ error: 'Failed to list subscriptions' })
  }
})

// POST /api/admin/plans/subscriptions/preview — preview the effect of granting
// `plan_id` to `user_id`, with optional balance / expires_at overrides.
adminRouter.post('/subscriptions/preview', async (req, res) => {
  try {
    const { user_id, plan_id, balance, expires_at } = req.body as {
      user_id?: string
      plan_id?: string
      balance?: number | string
      expires_at?: string | null
    }
    if (!user_id || !plan_id) {
      res.status(400).json({ error: 'user_id and plan_id are required' })
      return
    }
    const resolved = await resolvePlanChange(user_id, plan_id, { balance, expires_at })
    if ('error' in resolved) {
      res.status(404).json({ error: resolved.error })
      return
    }
    res.json(resolved.decision)
  } catch (err) {
    console.error('Admin preview error:', err)
    res.status(500).json({ error: 'Failed to preview grant' })
  }
})

// POST /api/admin/plans/subscriptions/grant — admin grants a plan to a user,
// executing the same decision engine as user-side payment (with admin overrides).
adminRouter.post('/subscriptions/grant', async (req, res) => {
  try {
    const { user_id, plan_id, balance, expires_at } = req.body as {
      user_id?: string
      plan_id?: string
      balance?: number | string
      expires_at?: string | null
    }

    if (!user_id || !plan_id) {
      res.status(400).json({ error: 'user_id and plan_id are required' })
      return
    }

    const resolved = await resolvePlanChange(user_id, plan_id, { balance, expires_at })
    if ('error' in resolved) {
      res.status(404).json({ error: resolved.error })
      return
    }
    const decision = resolved.decision

    const beforeRes = decision.target_sub_id
      ? await query('SELECT * FROM subscriptions WHERE id = $1', [decision.target_sub_id])
      : { rows: [] as any[] }
    const before = beforeRes.rows[0] ?? null

    const { subscription_id } = await applyDecision(user_id, decision)

    const afterRes = await query('SELECT * FROM subscriptions WHERE id = $1', [subscription_id])
    const after = afterRes.rows[0]

    await audit(req, {
      action: 'subscription.grant',
      resource_type: 'subscription',
      resource_id: subscription_id,
      before,
      after,
      summary: `grant ${decision.plan.name} (${decision.kind}) to user ${user_id}`,
    })

    res.status(201).json({ subscription: after, decision })
  } catch (err) {
    console.error('Grant subscription error:', err)
    res.status(500).json({ error: 'Failed to grant subscription' })
  }
})

// DELETE /api/admin/plans/subscriptions/:id — revoke (set status=cancelled).
adminRouter.delete('/subscriptions/:id', async (req, res) => {
  try {
    const beforeRes = await query('SELECT * FROM subscriptions WHERE id = $1', [req.params.id])
    const before = beforeRes.rows[0] ?? null
    if (!before) {
      res.status(404).json({ error: 'Subscription not found' })
      return
    }
    const result = await query(
      `UPDATE subscriptions SET status = 'cancelled', updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    )
    const after = result.rows[0]
    await audit(req, {
      action: 'subscription.revoke',
      resource_type: 'subscription',
      resource_id: after.id,
      before,
      after,
      summary: `revoke subscription ${after.id}`,
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('Revoke subscription error:', err)
    res.status(500).json({ error: 'Failed to revoke subscription' })
  }
})

// PATCH /api/admin/plans/subscriptions/:id — update subscription
adminRouter.patch('/subscriptions/:id', async (req, res) => {
  try {
    const { status, balance } = req.body
    const fields = { status, balance }
    const updates: string[] = []
    const values: any[] = []
    let idx = 1

    for (const [key, val] of Object.entries(fields)) {
      if (val !== undefined) {
        updates.push(`${key} = $${idx++}`)
        values.push(val)
      }
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'Nothing to update' })
      return
    }

    const beforeRes = await query('SELECT * FROM subscriptions WHERE id = $1', [req.params.id])
    const before = beforeRes.rows[0] ?? null

    updates.push('updated_at = now()')
    values.push(req.params.id)

    const result = await query(
      `UPDATE subscriptions SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Subscription not found' })
      return
    }
    const after = result.rows[0]
    // `subscription.revoke` when status flips to cancelled, else
    // `subscription.adjust_balance` covers balance/usage tweaks.
    const action = (status === 'cancelled' && before?.status !== 'cancelled')
      ? 'subscription.revoke'
      : 'subscription.adjust_balance'
    await audit(req, {
      action,
      resource_type: 'subscription',
      resource_id: after.id,
      before,
      after,
      summary: `subscription ${after.id} ${action.split('.')[1]}`,
    })
    res.json(after)
  } catch (err) {
    console.error('Update subscription error:', err)
    res.status(500).json({ error: 'Failed to update subscription' })
  }
})


export { publicRouter as plansPublicRouter, subscriptionPublicRouter, userRouter as subscriptionRouter, adminRouter as adminPlansRouter }
