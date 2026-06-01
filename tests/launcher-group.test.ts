// Requires DATABASE_URL; not run in local dev
import { strict as assert } from 'assert'
import { query } from '../src/db.js'
import { selectAccount, syncAccounts } from '../src/account-pool.js'
import { syncFromDB } from '../src/sync.js'

async function main() {
  // Prepare: create a non-default group and put an account in it.
  const { rows: grp } = await query(
    `INSERT INTO account_groups (name)
     VALUES ('isolation-test-' || floor(random()*1e9)::text)
     RETURNING id`,
  )
  const groupId: string = grp[0].id

  const { rows: acct } = await query(
    `INSERT INTO oauth_accounts (name, refresh_token, access_token, group_id, status)
     VALUES ('iso-test-' || floor(random()*1e9)::text, 'x', 'x', $1, 'active')
     RETURNING id`,
    [groupId],
  )
  const accountId: string = acct[0].id

  // Fetch the default group id for the "other" client.
  const { rows: def } = await query(
    `SELECT id FROM account_groups WHERE is_default = true LIMIT 1`,
  )
  const defaultId: string = def[0].id

  // Two clients: one bound to the isolation group, one to default.
  const { rows: c1 } = await query(
    `INSERT INTO clients (user_id, name, token, status, group_id)
     VALUES ((SELECT id FROM users LIMIT 1),
             'c-iso-' || floor(random()*1e9)::text,
             'tok-iso-' || floor(random()*1e9)::text,
             'active', $1)
     RETURNING id`,
    [groupId],
  )
  const { rows: c2 } = await query(
    `INSERT INTO clients (user_id, name, token, status, group_id)
     VALUES ((SELECT id FROM users LIMIT 1),
             'c-def-' || floor(random()*1e9)::text,
             'tok-def-' || floor(random()*1e9)::text,
             'active', $1)
     RETURNING id`,
    [defaultId],
  )

  // Sync in-memory caches so selectAccount + getClientGroupId see the new rows.
  await syncAccounts()
  await syncFromDB()

  // c1 (iso group) should reach the iso account.
  const a1 = await selectAccount(null, c1[0].id, 'claude-haiku-4-5-20251001')
  assert.equal(a1?.account?.id, accountId, 'c1 must pick its group account')

  // c2 (default group) must NOT get the iso-group account.
  const a2 = await selectAccount(null, c2[0].id, 'claude-haiku-4-5-20251001')
  assert.notEqual(a2?.account?.id, accountId, 'c2 must NOT pick other-group account')

  // Cleanup
  await query(`DELETE FROM clients WHERE id IN ($1,$2)`, [c1[0].id, c2[0].id])
  await query(`DELETE FROM oauth_accounts WHERE id = $1`, [accountId])
  await query(`DELETE FROM account_groups WHERE id = $1`, [groupId])

  console.log('OK')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
