import pg from 'pg'
const { Pool } = pg

const pool = new Pool({
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME ?? 'cc_gateway',
  user: process.env.DB_USER ?? 'cc_gateway',
  password: process.env.DB_PASSWORD ?? 'change-me-password',
  max: Number(process.env.DB_MAX_CONNECTIONS ?? 10),
})

pool.on('error', (err: Error) => {
  console.error('Unexpected PG pool error:', err.message)
})

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params)
}

export { pool }
export default pool

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

console.log(`[db] deployment tag: ${DEPLOYMENT}`)
