// Requires DATABASE_URL; not run in local dev
import { strict as assert } from 'assert'
import { query } from '../server/src/db.js'
import { recordAudit, sanitize } from '../server/src/services/audit.js'

async function main() {
  // sanitize 脱敏（含嵌套 + 数组）
  const cleaned = sanitize({
    id: '1',
    access_token: 'secret',
    refresh_token: 'r',
    api_key: 'k',
    password_hash: 'p',
    token: 't',
    inner: { api_key: 'nested', ok: true, arr: [{ secret: 'x', keep: 1 }] },
  })
  assert.equal(cleaned.access_token, '***')
  assert.equal(cleaned.refresh_token, '***')
  assert.equal(cleaned.api_key, '***')
  assert.equal(cleaned.password_hash, '***')
  assert.equal(cleaned.token, '***')
  assert.equal((cleaned.inner as any).api_key, '***')
  assert.equal((cleaned.inner as any).ok, true)
  assert.equal((cleaned.inner as any).arr[0].secret, '***')
  assert.equal((cleaned.inner as any).arr[0].keep, 1)

  // null/undefined passthrough
  assert.equal(sanitize(null), null)
  assert.equal(sanitize(undefined), undefined)

  // recordAudit inserts a row, sanitizes before/after, and returns normally
  const resourceId = 'audit-test-' + Date.now()
  await recordAudit(
    { actor_id: null, actor_email: 'x@x', ip: '1.2.3.4', user_agent: 'ua-test' },
    {
      action: 'plan.update',
      resource_type: 'plan',
      resource_id: resourceId,
      before: { name: 'old', access_token: 'should-redact' },
      after: { name: 'new', api_key: 'should-redact' },
      summary: 'rename test',
    },
  )
  const { rows } = await query(
    `SELECT actor_email, action, resource_type, resource_id,
            before, after, summary, ip, user_agent
       FROM audit_logs
      WHERE resource_id = $1 AND action = 'plan.update'
      ORDER BY id DESC LIMIT 1`,
    [resourceId],
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].actor_email, 'x@x')
  assert.equal(rows[0].ip, '1.2.3.4')
  assert.equal(rows[0].user_agent, 'ua-test')
  assert.equal(rows[0].before.name, 'old')
  assert.equal(rows[0].before.access_token, '***')
  assert.equal(rows[0].after.name, 'new')
  assert.equal(rows[0].after.api_key, '***')
  assert.equal(rows[0].summary, 'rename test')

  // Insert with before/after missing should record as NULL (not throw)
  await recordAudit(
    { actor_id: null, actor_email: 'sys', ip: null, user_agent: null },
    { action: 'system.reload', resource_type: 'system' },
  )

  console.log('OK')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
