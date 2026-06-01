/**
 * 公开号池状态页 API
 * GET /api/public/pool-status
 *
 * - 无需登录,任何人可访问
 * - 邮箱脱敏(前后省略)
 * - 不返回任何敏感字段(token / proxy / cost / banned_at 详细等)
 * - IP rate-limit: 每 IP 每分钟最多 30 次
 *
 * 客户用这个页面看实时号池状态,但看不到任何能复制利用的东西。
 */
import { Router, Request, Response, NextFunction } from 'express'
import { query } from '../db.js'
import { getRedis } from '../redis.js'

const router = Router()

// ── IP rate-limit (Redis-backed, fail-open) ──────────────────────────
const RATE_LIMIT_PER_MIN = 30

function clientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim()
  }
  return req.socket.remoteAddress ?? 'unknown'
}

async function rateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  const redis = getRedis()
  if (!redis) {
    // Fail-open if Redis unavailable; metric isn't security-critical
    next()
    return
  }
  const ip = clientIp(req)
  const key = `pubratelimit:${ip}`
  try {
    const count = await redis.incr(key)
    if (count === 1) {
      await redis.expire(key, 60)
    }
    if (count > RATE_LIMIT_PER_MIN) {
      res.status(429).json({ error: 'Too many requests, please slow down' })
      return
    }
  } catch {
    // Fail-open on Redis errors
  }
  next()
}

// ── Email masking ─────────────────────────────────────────────────────
// castroecomm@gmail.com  →  c***mm@***.com
// 8co.design@gmail.com   →  8***gn@***.com
// y@x.com                →  y***@***.com
function maskEmail(email: string): string {
  if (!email || typeof email !== 'string') return '***'
  const [u, d] = email.split('@')
  if (!u || !d) return '***'
  const uMasked = u.length <= 3
    ? u[0] + '***'
    : u[0] + '***' + u.slice(-2)
  const dotIdx = d.indexOf('.')
  const tld = dotIdx > 0 ? d.slice(dotIdx) : ''
  const dMasked = '***' + tld
  return `${uMasked}@${dMasked}`
}

// ── Classification (mirrors web/AdminAccountsPage.tsx classifyAccount) ─
// 退款 — Max 号退款后被降到 Free/Pro,Anthropic 返这个 specific 错误
const REFUNDED_MARKERS = [
  'oauth authentication is currently not allowed',
]
const BANNED_MARKERS = [
  'organization has been disabled',
  'organization is disabled',
  'organization_disabled',
  'oauth token has been revoked',
  'not allowed for this organization',
]
const INVALID_MARKERS = [
  'invalid authentication credentials',
  'authentication_error',
  'invalid x-api-key',
  'invalid_grant',
  'refresh token not found',
  'oauth refresh token is invalid',
  'upstream 401 + refresh failed',
]

type Category = 'normal' | 'cooldown' | 'invalid' | 'banned' | 'refunded' | 'error_misc' | 'unknown'

function classify(row: {
  status: string
  last_error: string | null
  in_cooldown: boolean
}): Category {
  if (row.status === 'active') {
    return row.in_cooldown ? 'cooldown' : 'normal'
  }
  const err = (row.last_error || '').toLowerCase()
  // 退款 must be checked BEFORE banned because the refund marker substring overlaps
  // with banned marker 'not allowed for this organization'.
  if (REFUNDED_MARKERS.some((m) => err.includes(m))) return 'refunded'
  if (BANNED_MARKERS.some((m) => err.includes(m))) return 'banned'
  if (INVALID_MARKERS.some((m) => err.includes(m))) return 'invalid'
  if (row.status === 'error') return 'error_misc'
  return 'unknown'
}

// Friendly subscription label
function subscriptionLabel(accountType: string | null): string {
  switch ((accountType || '').toLowerCase()) {
    case 'max20': return 'Max 20x'
    case 'max5': return 'Max 5x'
    case 'max': return 'Max'
    case 'pro': return 'Pro'
    case 'default_raven': return 'Raven'
    case 'free': return 'Free'
    default: return accountType || '-'
  }
}

