const { Pool } = require("pg")
const Redis = require("ioredis")
const pool = new Pool({ host: "127.0.0.1", database: "cc_gateway", user: "cc_gateway", password: "fb657131e4b0bf44efcd649469bf7414", max: 10 })
const redis = new Redis({ host: "127.0.0.1", port: 6379, password: "d2e46f041c76d55282d2badb6ab535dc" })

const SQL = `WITH stats AS (SELECT oauth_account_id, COUNT(*)::int AS req_24h FROM request_logs WHERE created_at > now() - INTERVAL '24 hours' GROUP BY oauth_account_id), cw AS (SELECT oauth_account_id, SUM(cost)::float8 AS cost_5h FROM usage_records WHERE created_at > now() - INTERVAL '48 hours' AND oauth_account_id IS NOT NULL GROUP BY oauth_account_id) SELECT oa.*, s.req_24h, cw.cost_5h, ct.tools AS cc_template_tools FROM oauth_accounts oa LEFT JOIN stats s ON s.oauth_account_id = oa.id LEFT JOIN cw ON cw.oauth_account_id = oa.id LEFT JOIN cc_disguise_templates ct ON ct.id = oa.cc_template_id WHERE oa.deployment = $1 ORDER BY oa.weight DESC`

async function bench(label) {
  let t = Date.now()
  const r = await pool.query(SQL, ["gw"])
  const tPG = Date.now() - t

  t = Date.now()
  await Promise.all(r.rows.map(async (row) => {
    const now = Date.now()
    await Promise.all([
      redis.zremrangebyscore(`rpm:${row.id}`, 0, now - 60000),
      redis.zremrangebyscore(`tpm:${row.id}`, 0, now - 60000),
    ])
    return Promise.all([
      redis.get(`concurrent:${row.id}`),
      redis.zcard(`rpm:${row.id}`),
      redis.zrange(`tpm:${row.id}`, 0, -1),
      redis.get(`daily_req:${row.id}`),
      redis.get(`daily_tok:${row.id}`),
      redis.get(`daily_cost:${row.id}`),
      redis.scard(`sessions:${row.id}`),
      redis.get(`cooldown:${row.id}`),
      redis.ttl(`cooldown:${row.id}`),
      redis.get(`errors:${row.id}`),
      redis.hgetall(`anthropic_limits:${row.id}`),
      redis.get(`anthropic_limits:${row.id}:updated_at`),
      redis.get(`claude_utilization:${row.id}`),
      redis.get(`claude_utilization:${row.id}:updated_at`),
    ])
  }))
  const tRedis = Date.now() - t

  t = Date.now()
  const json = JSON.stringify({ accounts: r.rows })
  const tJSON = Date.now() - t

  console.log(`[${label}] rows=${r.rows.length} json=${(json.length/1024).toFixed(0)}KB | PG=${tPG}ms Redis=${tRedis}ms JSON=${tJSON}ms total=${tPG+tRedis+tJSON}ms`)
}

;(async () => {
  for (let i=1;i<=3;i++) await bench(`run${i}`)
  pool.end(); redis.quit()
})()
