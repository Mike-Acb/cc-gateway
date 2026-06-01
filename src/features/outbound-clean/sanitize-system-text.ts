import type { Feature, PipelineContext } from '../types.js'

const BILLING_HEADER_RE = /^\s*x-anthropic-billing-header:[^\n]*(?:\n|$)/gm
const CC_INTRO_RE = /^\s*You are Claude Code, Anthropic's official CLI for Claude\.\s*(?:\n|$)/gm

function strip(text: string): string {
  return text.replace(BILLING_HEADER_RE, '').replace(CC_INTRO_RE, '').trim()
}

function recurse(value: unknown): unknown {
  if (typeof value === 'string') {
    const s = strip(value)
    return s.length > 0 ? s : undefined
  }
  if (Array.isArray(value)) {
    return value.map(recurse).filter(v => v !== undefined)
  }
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const next = recurse(v)
    if (next !== undefined) out[k] = next
  }
  return out
}

export const sanitizeSystemText: Feature = {
  id: 'sanitize-system-text',
  phase: 'outbound-clean',
  run(ctx: PipelineContext) {
    if (!ctx.parsedOutboundBody) return { ok: true }
    const sanitized = recurse(ctx.parsedOutboundBody)
    if (sanitized === undefined) return { ok: true }
    ctx.parsedOutboundBody = sanitized
    ctx.outboundBody = Buffer.from(JSON.stringify(sanitized), 'utf-8')
    return { ok: true }
  },
}
