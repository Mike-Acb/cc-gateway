import { createHash } from 'crypto'
import type { Agent as NodeHttpAgent } from 'http'
import { ProxyAgent } from 'proxy-agent'
import { query } from './db.js'
import { log } from './logger.js'

type ProxySource = 'bound' | 'direct'

export type OutboundProxy = {
  id: string
  name: string
  fingerprint: string
  scheme: string
  host: string
  port: number
  username: string | null
  password: string | null
  status: string
  weight: number
  lastUsedAt: string | null
  lastError: string | null
  successCount: number
  failCount: number
  failureStreak: number
  cooldownUntil: string | null
  createdAt: string
  updatedAt: string
}

export type OutboundProxySelection = {
  agent: NodeHttpAgent | null
  proxy: OutboundProxy | null
  source: ProxySource
  required: boolean
  error: string | null
}

const agentCache = new Map<string, ProxyAgent>()
let proxies: OutboundProxy[] = []
let syncTimer: ReturnType<typeof setInterval> | null = null

function makeProxyUrl(proxy: Pick<OutboundProxy, 'scheme' | 'host' | 'port' | 'username' | 'password'>): string {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}${proxy.password ? `:${encodeURIComponent(proxy.password)}` : ''}@`
    : ''
  return `${proxy.scheme}://${auth}${proxy.host}:${proxy.port}`
}

function getOrCreateAgent(proxyUrl: string): NodeHttpAgent {
  let agent = agentCache.get(proxyUrl)
  if (!agent) {
    agent = new ProxyAgent({
      getProxyForUrl: () => proxyUrl,
    })
    agentCache.set(proxyUrl, agent)
  }
  return agent as unknown as NodeHttpAgent
}

function isCoolingDown(proxy: OutboundProxy): boolean {
  return !!proxy.cooldownUntil && new Date(proxy.cooldownUntil).getTime() > Date.now()
}

function getProxyById(proxyId: string): OutboundProxy | null {
  return proxies.find((proxy) => proxy.id === proxyId) ?? null
}

async function syncProxies(): Promise<void> {
  try {
    const result = await query(
      `SELECT id, name, fingerprint, scheme, host, port, username, password, status, weight,
              last_used_at, last_error, success_count, fail_count, failure_streak, cooldown_until,
              created_at, updated_at
         FROM outbound_proxies
        ORDER BY status = 'active' DESC, weight DESC, created_at ASC`,
    )
    proxies = result.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      fingerprint: row.fingerprint,
      scheme: row.scheme,
      host: row.host,
      port: Number(row.port),
      username: row.username ?? null,
      password: row.password ?? null,
      status: row.status,
      weight: Number(row.weight ?? 1),
      lastUsedAt: row.last_used_at ?? null,
      lastError: row.last_error ?? null,
      successCount: Number(row.success_count ?? 0),
      failCount: Number(row.fail_count ?? 0),
      failureStreak: Number(row.failure_streak ?? 0),
      cooldownUntil: row.cooldown_until ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  } catch (err) {
    proxies = []
    log('debug', `outbound-proxy: sync failed: ${err}`)
  }
}

export async function startOutboundProxyPool(intervalMs = 5_000): Promise<void> {
  await syncProxies()

  syncTimer = setInterval(() => {
    syncProxies().catch(() => {})
  }, intervalMs)
}

export function stopOutboundProxyPool(): void {
  if (syncTimer) clearInterval(syncTimer)
  syncTimer = null
  for (const agent of agentCache.values()) agent.destroy()
  agentCache.clear()
}

export function getProxyAgentForProxyId(proxyId: string | null | undefined): OutboundProxySelection {
  if (!proxyId) {
    return {
      agent: null,
      proxy: null,
      source: 'direct',
      required: false,
      error: null,
    }
  }

  const proxy = getProxyById(proxyId)
  if (!proxy) {
    return {
      agent: null,
      proxy: null,
      source: 'bound',
      required: true,
      error: 'Bound outbound proxy does not exist',
    }
  }

  if (proxy.status !== 'active') {
    return {
      agent: null,
      proxy,
      source: 'bound',
      required: true,
      error: `Bound outbound proxy "${proxy.name}" is not active`,
    }
  }

  if (isCoolingDown(proxy)) {
    return {
      agent: null,
      proxy,
      source: 'bound',
      required: true,
      error: `Bound outbound proxy "${proxy.name}" is cooling down`,
    }
  }

  return {
    agent: getOrCreateAgent(makeProxyUrl(proxy)),
    proxy,
    source: 'bound',
    required: true,
    error: null,
  }
}

export function getDirectAgent(): OutboundProxySelection {
  return {
    agent: null,
    proxy: null,
    source: 'direct',
    required: false,
    error: null,
  }
}

function sanitizeError(reason: string): string {
  return reason.trim().slice(0, 500)
}

function cooldownSecondsFor(streak: number): number {
  return Math.min(300, Math.max(15, 15 * 2 ** Math.max(0, Math.min(streak - 1, 4))))
}

export async function markProxySuccess(selection: OutboundProxySelection): Promise<void> {
  if (!selection.proxy) return

  selection.proxy.lastUsedAt = new Date().toISOString()
  selection.proxy.lastError = null
  selection.proxy.failureStreak = 0
  selection.proxy.cooldownUntil = null
  selection.proxy.successCount += 1

  try {
    await query(
      `UPDATE outbound_proxies
          SET last_used_at = now(),
              last_error = NULL,
              success_count = success_count + 1,
              failure_streak = 0,
              cooldown_until = NULL,
              updated_at = now()
        WHERE id = $1`,
      [selection.proxy.id],
    )
  } catch {
    // ignore
  }
}

export async function markProxyFailure(selection: OutboundProxySelection, reason: string): Promise<void> {
  if (!selection.proxy) return

  const message = sanitizeError(reason)
  const streak = selection.proxy.failureStreak + 1
  const cooldownSeconds = cooldownSecondsFor(streak)
  const cooldownUntil = new Date(Date.now() + cooldownSeconds * 1000).toISOString()

  selection.proxy.lastError = message
  selection.proxy.failureStreak = streak
  selection.proxy.failCount += 1
  selection.proxy.cooldownUntil = cooldownUntil

  try {
    await query(
      `UPDATE outbound_proxies
          SET last_error = $1,
              fail_count = fail_count + 1,
              failure_streak = $2,
              cooldown_until = now() + ($3::text || ' seconds')::interval,
              updated_at = now()
        WHERE id = $4`,
      [message, streak, String(cooldownSeconds), selection.proxy.id],
    )
  } catch {
    // ignore
  }
}

export function buildProxyFingerprint(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}
