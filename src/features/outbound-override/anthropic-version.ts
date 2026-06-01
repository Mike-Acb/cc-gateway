import type { Feature, PipelineContext } from '../types.js'
import type { AccountOptions } from '../options.js'

type Cfg = AccountOptions['override']['anthropicVersion']

export function anthropicVersion(cfg: Cfg): Feature {
  return {
    id: 'anthropic-version',
    phase: 'outbound-override',
    run(ctx: PipelineContext) {
      if (cfg.mode === 'omit') {
        delete ctx.outboundHeaders['anthropic-version']
      } else if (cfg.mode === 'passthrough') {
        const v = ctx.requestHeadersIn['anthropic-version']
        if (Array.isArray(v)) ctx.outboundHeaders['anthropic-version'] = v[0] ?? ''
        else if (typeof v === 'string') ctx.outboundHeaders['anthropic-version'] = v
      } else if (cfg.mode === 'override' && cfg.value) {
        ctx.outboundHeaders['anthropic-version'] = cfg.value
      }
      return { ok: true }
    },
  }
}
