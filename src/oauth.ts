import { request as httpsRequest } from 'https'
import { readFileSync, writeFileSync } from 'fs'
import { log } from './logger.js'
import { getDirectAgent, markProxyFailure, markProxySuccess } from './proxy-agent.js'

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const DEFAULT_SCOPES = [
  'user:inference',
  'user:profile',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
]

type OAuthTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

let cachedTokens: OAuthTokens | null = null
let configFilePath: string | null = null

/**
 * Initialize OAuth.
 * If a valid access_token is provided, use it immediately — no network call.
 * Only refresh when the token is expired or about to expire.
 */
export async function initOAuth(oauth: {
  access_token?: string
  refresh_token: string
  expires_at?: number
}, configPath?: string): Promise<void> {
  if (configPath) configFilePath = configPath
  const now = Date.now()
  const expiresAt = oauth.expires_at ?? 0
  const fiveMinutes = 5 * 60 * 1000

  // Use existing access token if still valid (with 5-min buffer)
  if (oauth.access_token && expiresAt > now + fiveMinutes) {
    cachedTokens = {
      accessToken: oauth.access_token,
      refreshToken: oauth.refresh_token,
      expiresAt,
    }
    const remaining = Math.round((expiresAt - now) / 60_000)
    log('info', `Using existing access token (expires in ${remaining} min)`)
    scheduleRefresh(oauth.refresh_token)
    return
  }

  // Token missing or expired — must refresh
  if (oauth.access_token) {
    log('info', 'Access token expired, refreshing...')
  } else {
    log('info', 'No access token provided, refreshing...')
  }

  log('debug', `[initOAuth] Using refresh_token: ${oauth.refresh_token}`)
  cachedTokens = await refreshOAuthToken(oauth.refresh_token)
  log('info', `OAuth token acquired, expires at ${new Date(cachedTokens.expiresAt).toISOString()}`)
  log('debug', `[initOAuth] Got access_token: ${cachedTokens.accessToken}`)
  log('debug', `[initOAuth] Got refresh_token: ${cachedTokens.refreshToken}`)
  persistRefreshToken(cachedTokens.refreshToken)
  scheduleRefresh(cachedTokens.refreshToken)
}

function scheduleRefresh(refreshToken: string) {
  if (!cachedTokens) return

  const msUntilExpiry = cachedTokens.expiresAt - Date.now()
  // Node clamps setTimeout > 2^31-1 ms (~24.8 days) to 1ms, firing immediately.
  // Cap at 24 days so a far-future expires_at doesn't trigger an instant refresh.
  const TWENTY_FOUR_DAYS = 24 * 24 * 60 * 60 * 1000
  const refreshIn = Math.min(
    Math.max(msUntilExpiry - 5 * 60 * 1000, 10_000),
    TWENTY_FOUR_DAYS,
  )

  log('debug', `[scheduleRefresh] Next refresh in ${Math.round(refreshIn / 1000)}s`)
  setTimeout(async () => {
    const rtToUse = cachedTokens?.refreshToken || refreshToken
    try {
      log('info', 'Auto-refreshing OAuth token...')
      log('debug', `[scheduleRefresh] Using refresh_token: ${rtToUse}`)
      cachedTokens = await refreshOAuthToken(rtToUse)
      log('info', `OAuth token refreshed, expires at ${new Date(cachedTokens.expiresAt).toISOString()}`)
      log('debug', `[scheduleRefresh] New access_token: ${cachedTokens.accessToken}`)
      log('debug', `[scheduleRefresh] New refresh_token: ${cachedTokens.refreshToken}`)
      persistRefreshToken(cachedTokens.refreshToken)
      scheduleRefresh(cachedTokens.refreshToken)
    } catch (err) {
      log('error', `OAuth refresh failed: ${err}. Retrying in 30s...`)
      log('error', `[scheduleRefresh] Failed with refresh_token: ${rtToUse}`)
      setTimeout(() => scheduleRefresh(rtToUse), 30_000)
    }
  }, refreshIn)
}

export function getAccessToken(): string | null {
  if (!cachedTokens) return null
  if (Date.now() >= cachedTokens.expiresAt) {
    log('warn', 'OAuth token expired, waiting for refresh...')
    return null
  }
  return cachedTokens.accessToken
}

function persistRefreshToken(newRefreshToken: string) {
  if (!configFilePath) return
  try {
    const raw = readFileSync(configFilePath, 'utf-8')
    // Replace the refresh_token line in config.yaml
    const updated = raw.replace(
      /^(\s*refresh_token:\s*).+$/m,
      `$1${newRefreshToken}`,
    )
    if (updated !== raw) {
      writeFileSync(configFilePath, updated, 'utf-8')
      log('info', `Persisted new refresh_token to config.yaml`)
    }
  } catch (err) {
    log('error', `Failed to persist refresh_token to config: ${err}`)
  }
}

function refreshOAuthToken(refreshToken: string): Promise<OAuthTokens> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: DEFAULT_SCOPES.join(' '),
    })

    const url = new URL(TOKEN_URL)
    const selection = getDirectAgent()
    if (selection.required && !selection.agent) {
      reject(new Error(selection.error ?? 'Outbound proxy is enabled but unavailable'))
      return
    }
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
        },
        ...(selection.agent && { agent: selection.agent as any }),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          if (res.statusCode === 407) {
            markProxyFailure(selection, 'proxy_auth_failed: HTTP 407').catch(() => {})
          } else {
            markProxySuccess(selection).catch(() => {})
          }
          const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
          if (res.statusCode !== 200) {
            reject(new Error(`OAuth refresh failed (${res.statusCode}): ${JSON.stringify(data)}`))
            return
          }
          resolve({
            accessToken: data.access_token,
            refreshToken: data.refresh_token || refreshToken,
            expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
          })
        })
      },
    )
    req.on('error', (err) => {
      markProxyFailure(selection, `oauth_refresh: ${err.message}`).catch(() => {})
      reject(err)
    })
    req.write(body)
    req.end()
  })
}
