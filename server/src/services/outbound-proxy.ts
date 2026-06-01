import { createHash } from 'crypto'
import { request as httpRequest, type Agent as NodeHttpAgent, type IncomingHttpHeaders } from 'http'
import { request as httpsRequest } from 'https'
import { ProxyAgent } from 'proxy-agent'
import { query } from '../db.js'

type ProxySource = 'bound' | 'direct'

export type ManagedProxy = {
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
  last_used_at: string | null
  last_error: string | null
  success_count: number
  fail_count: number
  failure_streak: number
  cooldown_until: string | null
  created_at: string
  updated_at: string
}

export type ParsedProxyInput = {
  name: string
  fingerprint: string
  scheme: string
  host: string
  port: number
  username: string | null
  password: string | null
  normalizedUrl: string
}

type OutboundProxySelection = {
  agent: NodeHttpAgent | null
  proxy: ManagedProxy | null
  source: ProxySource
  required: boolean
  error: string | null
}

type ExternalRequestOptions = {
  method?: string
  headers?: Record<string, string>
  body?: string | Buffer
  timeoutMs?: number
  proxyId?: string | null
}

export type ExternalResponse = {
  statusCode: number
  headers: IncomingHttpHeaders
  body: Buffer
  text: string
}

const SUPPORTED_SCHEMES = new Set(['http', 'https', 'socks', 'socks4', 'socks4a', 'socks5', 'socks5h'])

const agentCache = new Map<string, ProxyAgent>()
let cachedProxies: ManagedProxy[] = []
let lastLoadedAt = 0

function normalizeScheme(raw: string): string {
  const value = raw.trim().toLowerCase()
  if (value === 'socks') return 'socks5'
  if (!SUPPORTED_SCHEMES.has(value)) {
    throw new Error(`Unsupported proxy scheme: ${raw}`)
  }
  return value
}

function defaultPortForScheme(scheme: string): number {
  switch (scheme) {
    case 'https': return 443
    case 'socks':
    case 'socks4':
    case 'socks4a':
    case 'socks5':
    case 'socks5h':
      return 1080
    default:
      return 80
  }
}

function buildProxyUrl(proxy: {
  scheme: string
  host: string
  port: number
  username: string | null
  password: string | null
}): string {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}${proxy.password ? `:${encodeURIComponent(proxy.password)}` : ''}@`
    : ''
  return `${proxy.scheme}://${auth}${proxy.host}:${proxy.port}`
}

function fingerprintFor(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}

function buildDefaultName(proxy: {
  scheme: string
  host: string
  port: number
  username: string | null
}): string {
  return proxy.username
    ? `${proxy.scheme}://${proxy.host}:${proxy.port} (${proxy.username})`
    : `${proxy.scheme}://${proxy.host}:${proxy.port}`
}

function sanitizeError(reason: string): string {
  return reason.trim().slice(0, 500)
}

function cooldownSecondsFor(streak: number): number {
  return Math.min(300, Math.max(15, 15 * 2 ** Math.max(0, Math.min(streak - 1, 4))))
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

function isCoolingDown(proxy: ManagedProxy): boolean {
  return !!proxy.cooldown_until && new Date(proxy.cooldown_until).getTime() > Date.now()
}

function getProxyById(proxyId: string): ManagedProxy | null {
  return cachedProxies.find((proxy) => proxy.id === proxyId) ?? null
}

async function loadState(force = false): Promise<void> {
  if (!force && Date.now() - lastLoadedAt < 5_000) return

  try {
    const proxyResult = await query(
      `SELECT id, name, fingerprint, scheme, host, port, username, password, status, weight,
              last_used_at, last_error, success_count, fail_count, failure_streak, cooldown_until,
              created_at, updated_at
         FROM outbound_proxies
        ORDER BY status = 'active' DESC, weight DESC, created_at ASC`,
    )

    cachedProxies = proxyResult.rows.map((row: any) => ({
      ...row,
      port: Number(row.port),
      weight: Number(row.weight ?? 1),
      success_count: Number(row.success_count ?? 0),
      fail_count: Number(row.fail_count ?? 0),
      failure_streak: Number(row.failure_streak ?? 0),
      username: row.username ?? null,
      password: row.password ?? null,
      last_used_at: row.last_used_at ?? null,
      last_error: row.last_error ?? null,
      cooldown_until: row.cooldown_until ?? null,
    }))
  } catch {
    cachedProxies = []
  }

  lastLoadedAt = Date.now()
}

export async function reloadOutboundProxies(): Promise<void> {
  lastLoadedAt = 0
  await loadState(true)
}

/**
 * Resolve a proxy ID to its raw URL string (e.g. "socks5://user:pass@host:port"),
 * for tools that need the URL directly (e.g. curl-impersonate `--proxy ...`)
 * rather than a Node http.Agent. Returns null when proxyId is null/undefined.
 * Throws when proxyId is given but the proxy is missing, disabled, or cooling.
 */
export async function resolveProxyUrl(proxyId: string | null | undefined): Promise<string | null> {
  if (!proxyId) return null
  const selection = await selectOutboundAgent(proxyId)
  if (selection.required && !selection.agent) {
    throw new Error(selection.error ?? 'Bound outbound proxy is unavailable')
  }
  if (!selection.proxy) return null
  const p = selection.proxy
  const auth = p.username && p.password
    ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@`
    : (p.username ? `${encodeURIComponent(p.username)}@` : '')
  return `${p.scheme}://${auth}${p.host}:${p.port}`
}

async function selectOutboundAgent(proxyId: string | null | undefined): Promise<OutboundProxySelection> {
  await loadState()

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
    agent: getOrCreateAgent(buildProxyUrl(proxy)),
    proxy,
    source: 'bound',
    required: true,
    error: null,
  }
}

