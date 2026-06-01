// Requires DATABASE_URL; not run in local dev
import { strict as assert } from 'assert'
import { loadUsage } from '../server/src/routes/usage-me.js'

async function main() {
  const r = await loadUsage({
    userId: '00000000-0000-0000-0000-000000000000',
    granularity: 'day',
    since: new Date(Date.now() - 7 * 86400_000),
    until: new Date(),
  })
  assert.ok(Array.isArray(r.buckets))
  console.log('OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
