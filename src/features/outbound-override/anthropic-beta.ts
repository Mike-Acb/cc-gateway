import type { Feature, PipelineContext } from '../types.js'
import type { AccountOptions } from '../options.js'

type Cfg = AccountOptions['override']['anthropicBeta']

export function anthropicBeta(cfg: Cfg): Feature {
  return {
    id: 'anthropic-beta',
    phase: 'outbound-override',
    run(ctx: PipelineContext) {
      if (cfg.mode === 'omit') {
        delete ctx.outboundHeaders['anthropic-beta']
      } else if (cfg.mode === 'passthrough') {
        const v = ctx.requestHeadersIn['anthropic-beta']
        if (Array.isArray(v)) ctx.outboundHeaders['anthropic-beta'] = v.join(',')
        else if (typeof v === 'string') ctx.outboundHeaders['anthropic-beta'] = v
      } else if (cfg.mode === 'override' && cfg.value) {
        ctx.outboundHeaders['anthropic-beta'] = cfg.value
      } else if (cfg.mode === 'append' && cfg.value) {
        const exist = ctx.outboundHeaders['anthropic-beta']
        ctx.outboundHeaders['anthropic-beta'] = exist ? `${exist},${cfg.value}` : cfg.value
      }
      return { ok: true }
    },
  }
}
