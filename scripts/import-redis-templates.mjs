#!/usr/bin/env node
// Import legacy Redis cc-template:* entries into cc_disguise_templates.
// Env: PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE REDIS_HOST REDIS_PORT REDIS_PASSWORD DEPLOYMENT

import pg from 'pg'
import Redis from 'ioredis'

const deployment = process.env.DEPLOYMENT || 'main'

const db = new pg.Client({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
})

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  lazyConnect: true,
})

await db.connect()
await redis.connect()

const keys = []
let cursor = '0'
do {
  const [next, batch] = await redis.scan(cursor, 'MATCH', 'cc-template:*', 'COUNT', 100)
  cursor = next
  keys.push(...batch)
} while (cursor !== '0')

console.log(`found ${keys.length} redis templates`)

let imported = 0
let skipped = 0
for (const key of keys) {
  const raw = await redis.get(key)
  if (!raw) continue
  let parsed
  try { parsed = JSON.parse(raw) } catch { console.warn(`bad json: ${key}`); continue }

  const tools = Array.isArray(parsed.tools) ? parsed.tools : []
  const systemBlocks = Array.isArray(parsed.systemBlocks) ? parsed.systemBlocks : []
  const ua = typeof parsed.learnedFromUA === 'string' && parsed.learnedFromUA ? parsed.learnedFromUA : null
  const accountId = key.replace(/^cc-template:/, '')

  const baseName = `import-${accountId.slice(0, 8)}`
  let name = baseName
  for (let i = 1; i <= 10; i++) {
    const { rows } = await db.query(
      `SELECT 1 FROM cc_disguise_templates WHERE deployment = $1 AND name = $2`,
      [deployment, name],
    )
    if (rows.length === 0) break
    name = `${baseName} (${i})`
  }

  const { rows } = await db.query(
    `SELECT 1 FROM cc_disguise_templates
       WHERE deployment = $1 AND source_ua IS NOT DISTINCT FROM $2
         AND jsonb_array_length(tools) = $3 AND jsonb_array_length(system_blocks) = $4`,
    [deployment, ua, tools.length, systemBlocks.length],
  )
  if (rows.length > 0) {
    console.log(`skip ${key} — similar row exists (ua=${ua}, tools=${tools.length}, sys=${systemBlocks.length})`)
    skipped++
    continue
  }

  await db.query(
    `INSERT INTO cc_disguise_templates (deployment, name, description, tools, system_blocks, source, source_ua)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 'learned', $6)`,
    [deployment, name, `imported from redis cc-template:${accountId}`,
      JSON.stringify(tools), JSON.stringify(systemBlocks), ua],
  )
  console.log(`imported ${key} -> ${name} (tools=${tools.length}, sys=${systemBlocks.length}, ua=${ua || '-'})`)
  imported++
}

console.log(`done: imported=${imported}, skipped=${skipped}, total=${keys.length}`)

await redis.quit()
await db.end()
