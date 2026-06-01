import bcrypt from 'bcryptjs'
import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { query, DEPLOYMENT } from '../db.js'
import { authMiddleware, generateTokens, JWT_REFRESH_SECRET, type JWTPayload } from '../middleware/auth.js'
import { sendMagicLink } from '../services/email.js'
import { generateMagicCode, verifyByCode, verifyByToken, consumeVerifiedToken } from '../services/verification.js'
import { recordAudit, audit } from '../services/audit.js'

const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{4,32}$/

const router = Router()

// ── Magic Link Flow ──

// POST /api/auth/send-code — send magic link + code to email
router.post('/send-code', async (req, res) => {
  try {
    const { email } = req.body
    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'Email is required' })
      return
    }

    // Check if user exists
    const existing = await query('SELECT id FROM users WHERE email = $1 AND deployment = $2', [email.toLowerCase().trim(), DEPLOYMENT])
    const isNewUser = existing.rows.length === 0

    const { code, token } = await generateMagicCode(email.toLowerCase().trim())
    await sendMagicLink(email.toLowerCase().trim(), code, token)

    res.json({ ok: true, isNewUser })
  } catch (err: any) {
    if (err.message === 'RATE_LIMITED') {
      res.status(429).json({ error: 'Please wait before requesting another code' })
      return
    }
    console.error('send-code error:', err)
    res.status(500).json({ error: 'Failed to send verification code' })
  }
})

// POST /api/auth/verify-code — verify 6-digit code
router.post('/verify-code', async (req, res) => {
  try {
    const { email, code } = req.body
    if (!email || !code) {
      res.status(400).json({ error: 'Email and code are required' })
      return
    }

    const result = await verifyByCode(email.toLowerCase().trim(), code)
    if (!result.valid) {
      res.status(400).json({ error: 'Invalid or expired code' })
      return
    }

    // Check if user exists
    const userResult = await query(
      'SELECT id, username, email, role, status FROM users WHERE email = $1 AND deployment = $2',
      [email.toLowerCase().trim(), DEPLOYMENT]
    )

    if (userResult.rows.length > 0) {
      // Existing user — log in directly
      const user = userResult.rows[0]
      if (user.status !== 'active') {
        res.status(403).json({ error: 'Account suspended' })
        return
      }
      const tokens = generateTokens({ userId: user.id, username: user.username, role: user.role })
      res.cookie('refresh_token', tokens.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      })
      res.json({
        user: { id: user.id, username: user.username, email: user.email, role: user.role },
        accessToken: tokens.accessToken,
      })
    } else {
      // New user — needs to complete registration
      res.json({ needsUsername: true, verifiedToken: result.token })
    }
  } catch (err: any) {
    console.error('verify-code error:', err)
    res.status(500).json({ error: 'Verification failed' })
  }
})

// GET /api/auth/callback?token=xxx — magic link click
router.get('/callback', async (req, res) => {
  try {
    const token = req.query.token as string
    if (!token) {
      res.redirect('/auth?error=invalid_token')
      return
    }

    const email = await verifyByToken(token)
    if (!email) {
      res.redirect('/auth?error=expired_token')
      return
    }

    // Check if user exists
    const userResult = await query(
      'SELECT id, username, email, role, status FROM users WHERE email = $1 AND deployment = $2',
      [email, DEPLOYMENT]
    )

    if (userResult.rows.length > 0) {
      // Existing user — log in
      const user = userResult.rows[0]
      if (user.status !== 'active') {
        res.redirect('/auth?error=suspended')
        return
      }
      const tokens = generateTokens({ userId: user.id, username: user.username, role: user.role })
      res.cookie('refresh_token', tokens.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      })
      // Redirect to frontend with access token in hash
      res.redirect(`/auth/callback?accessToken=${tokens.accessToken}`)
    } else {
      // New user — redirect to complete registration
      res.redirect(`/auth/callback?verifiedToken=${token}&email=${encodeURIComponent(email)}`)
    }
  } catch (err: any) {
    console.error('callback error:', err)
    res.redirect('/auth?error=server_error')
  }
})

