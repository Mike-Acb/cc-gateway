const { Pool } = require("pg")
const pool = new Pool({ host: "127.0.0.1", database: "cc_gateway", user: "cc_gateway", password: "fb657131e4b0bf44efcd649469bf7414", max: 10 })

// NEW: jsonb_array_length 替换 ct.tools
const NEW_SQL = `WITH stats AS (SELECT oauth_account_id, COUNT(*)::int AS req_24h FROM request_logs WHERE created_at > now() - INTERVAL '24 hours' GROUP BY oauth_account_id), cw AS (SELECT oauth_account_id, SUM(cost)::float8 FROM usage_records WHERE created_at > now() - INTERVAL '48 hours' AND oauth_account_id IS NOT NULL GROUP BY oauth_account_id) SELECT oa.*, s.req_24h, COALESCE(jsonb_array_length(ct.tools), 0) AS cc_template_tools_count FROM oauth_accounts oa LEFT JOIN stats s ON s.oauth_account_id = oa.id LEFT JOIN cw ON cw.oauth_account_id = oa.id LEFT JOIN cc_disguise_templates ct ON ct.id = oa.cc_template_id WHERE oa.deployment = $1 ORDER BY oa.weight DESC`

;(async () => {
  for (let i=1;i<=5;i++){
    const t = Date.now()
    const r = await pool.query(NEW_SQL, ["gw"])
    const json = JSON.stringify(r.rows)
    console.log(`run${i}: PG+JSON=${Date.now()-t}ms, rows=${r.rows.length}, json=${(json.length/1024).toFixed(0)}KB`)
  }
  pool.end()
})()
