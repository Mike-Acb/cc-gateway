import type { Feature, PipelineContext } from '../types.js'

export function extraHeaders(map: Record<string, string>): Feature {
  return {
    id: 'extra-headers',
    phase: 'outbound-override',
    run(ctx: PipelineContext) {
      for (const [k, v] of Object.entries(map)) {
        ctx.outboundHeaders[k.toLowerCase()] = v
      }
      return { ok: true }
    },
  }
}
