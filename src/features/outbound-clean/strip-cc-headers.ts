import type { Feature, PipelineContext } from '../types.js'

const FORWARD_DROP_PREFIXES = ['x-claude-code-', 'x-stainless-', 'cf-', 'x-forwarded-', 'cdn-']

// 注意:user-agent 不在硬清单内 — 由 outbound-override/user-agent 三态 feature 决定。
// 等价于 baseline 行为靠 ApiKey 默认 userAgent.mode='omit' 达成。
const FORWARD_DROP_EXACT = new Set([
  'authorization', 'x-api-key', 'host', 'content-length', 'connection',
  'proxy-connection', 'accept-encoding', 'cdn-loop', 'x-real-ip', 'forwarded',
  'cookie', 'x-app',
])

export const stripCcHeaders: Feature = {
  id: 'strip-cc-headers',
  phase: 'outbound-clean',
  run(ctx: PipelineContext) {
    for (const k of Object.keys(ctx.outboundHeaders)) {
      const lower = k.toLowerCase()
      if (FORWARD_DROP_EXACT.has(lower) || FORWARD_DROP_PREFIXES.some(p => lower.startsWith(p))) {
        delete ctx.outboundHeaders[k]
      }
    }
    return { ok: true }
  },
}
