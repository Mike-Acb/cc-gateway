import { query } from './db.js'
import { log } from './logger.js'
import { findModelPrice } from './sync.js'

export type UsageData = {
  model: string
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
}

export function applyBillableExclusion(usage: UsageData, excludedTokens: number): UsageData {
  const billable: UsageData = { ...usage }
  let remaining = Math.max(0, Math.floor(Number.isFinite(excludedTokens) ? excludedTokens : 0))

  const deduct = (key: 'cacheWrite' | 'cacheRead') => {
    if (remaining <= 0) return
    const n = Math.min(billable[key], remaining)
    billable[key] -= n
    remaining -= n
  }

  deduct('cacheWrite')
  deduct('cacheRead')

  return billable
}

export function calculateCost(usage: UsageData, multiplier = 1): number {
  const price = findModelPrice(usage.model)
  if (!price) {
    log('warn', `No pricing found for model: ${usage.model}`)
    return 0
  }
  const base =
    (usage.inputTokens / 1_000_000) * price.inputMtok +
    (usage.outputTokens / 1_000_000) * price.outputMtok +
    (usage.cacheRead / 1_000_000) * price.cacheReadMtok +
    (usage.cacheWrite / 1_000_000) * price.cacheWriteMtok
  const m = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1
  return base * m
}

export async function recordUsage(
  clientId: string,
  usage: UsageData,
  path: string,
  statusCode: number,
  latencyMs: number,
  oauthAccountId?: string,
  subscriptionId?: string,
  traceId?: string,
  multiplier: number = 1,
  balanceAfter?: number | null,
): Promise<void> {
  const cost = calculateCost(usage, multiplier)
  const m = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1
  try {
    await query(
      `INSERT INTO usage_records
         (client_id, model, input_tokens, output_tokens, cache_read, cache_write,
          cost, latency_ms, path, status_code, oauth_account_id, trace_id, subscription_id,
          balance_after, billing_multiplier)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [clientId, usage.model, usage.inputTokens, usage.outputTokens,
       usage.cacheRead, usage.cacheWrite, cost, latencyMs, path, statusCode,
       oauthAccountId ?? null, traceId ?? null, subscriptionId ?? null,
       balanceAfter ?? null, m],
    )
    log('debug', `Recorded usage: ${usage.model} in=${usage.inputTokens} out=${usage.outputTokens} cache_r=${usage.cacheRead} cache_w=${usage.cacheWrite} cost=$${cost.toFixed(6)}`)
  } catch (err) {
    log('error', `Failed to record usage: ${err}`)
  }
}

// Parse usage from a non-streaming JSON response
export function parseUsageFromJSON(body: string): UsageData | null {
  try {
    const data = JSON.parse(body)
    if (!data.usage || !data.model) return null
    return {
      model: data.model,
      inputTokens: data.usage.input_tokens ?? 0,
      outputTokens: data.usage.output_tokens ?? 0,
      cacheRead: data.usage.cache_read_input_tokens ?? 0,
      cacheWrite: data.usage.cache_creation_input_tokens ?? 0,
    }
  } catch {
    return null
  }
}

// Parse usage from SSE stream (call with accumulated text after stream ends)
export function parseUsageFromSSE(text: string): UsageData | null {
  let model = ''
  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let cacheWrite = 0

  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    try {
      const data = JSON.parse(line.slice(6))
      if (data.type === 'message_start' && data.message) {
        model = data.message.model ?? ''
        if (data.message.usage) {
          inputTokens = data.message.usage.input_tokens ?? 0
          cacheRead = data.message.usage.cache_read_input_tokens ?? 0
          cacheWrite = data.message.usage.cache_creation_input_tokens ?? 0
        }
      }
      if (data.type === 'message_delta' && data.usage) {
        outputTokens = data.usage.output_tokens ?? 0
      }
    } catch {}
  }

  if (!model) return null
  return { model, inputTokens, outputTokens, cacheRead, cacheWrite }
}
