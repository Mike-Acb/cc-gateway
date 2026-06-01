import { readFileSync } from 'fs'
import { parse } from 'yaml'
import { resolve } from 'path'

export type TokenEntry = {
  name: string
  token: string
}

export type UpstreamAuthMode = 'oauth_refresh' | 'static_bearer'
export type AccountPoolMode = 'fallback' | 'poll'

export type Config = {
  server: {
    port: number
    tls: {
      cert: string
      key: string
    }
  }
  upstream: {
    url: string
  }
  upstream_auth?: {
    mode?: UpstreamAuthMode
    bearer_token?: string
  }
  auth: {
    tokens: TokenEntry[]
  }
  oauth?: {
    access_token?: string
    refresh_token: string
    expires_at?: number
  }
  database?: {
    host: string
    port: number
    database: string
    user: string
    password: string
    max_connections?: number
  }
  redis?: {
    host: string
    port: number
    password?: string
  }
  pool?: {
    fixed_account_id?: string
  }
  process: {
    constrained_memory: number
    rss_range: [number, number]
    heap_total_range: [number, number]
    heap_used_range: [number, number]
  }
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error'
    audit: boolean
  }
  env?: {
    version?: string
    [key: string]: any
  }
}

let _config: Config | null = null

export function setConfig(config: Config): void {
  _config = config
}

export function getConfig(): Config | null {
  return _config
}

export function getUpstreamAuthMode(config: Config): UpstreamAuthMode {
  return config.upstream_auth?.mode ?? 'oauth_refresh'
}

export function getAccountPoolMode(): AccountPoolMode {
  return process.env.ACCOUNT_POOL_MODE === 'poll' ? 'poll' : 'fallback'
}

export function isAccountPoolPollMode(config?: Config): boolean {
  return getAccountPoolMode() === 'poll' && (!config || !!config.database)
}

export function loadConfig(configPath?: string): Config {
  const filePath = configPath || resolve(process.cwd(), 'config.yaml')
  const raw = readFileSync(filePath, 'utf-8')
  const config = parse(raw) as Config

  if (!config.auth?.tokens?.length) {
    throw new Error('config: auth.tokens must have at least one entry')
  }

  if (getUpstreamAuthMode(config) === 'static_bearer') {
    if (!config.upstream_auth?.bearer_token?.trim()) {
      throw new Error('config: upstream_auth.bearer_token is required when upstream_auth.mode=static_bearer')
    }
  } else if (!config.oauth?.refresh_token && !isAccountPoolPollMode(config)) {
    throw new Error('config: oauth.refresh_token is required when upstream_auth.mode=oauth_refresh. Do a browser OAuth login on the admin machine, then copy the refresh token from ~/.claude/.credentials.json')
  }

  if (config.database && (!config.database.host || !config.database.database)) {
    throw new Error('database.host and database.database are required in config')
  }

  return config
}
