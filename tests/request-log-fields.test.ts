// Requires DATABASE_URL with cc_gateway schema; not run in local dev
// Verifies that the 4 new columns (first_token_ms, streaming, block_reason,
// block_source) round-trip correctly through insertRequestLog/updateRequestLog.
import { strict as assert } from 'assert'
import { query } from '../src/db.js'
import { generateTraceId, insertRequestLog, updateRequestLog } from '../src/request-logger.js'

async function main() {
  const traceId = generateTraceId()

  await insertRequestLog({
    traceId,
    clientId: null,
    clientName: 'test-client',
    oauthAccountId: null,
    oauthAccountName: null,
    method: 'POST',
    path: '/v1/messages',
    clientIp: '127.0.0.1',
    requestModel: 'claude-opus-4-7',
    requestBody: null,
    streaming: true,
  } as any)

  await updateRequestLog({
    traceId,
    responseStatus: 200,
    responseBody: null,
    latencyMs: 2000,
    errorMessage: null,
    retryCount: 0,
    firstTokenMs: 350,
  } as any)

  const { rows } = await query(
    `SELECT first_token_ms, streaming, block_reason, block_source
       FROM request_logs WHERE trace_id = $1`,
    [traceId],
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].first_token_ms, 350)
  assert.equal(rows[0].streaming, true)
  assert.equal(rows[0].block_reason, null)
  assert.equal(rows[0].block_source, null)

  // Blocked row
  const blockedTrace = generateTraceId()
  await insertRequestLog({
    traceId: blockedTrace,
    clientId: null,
    clientName: 'test-client',
    oauthAccountId: null,
    oauthAccountName: null,
    method: 'POST',
    path: '/v1/messages',
    clientIp: '127.0.0.1',
    requestModel: 'claude-opus-4-7',
    requestBody: null,
    streaming: false,
    blockReason: 'plan_forbidden_model',
    blockSource: 'gw',
  } as any)

  const blocked = await query(
    `SELECT block_reason, block_source FROM request_logs WHERE trace_id = $1`,
    [blockedTrace],
  )
  assert.equal(blocked.rows[0].block_reason, 'plan_forbidden_model')
  assert.equal(blocked.rows[0].block_source, 'gw')

  console.log('OK')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
