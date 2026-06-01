import type { IncomingMessage } from 'http'
import type { Config, TokenEntry } from './config.js'
import { getClientByToken } from './sync.js'

const tokenMap = new Map<string, TokenEntry>()

export function initAuth(config: Config) {
  tokenMap.clear()
  for (const entry of config.auth.tokens) {
    tokenMap.set(entry.token, entry)
  }
}

export type AuthResult = {
  clientName: string
  clientId?: string
  userId?: string
  clientStatus?: string
  userStatus?: string
}

/**
 * Authenticate incoming request by Bearer token.
 * Tries PG-sourced clients first (via sync), falls back to config.yaml tokens.
 * Returns an AuthResult or null if unauthorized.
 */
export function authenticate(req: IncomingMessage): AuthResult | null {
  // Extract token from x-api-key or Authorization/Proxy-Authorization
  const token = extractToken(req)
  if (!token) return null

  // Try PG-sourced client first
  const synced = getClientByToken(token)
  if (synced) {
    return {
      clientName: synced.name,
      clientId: synced.id,
      userId: synced.userId,
      clientStatus: synced.status,
      userStatus: synced.userStatus,
    }
  }

  // Fall back to config.yaml tokens
  const entry = tokenMap.get(token)
  if (entry) {
    return { clientName: entry.name }
  }

  return null
}

function extractToken(req: IncomingMessage): string | null {
  // CC with ANTHROPIC_API_KEY sends x-api-key header
  const apiKey = req.headers['x-api-key']
  if (apiKey && typeof apiKey === 'string') {
    return apiKey
  }

  // Fallback: Bearer token in Authorization or Proxy-Authorization
  const authHeader = req.headers['proxy-authorization'] || req.headers['authorization']
  if (!authHeader || typeof authHeader !== 'string') return null

  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  return match?.[1] ?? null
}
