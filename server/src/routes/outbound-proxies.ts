import { Router } from 'express'
import { query } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { adminMiddleware } from '../middleware/admin.js'
import {
  buildDisplayProxyUrl,
  parseProxyImport,
  reloadOutboundProxies,
  requestExternal,
} from '../services/outbound-proxy.js'

const router = Router()
router.use(authMiddleware, adminMiddleware)

router.get('/', async (_req, res) => {
  try {
    const proxyResult = await query(
      `SELECT p.id, p.name, p.fingerprint, p.scheme, p.host, p.port, p.username, p.password, p.status, p.weight,
              p.last_used_at, p.last_error, p.success_count, p.fail_count, p.failure_streak, p.cooldown_until,
              p.created_at, p.updated_at,
              COALESCE(b.bound_count, 0)::int AS bound_count,
              COALESCE(b.bound_active, 0)::int AS bound_active
         FROM outbound_proxies p
         LEFT JOIN (
           SELECT outbound_proxy_id AS pid,
                  COUNT(*) AS bound_count,
                  COUNT(*) FILTER (WHERE status = 'active') AS bound_active
             FROM oauth_accounts
            WHERE outbound_proxy_id IS NOT NULL
            GROUP BY outbound_proxy_id
         ) b ON b.pid = p.id
        ORDER BY p.status = 'active' DESC, p.weight DESC, p.created_at ASC`,
    )

    res.json({
      proxies: proxyResult.rows.map((row: any) => {
        const { password, ...rest } = row
        return {
          ...rest,
          display_url: buildDisplayProxyUrl({
            scheme: row.scheme,
            host: row.host,
            port: Number(row.port),
            username: row.username ?? null,
            password: row.password ?? null,
          }),
          has_password: !!row.password,
        }
      }),
    })
  } catch (err) {
    console.error('List outbound proxies error:', err)
    res.status(500).json({ error: 'Failed to list outbound proxies' })
  }
})

router.post('/import', async (req, res) => {
  try {
    const text = String(req.body?.text ?? '')
    if (!text.trim()) {
      res.status(400).json({ error: 'text is required' })
      return
    }

    const { entries, errors } = parseProxyImport(text)
    let imported = 0

    for (const entry of entries) {
      await query(
        `INSERT INTO outbound_proxies
           (name, fingerprint, scheme, host, port, username, password, status, weight, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active',10,now())
         ON CONFLICT (fingerprint) DO UPDATE
           SET name = EXCLUDED.name,
               scheme = EXCLUDED.scheme,
               host = EXCLUDED.host,
               port = EXCLUDED.port,
               username = EXCLUDED.username,
               password = EXCLUDED.password,
               status = 'active',
               updated_at = now()
         RETURNING id`,
        [
          entry.name,
          entry.fingerprint,
          entry.scheme,
          entry.host,
          entry.port,
          entry.username,
          entry.password,
        ],
      )
      imported += 1
    }

    await reloadOutboundProxies()
    res.json({
      imported,
      failed: errors.length,
      errors,
    })
  } catch (err) {
    console.error('Import outbound proxies error:', err)
    res.status(500).json({ error: 'Failed to import outbound proxies' })
  }
})

router.patch('/:id', async (req, res) => {
  try {
    const fields: string[] = []
    const params: any[] = []
    let idx = 1

    if (req.body?.name !== undefined) {
      fields.push(`name = $${idx++}`)
      params.push(String(req.body.name))
    }
    if (req.body?.status !== undefined) {
      const status = String(req.body.status)
      if (!['active', 'disabled'].includes(status)) {
        res.status(400).json({ error: 'status must be active or disabled' })
        return
      }
      fields.push(`status = $${idx++}`)
      params.push(status)
    }
    if (req.body?.weight !== undefined) {
      const weight = Number(req.body.weight)
      if (!Number.isFinite(weight) || weight <= 0) {
        res.status(400).json({ error: 'weight must be a positive number' })
        return
      }
      fields.push(`weight = $${idx++}`)
      params.push(weight)
    }

    if (fields.length === 0) {
      res.status(400).json({ error: 'Nothing to update' })
      return
    }

    fields.push(`updated_at = now()`)
    params.push(req.params.id)
    const result = await query(
      `UPDATE outbound_proxies SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, name, status, weight`,
      params,
    )
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Proxy not found' })
      return
    }

    await reloadOutboundProxies()
    res.json(result.rows[0])
  } catch (err) {
    console.error('Update outbound proxy error:', err)
    res.status(500).json({ error: 'Failed to update outbound proxy' })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM outbound_proxies WHERE id = $1 RETURNING id', [req.params.id])
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Proxy not found' })
      return
    }
    await reloadOutboundProxies()
    res.json({ ok: true, id: result.rows[0].id })
  } catch (err) {
    console.error('Delete outbound proxy error:', err)
    res.status(500).json({ error: 'Failed to delete outbound proxy' })
  }
})

// POST /admin/outbound-proxies/:id/test  — 测试代理: 走 https://ipinfo.io/json 看 IP + 国家
router.post('/:id/test', async (req, res) => {
  const start = Date.now()
  try {
    const r = await query('SELECT id FROM outbound_proxies WHERE id = $1', [req.params.id])
    if (r.rows.length === 0) {
      res.status(404).json({ error: 'Proxy not found' })
      return
    }
    const resp = await requestExternal('https://ipinfo.io/json', {
      method: 'GET',
      headers: {
        'user-agent': 'cc-gateway-proxy-test/1.0',
        'accept': 'application/json',
      },
      timeoutMs: 8000,
      proxyId: req.params.id,
    })
    const elapsed = Date.now() - start
    if (resp.statusCode !== 200) {
      res.json({
        ok: false,
        status_code: resp.statusCode,
        elapsed_ms: elapsed,
        detail: `ipinfo.io 返回 HTTP ${resp.statusCode}`,
      })
      return
    }
    // 解析 JSON 提取 ip + country
    let ip = ''
    let country = ''
    try {
      const text = resp.body?.toString('utf8') || ''
      const data = JSON.parse(text)
      ip = data.ip || ''
      country = data.country || ''
    } catch {
      // 解析失败但 200 仍算通
    }
    res.json({
      ok: true,
      status_code: 200,
      elapsed_ms: elapsed,
      ip,
      country,
      detail: ip
        ? `✓ ${ip} · ${country} · ${elapsed}ms`
        : `✓ 通 (${elapsed}ms, 但 ipinfo 响应解析失败)`,
    })
  } catch (err: any) {
    const elapsed = Date.now() - start
    const msg = err?.message ?? String(err)
    let short = msg
    if (/ETIMEDOUT|timed?out|timeout/i.test(msg)) short = '连接超时'
    else if (/ECONNREFUSED/i.test(msg)) short = '连接被拒绝'
    else if (/EHOSTUNREACH|ENETUNREACH/i.test(msg)) short = '目标不可达'
    else if (/proxy_auth|407/i.test(msg)) short = '代理认证失败 (407)'
    else if (/ENOTFOUND/i.test(msg)) short = 'DNS 解析失败'
    res.status(200).json({
      ok: false,
      status_code: 0,
      elapsed_ms: elapsed,
      detail: `代理失败: ${short}`,
    })
  }
})

export { router as outboundProxiesRouter }
export default router
