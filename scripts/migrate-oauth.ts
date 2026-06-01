#!/usr/bin/env tsx
/**
 * Migrate existing config.yaml OAuth token into the oauth_accounts table.
 * Run once after deploying the multi-account pool migration.
 *
 * Usage: npx tsx scripts/migrate-oauth.ts [config-path]
 */
import { loadConfig } from '../src/config.js'
import { initDB, query, shutdownDB } from '../src/db.js'
import { resolve } from 'path'

async function main() {
  const configPath = process.argv[2] || resolve(process.cwd(), 'config.yaml')
  const config = loadConfig(configPath)

  if (!config.database) {
    console.error('No database configured in config.yaml')
    process.exit(1)
  }

  initDB(config.database)

  // Check if an account already exists
  const existing = await query('SELECT COUNT(*)::int AS n FROM oauth_accounts')
  if (existing.rows[0].n > 0) {
    console.log(`oauth_accounts already has ${existing.rows[0].n} rows, skipping migration`)
    await shutdownDB()
    return
  }

  // Insert the config.yaml OAuth as the first account
  if (!config.oauth?.refresh_token) {
    console.error('config.yaml does not contain oauth.refresh_token')
    process.exit(1)
  }

  const result = await query(
    `INSERT INTO oauth_accounts (name, refresh_token, access_token, expires_at, status, account_type, weight)
     VALUES ($1, $2, $3, $4, 'active', 'pro', 10)
     RETURNING id, name`,
    [
      'default',
      config.oauth.refresh_token,
      config.oauth.access_token ?? null,
      config.oauth.expires_at ?? 0,
    ],
  )
  console.log(`Migrated OAuth to account: ${result.rows[0].id} (${result.rows[0].name})`)
  await shutdownDB()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