// POST /api/auth/complete-register — new user completes registration
router.post('/complete-register', async (req, res) => {
  try {
    const { email, username, invite_code, verifiedToken } = req.body
    if (!email || !username || !verifiedToken) {
      res.status(400).json({ error: 'email, username, and verifiedToken are required' })
      return
    }

    // Consume the verified token
    const verifiedEmail = await consumeVerifiedToken(verifiedToken)
    if (!verifiedEmail || verifiedEmail !== email.toLowerCase().trim()) {
      res.status(400).json({ error: 'Email verification expired, please start over' })
      return
    }

    // Check duplicates
    const existing = await query(
      'SELECT id FROM users WHERE (username = $1 OR email = $2) AND deployment = $3',
      [username, email.toLowerCase().trim(), DEPLOYMENT]
    )
    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'Username or email already exists' })
      return
    }

    const result = await query(
      `INSERT INTO users (username, email, email_verified, deployment)
       VALUES ($1, $2, true, $3) RETURNING id, username, email, role, status, created_at`,
      [username, email.toLowerCase().trim(), DEPLOYMENT]
    )
    const user = result.rows[0]

    // The user is their own actor on self-registration.
    const forwarded = req.headers['x-forwarded-for']
    const forwardedStr = Array.isArray(forwarded) ? forwarded[0] : forwarded
    const ip = (forwardedStr?.split(',')[0].trim()) || req.ip || null
    const ua = req.headers['user-agent']
    await recordAudit(
      {
        actor_id: user.id,
        actor_email: user.username,
        ip,
        user_agent: typeof ua === 'string' ? ua : null,
      },
      {
        action: 'user.register',
        resource_type: 'user',
        resource_id: user.id,
        before: null,
        after: user,
        summary: `user ${user.username} registered`,
      },
    )

    // Handle invite code
    if (invite_code) {
      await processInviteCode(user.id, invite_code)
    }

    const tokens = generateTokens({ userId: user.id, username: user.username, role: user.role })

    res.cookie('refresh_token', tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    })

    res.status(201).json({ user, accessToken: tokens.accessToken })
  } catch (err: any) {
    console.error('complete-register error:', err)
    res.status(500).json({ error: 'Registration failed' })
  }
})

// ── Existing endpoints (kept) ──

// POST /api/auth/refresh
router.post('/refresh', (req, res) => {
  const token = req.cookies?.refresh_token
  if (!token) {
    res.status(401).json({ error: 'No refresh token' })
    return
  }
  try {
    const payload = jwt.verify(token, JWT_REFRESH_SECRET) as JWTPayload
    const tokens = generateTokens({ userId: payload.userId, username: payload.username, role: payload.role })

    res.cookie('refresh_token', tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    })

    res.json({ accessToken: tokens.accessToken })
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' })
  }
})

// POST /api/auth/logout
router.post('/logout', (_req, res) => {
  res.clearCookie('refresh_token')
  res.json({ ok: true })
})

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, username, email, role, status, invited_by, invite_bound_at,
              free_until, discount_rate, created_at
       FROM users WHERE id = $1 AND deployment = $2`,
      [req.user!.userId, DEPLOYMENT]
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' })
      return
    }
    res.json(result.rows[0])
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch user' })
  }
})

// PATCH /api/auth/me
router.patch('/me', authMiddleware, async (req, res) => {
  try {
    const { email, username } = req.body as { email?: unknown; username?: unknown }
    const updates: string[] = []
    const values: any[] = []
    let paramIdx = 1

    let normalizedUsername: string | undefined
    if (username !== undefined && username !== null) {
      if (typeof username !== 'string') {
        res.status(400).json({ error: '用户名格式无效' })
        return
      }
      normalizedUsername = username.trim()
      if (!USERNAME_RE.test(normalizedUsername)) {
        res.status(400).json({ error: '用户名需为 4-32 个字符，仅限字母、数字、下划线或中文' })
        return
      }
      const dup = await query(
        'SELECT 1 FROM users WHERE username = $1 AND id <> $2 AND deployment = $3',
        [normalizedUsername, req.user!.userId, DEPLOYMENT]
      )
      if (dup.rows.length > 0) {
        res.status(409).json({ error: '该用户名已被使用' })
        return
      }
      updates.push(`username = $${paramIdx++}`)
      values.push(normalizedUsername)
    }

    if (email !== undefined && email !== null) {
      if (typeof email !== 'string') {
        res.status(400).json({ error: '邮箱格式无效' })
        return
      }
      updates.push(`email = $${paramIdx++}`)
      values.push(email)
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No fields to update' })
      return
    }

    const beforeResult = await query(
      `SELECT id, email, username, role FROM users WHERE id = $1 AND deployment = $2`,
      [req.user!.userId, DEPLOYMENT]
    )
    const before = beforeResult.rows[0] ?? null

    updates.push(`updated_at = now()`)
    values.push(req.user!.userId)
    values.push(DEPLOYMENT)
    const deploymentIdx = paramIdx + 1

    const result = await query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIdx} AND deployment = $${deploymentIdx}
       RETURNING id, username, email, role, status`,
      values
    )

    const after = result.rows[0]
    await audit(req, {
      action: 'user.update',
      resource_type: 'user',
      resource_id: req.user!.userId,
      before,
      after,
      summary: 'user updated profile',
    })

    res.json(after)
  } catch (err: any) {
    if (err && err.code === '23505') {
      res.status(409).json({ error: '该用户名已被使用' })
      return
    }
    res.status(500).json({ error: 'Update failed' })
  }
})