async function markProxySuccess(selection: OutboundProxySelection): Promise<void> {
  if (!selection.proxy) return
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

async function markProxyFailure(selection: OutboundProxySelection, reason: string): Promise<void> {
  if (!selection.proxy) return
  const streak = selection.proxy.failure_streak + 1
  const cooldownSeconds = cooldownSecondsFor(streak)
  try {
    await query(
      `UPDATE outbound_proxies
          SET last_error = $1,
              fail_count = fail_count + 1,
              failure_streak = $2,
              cooldown_until = now() + ($3::text || ' seconds')::interval,
              updated_at = now()
        WHERE id = $4`,
      [sanitizeError(reason), streak, String(cooldownSeconds), selection.proxy.id],
    )
  } catch {
    // ignore
  }
}

export async function requestExternal(urlInput: string | URL, options: ExternalRequestOptions = {}): Promise<ExternalResponse> {
  const url = typeof urlInput === 'string' ? new URL(urlInput) : urlInput
  const selection = await selectOutboundAgent(options.proxyId)
  if (selection.required && !selection.agent) {
    throw new Error(selection.error ?? 'Bound outbound proxy is unavailable')
  }

  const requester = url.protocol === 'http:' ? httpRequest : httpsRequest

  return new Promise((resolve, reject) => {
    const req = requester(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        headers: options.headers,
        ...(selection.agent && { agent: selection.agent as any }),
        ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
        res.on('end', () => {
          const body = Buffer.concat(chunks)
          if (res.statusCode === 407) {
            markProxyFailure(selection, 'proxy_auth_failed: HTTP 407').catch(() => {})
          } else {
            markProxySuccess(selection).catch(() => {})
          }
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body,
            text: body.toString('utf-8'),
          })
        })
      },
    )

    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'))
    })

    req.on('error', (err) => {
      markProxyFailure(selection, err.message).catch(() => {})
      reject(err)
    })

    if (options.body) req.write(options.body)
    req.end()
  })
}

export function buildDisplayProxyUrl(proxy: {
  scheme: string
  host: string
  port: number
  username: string | null
  password: string | null
}): string {
  const auth = proxy.username ? `${proxy.username}${proxy.password ? ':***' : ''}@` : ''
  return `${proxy.scheme}://${auth}${proxy.host}:${proxy.port}`
}

export function parseProxyInput(rawLine: string): ParsedProxyInput {
  const value = rawLine.trim()
  if (!value) throw new Error('Empty proxy line')

  let scheme = 'http'
  let host = ''
  let port = 0
  let username: string | null = null
  let password: string | null = null

  if (value.includes('://')) {
    const url = new URL(value)
    scheme = normalizeScheme(url.protocol.replace(/:$/, ''))
    host = url.hostname
    port = url.port ? Number(url.port) : defaultPortForScheme(scheme)
    username = url.username ? decodeURIComponent(url.username) : null
    password = url.password ? decodeURIComponent(url.password) : null
  } else {
    const parts = value.split(':')
    if (parts.length !== 2 && parts.length !== 4) {
      throw new Error('Bare proxy format must be ip:port or ip:port:username:password')
    }
    scheme = 'http'
    host = parts[0]?.trim() ?? ''
    port = Number(parts[1])
    username = parts.length === 4 ? parts[2] : null
    password = parts.length === 4 ? parts[3] : null
  }

  if (!host) throw new Error('Proxy host is required')
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Proxy port must be between 1 and 65535')
  }

  const normalizedUrl = buildProxyUrl({ scheme, host, port, username, password })
  return {
    name: buildDefaultName({ scheme, host, port, username }),
    fingerprint: fingerprintFor(normalizedUrl),
    scheme,
    host,
    port,
    username,
    password,
    normalizedUrl,
  }
}

export function parseProxyImport(text: string): {
  entries: ParsedProxyInput[]
  errors: Array<{ line: number; input: string; error: string }>
} {
  const entries: ParsedProxyInput[] = []
  const errors: Array<{ line: number; input: string; error: string }> = []

  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      entries.push(parseProxyInput(trimmed))
    } catch (err) {
      errors.push({
        line: index + 1,
        input: trimmed,
        error: err instanceof Error ? err.message : 'Invalid proxy',
      })
    }
  })

  return { entries, errors }
}
