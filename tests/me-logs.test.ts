// Requires DATABASE_URL; not run in local dev
import { strict as assert } from 'assert'
import { query } from '../server/src/db.js'
import { loadMyLogs, loadMyLogDetail } from '../server/src/routes/logs-me.js'

async function main() {
  // 造两个用户 + 各一个 client + 各一条 log
  const u1 = (await query(`INSERT INTO users(email,role,status) VALUES('a@a','user','active') RETURNING id`)).rows[0].id
  const u2 = (await query(`INSERT INTO users(email,role,status) VALUES('b@b','user','active') RETURNING id`)).rows[0].id
  const c1 = (await query(`INSERT INTO clients(name,api_key_hash,user_id,group_id) SELECT 'c1','h1',$1,id FROM account_groups WHERE is_default=true LIMIT 1 RETURNING id`, [u1])).rows[0].id
  const c2 = (await query(`INSERT INTO clients(name,api_key_hash,user_id,group_id) SELECT 'c2','h2',$1,id FROM account_groups WHERE is_default=true LIMIT 1 RETURNING id`, [u2])).rows[0].id

  const t1 = 'ccg-test-' + Date.now()
  const t2 = 'ccg-test-' + (Date.now() + 1)
  await query(`INSERT INTO request_logs(trace_id,client_id,client_name,method,path,client_ip) VALUES($1,$2,'c1','POST','/v1/messages','1.1.1.1'),($3,$4,'c2','POST','/v1/messages','2.2.2.2')`, [t1, c1, t2, c2])

  const own = await loadMyLogs({ userId: u1, limit: 50 })
  assert.ok(own.items.find((x: any) => x.trace_id === t1))
  assert.ok(!own.items.find((x: any) => x.trace_id === t2), 'u1 should NOT see u2 log')

  const d = await loadMyLogDetail({ userId: u1, traceId: t1 })
  assert.ok(d, 'own detail visible')

  const crossDetail = await loadMyLogDetail({ userId: u1, traceId: t2 })
  assert.equal(crossDetail, null, 'cross-user detail must be null')

  // 清理
  await query(`DELETE FROM request_logs WHERE trace_id IN ($1,$2)`, [t1, t2])
  await query(`DELETE FROM clients WHERE id IN ($1,$2)`, [c1, c2])
  await query(`DELETE FROM users WHERE id IN ($1,$2)`, [u1, u2])

  console.log('OK')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