// ── GET /api/public/pool-status ───────────────────────────────────────
router.get('/pool-status', rateLimit, async (_req: Request, res: Response) => {
  try {
    // Fetch active accounts + recent stats
    const accountsResult = await query<{
      id: string
      email: string | null
      account_type: string | null
      status: string
      last_error: string | null
      canonical_identity: any
    }>(
      `SELECT id, name AS email, account_type, status, last_error, canonical_identity
         FROM oauth_accounts
        WHERE status IN ('active', 'error', 'disabled')
          AND LOWER(account_type) IN ('max', 'max5', 'max20')
        ORDER BY name`,
      [],
    )

    const redis = getRedis()
    const accountList: Array<{
      email_masked: string
      subscription: string
      status_category: Category
      util_5h_pct: number | null
      rpm: number
      req_24h: number
    }> = []

    // Bulk fetch redis state per account
    const accountIds = accountsResult.rows.map((r) => r.id)
    const cooldownMap = new Map<string, boolean>()
    const rpmMap = new Map<string, number>()
    const util5hMap = new Map<string, number | null>()

    if (redis && accountIds.length > 0) {
      try {
        const pipe = redis.pipeline()
        for (const aid of accountIds) {
          pipe.exists(`cooldown:${aid}`)
          pipe.zcard(`rpm:${aid}`)
          pipe.get(`claude_utilization:${aid}`)
        }
        const results = (await pipe.exec()) ?? []
        for (let i = 0; i < accountIds.length; i++) {
          const aid = accountIds[i]
          const cdExists = results[i * 3]?.[1] as number | undefined
          const rpmVal = results[i * 3 + 1]?.[1] as number | undefined
          const utilJson = results[i * 3 + 2]?.[1] as string | undefined
          cooldownMap.set(aid, (cdExists ?? 0) > 0)
          rpmMap.set(aid, rpmVal ?? 0)
          if (utilJson) {
            try {
              const parsed = JSON.parse(utilJson)
              const fiveHour = parsed?.five_hour?.utilization
              if (typeof fiveHour === 'number') {
                util5hMap.set(aid, Math.round(fiveHour * 10) / 10)
              }
            } catch {}
          }
        }
      } catch {
        // Redis failure — leave maps empty (will show 0/null)
      }
    }

    // 24h request counts per account (one bulk query)
    const req24hResult = await query<{ oauth_account_id: string; n: number }>(
      `SELECT oauth_account_id, COUNT(*)::int AS n
         FROM request_logs
        WHERE created_at > now() - INTERVAL '24 hours'
          AND oauth_account_id IS NOT NULL
        GROUP BY 1`,
      [],
    )
    const req24hMap = new Map<string, number>()
    for (const row of req24hResult.rows) {
      req24hMap.set(row.oauth_account_id, row.n)
    }

    const counts = { normal: 0, cooldown: 0, invalid: 0, banned: 0, refunded: 0, error_misc: 0, unknown: 0 }

    for (const row of accountsResult.rows) {
      const inCooldown = cooldownMap.get(row.id) ?? false
      const cat = classify({
        status: row.status,
        last_error: row.last_error,
        in_cooldown: inCooldown,
      })
      counts[cat] = (counts[cat] ?? 0) + 1

      // Only push active accounts to the visible list (banned/error optional)
      if (row.status === 'active') {
        accountList.push({
          email_masked: maskEmail(row.email ?? ''),
          subscription: subscriptionLabel(row.account_type),
          status_category: cat,
          util_5h_pct: util5hMap.get(row.id) ?? null,
          rpm: rpmMap.get(row.id) ?? 0,
          req_24h: req24hMap.get(row.id) ?? 0,
        })
      }
    }

    res.json({
      summary: {
        normal: counts.normal,
        cooldown: counts.cooldown,
        invalid: counts.invalid,
        // 公开看板不区分退款 — 把 refunded 合并到 banned 数里,客户看不出区别
        banned: counts.banned + counts.refunded,
        // 全局 RPM = 所有 active 账号 RPM 之和 (实时窗口已在 fetchRedisStats 计算)
        total_rpm: accountList.reduce((sum, a) => sum + (a.rpm || 0), 0),
        total: accountsResult.rows.length,
      },
      accounts: accountList,
      updated_at: new Date().toISOString(),
    })
  } catch (err: any) {
    console.error('public pool-status error:', err)
    res.status(500).json({ error: 'Failed to load pool status' })
  }
})

export default router
