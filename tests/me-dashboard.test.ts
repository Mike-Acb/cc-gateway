// Requires DATABASE_URL; not run in local dev
import { strict as assert } from 'assert'
import { loadDashboardForUser } from '../server/src/routes/dashboard.js'

async function main() {
  const data = await loadDashboardForUser('00000000-0000-0000-0000-000000000000') // 不存在
  assert.deepEqual(data.kpis, {
    requestCount: 0, successRate: 1, blockedCount: 0, tokenCount: 0,
  })
  assert.ok(Array.isArray(data.trend))
  assert.ok(Array.isArray(data.topClients))
  assert.ok(Array.isArray(data.topModels))
  assert.ok(Array.isArray(data.recentBlocks))
  assert.ok(typeof data.wallet === 'object' && data.wallet !== null)
  assert.ok(data.wallet.pool === null || typeof data.wallet.pool === 'object')
  assert.ok(data.wallet.quota === null || typeof data.wallet.quota === 'object')
  assert.equal(data.wallet.consumption_order, 'pool_first')
  console.log('OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
