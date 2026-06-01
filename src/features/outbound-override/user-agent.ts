import type { Feature, PipelineContext } from '../types.js'
import type { AccountOptions } from '../options.js'

type Cfg = AccountOptions['override']['userAgent']

export function userAgent(cfg: Cfg): Feature {
  return {
    id: 'user-agent',
    phase: 'outbound-override',
    run(ctx: PipelineContext) {
      if (cfg.mode === 'omit') {
        delete ctx.outboundHeaders['user-agent']
      } else if (cfg.mode === 'passthrough') {
        const ua = ctx.requestHeadersIn['user-agent']
        if (Array.isArray(ua)) ctx.outboundHeaders['user-agent'] = ua[0] ?? ''
        else if (typeof ua === 'string') ctx.outboundHeaders['user-agent'] = ua
      } else if (cfg.mode === 'override' && cfg.value) {
        ctx.outboundHeaders['user-agent'] = cfg.value
      }
      return { ok: true }
    },
  }
}
