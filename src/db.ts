import pg from 'pg'
import { log } from './logger.js'

const { Pool } = pg

let pool: pg.Pool | null = null

export function initDB(config: {
  host: string
  port: number
  database: string
  user: string
  password: string
  max_connections?: number
}): void {
  pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: config.max_connections ?? 10,
  })

  pool.on('error', (err) => {
    log('error', `Unexpected PG pool error: ${err.message}`)
  })

  log('info', `PG pool created: ${config.user}@${config.host}:${config.port}/${config.database}`)
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error('Database not initialized. Call initDB() first.')
  return pool
}

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params)
}

export async function shutdownDB(): Promise<void> {
  if (pool) {
    await pool.end()
    log('info', 'PG pool closed')
  }
}

export const DEPLOYMENT = resolveDeployment()

function resolveDeployment(): string {
  const raw = process.env.DEPLOYMENT
  const trimmed = raw === undefined ? '' : raw.trim()
  const isProd = process.env.NODE_ENV === 'production'

  if (trimmed === '') {
    if (isProd) {
      throw new Error(
        "DEPLOYMENT env var is required in production; set DEPLOYMENT='gw' or DEPLOYMENT='gwbk'",
      )
    }
    console.warn("[db] DEPLOYMENT unset; defaulting to 'gw' (non-production)")
    return 'gw'
  }

  if (trimmed !== 'gw' && trimmed !== 'gwbk') {
    throw new Error(`Invalid DEPLOYMENT="${trimmed}"; must be 'gw' or 'gwbk'`)
  }

  return trimmed
}
