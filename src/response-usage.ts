import { Transform } from 'stream'
import type { OutgoingHttpHeaders } from 'http'
import { applyBillableExclusion, type UsageData } from './metering.js'
import { normalizeTemplateBillableExcludedModel } from './billable-exclusion-store.js'

type BillableUsagePreflight = {
  model: string | null
  tokens: number | null
}

function usageFromAnthropic(model: string, usage: any): UsageData {
  return {
    model,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
    cacheWrite: usage?.cache_creation_input_tokens ?? 0,
  }
}

function writeAnthropicUsage(target: any, usage: UsageData): void {
  target.input_tokens = usage.inputTokens
  target.output_tokens = usage.outputTokens
  target.cache_read_input_tokens = usage.cacheRead
  target.cache_creation_input_tokens = usage.cacheWrite
}

export function rewriteJSONUsageForBillableResponse(
  responseText: string,
  excludedTokens: number,
): { text: string; rewritten: boolean } {
  if (excludedTokens <= 0) return { text: responseText, rewritten: false }
  try {
    const parsed = JSON.parse(responseText)
    if (!parsed?.usage || typeof parsed?.model !== 'string') {
      return { text: responseText, rewritten: false }
    }
    const raw = usageFromAnthropic(parsed.model, parsed.usage)
    const billable = applyBillableExclusion(raw, excludedTokens)
    writeAnthropicUsage(parsed.usage, billable)
    return { text: JSON.stringify(parsed), rewritten: true }
  } catch {
    return { text: responseText, rewritten: false }
  }
}

export function createSSEUsageBillableTransform(
  excludedTokens: number,
  expectedModel: string | null,
): Transform {
  let leftover = ''

  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const text = leftover + chunk.toString('utf-8')
      const events = text.split(/\n\n/)
      leftover = events.pop() ?? ''

      const out: string[] = []
      for (const rawEvent of events) {
        if (rawEvent.length === 0) continue
        out.push(rewriteSSEEventUsage(rawEvent, excludedTokens, expectedModel) + '\n\n')
      }
      if (out.length > 0) this.push(out.join(''))
      cb()
    },
    flush(cb) {
      if (leftover.length > 0) {
        this.push(rewriteSSEEventUsage(leftover, excludedTokens, expectedModel))
      }
      cb()
    },
  })
}

export function createSSEUsageBillableTransformForResponse(args: {
  status: number
  isSSE: boolean
  responseEncoding: string | string[] | undefined
  preflight: BillableUsagePreflight
}): Transform | null {
  if (
    args.status < 200
    || args.status >= 300
    || !args.isSSE
    || args.responseEncoding
    || args.preflight.tokens === null
    || args.preflight.tokens <= 0
  ) {
    return null
  }
  return createSSEUsageBillableTransform(args.preflight.tokens, args.preflight.model)
}

export function rewriteJSONUsageForBillableResponseBuffer(
  responseText: string,
  responseHeaders: OutgoingHttpHeaders,
  excludedTokens: number,
): { body: Buffer; headers: OutgoingHttpHeaders } | null {
  const rewritten = rewriteJSONUsageForBillableResponse(responseText, excludedTokens)
  if (!rewritten.rewritten) return null

  const body = Buffer.from(rewritten.text, 'utf-8')
  const headers = { ...responseHeaders }
  delete headers['content-encoding']
  headers['content-length'] = String(body.length)
  return { body, headers }
}

export function rewriteSSEEventUsage(
  rawEvent: string,
  excludedTokens: number,
  expectedModel: string | null,
): string {
  if (excludedTokens <= 0) return rawEvent

  const lines = rawEvent.split('\n')
  const dataIdx = lines.findIndex((line) => line.startsWith('data: '))
  if (dataIdx === -1) return rawEvent

  let parsed: any
  try {
    parsed = JSON.parse(lines[dataIdx].slice(6))
  } catch {
    return rawEvent
  }

  if (parsed?.type !== 'message_start' || !parsed?.message?.usage) {
    return rawEvent
  }

  const model = typeof parsed.message.model === 'string' ? parsed.message.model : ''
  if (
    expectedModel
    && model
    && normalizeTemplateBillableExcludedModel(expectedModel) !== normalizeTemplateBillableExcludedModel(model)
  ) {
    return rawEvent
  }

  const raw = usageFromAnthropic(model, parsed.message.usage)
  const billable = applyBillableExclusion(raw, excludedTokens)
  writeAnthropicUsage(parsed.message.usage, billable)
  lines[dataIdx] = 'data: ' + JSON.stringify(parsed)
  return lines.join('\n')
}