// ── Helper ──

async function processInviteCode(userId: string, code: string): Promise<void> {
  try {
    const ic = await query(
      `SELECT ic.id, ic.campaign_id, ic.owner_id, ic.max_uses, ic.used_count, ic.status,
              c.status AS campaign_status, c.end_at
       FROM invite_codes ic
       JOIN campaigns c ON ic.campaign_id = c.id
       WHERE ic.code = $1`,
      [code]
    )
    if (ic.rows.length === 0) return
    const invite = ic.rows[0]
    if (invite.status !== 'active') return
    if (invite.campaign_status !== 'active') return
    if (invite.end_at && new Date(invite.end_at) < new Date()) return
    if (invite.used_count >= invite.max_uses) return
    if (invite.owner_id === userId) return

    await query(
      `INSERT INTO invite_bindings (invite_code_id, inviter_id, invitee_id)
       VALUES ($1, $2, $3)`,
      [invite.id, invite.owner_id, userId]
    )
    await query(
      `UPDATE invite_codes SET used_count = used_count + 1,
       status = CASE WHEN used_count + 1 >= max_uses THEN 'exhausted' ELSE status END
       WHERE id = $1`,
      [invite.id]
    )
    await query(
      'UPDATE campaigns SET current_uses = current_uses + 1 WHERE id = $1',
      [invite.campaign_id]
    )
    await query(
      'UPDATE users SET invited_by = $1, invite_bound_at = now() WHERE id = $2 AND deployment = $3',
      [invite.owner_id, userId, DEPLOYMENT]
    )
  } catch (err) {
    console.error('Failed to process invite code:', err)
  }
}


// ── Password Login (added by deployment patch) ──
// POST /api/auth/login (password) — username + password authentication
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body
    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' })
      return
    }
    const userResult = await query(
      'SELECT id, username, email, role, status, password_hash FROM users WHERE (username = $1 OR email = $1) AND deployment = $2',
      [String(username).trim(), DEPLOYMENT],
    )
    if (userResult.rows.length === 0) {
      res.status(401).json({ error: 'Invalid credentials' })
      return
    }
    const user = userResult.rows[0]
    if (!user.password_hash) {
      res.status(401).json({ error: 'Password login not available for this account' })
      return
    }
    const ok = await bcrypt.compare(String(password), user.password_hash)
    if (!ok) {
      res.status(401).json({ error: 'Invalid credentials' })
      return
    }
    if (user.status !== 'active') {
      res.status(403).json({ error: 'Account suspended' })
      return
    }
    const tokens = generateTokens({ userId: user.id, username: user.username, role: user.role })
    res.cookie('refresh_token', tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    })
    res.json({
      user: { id: user.id, username: user.username, email: user.email, role: user.role },
      accessToken: tokens.accessToken,
    })
  } catch (err: any) {
    console.error('login error:', err)
    res.status(500).json({ error: 'Login failed' })
  }
})


export default router
