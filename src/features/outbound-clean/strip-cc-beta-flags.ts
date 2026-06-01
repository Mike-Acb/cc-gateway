import type { Feature, PipelineContext } from '../types.js'

const CC_ONLY_BETA_FLAG_PREFIXES = ['claude-code-']

export const stripCcBetaFlags: Feature = {
  id: 'strip-cc-beta-flags',
  phase: 'outbound-clean',
  run(ctx: PipelineContext) {
    const beta = ctx.outboundHeaders['anthropic-beta']
    if (!beta) return { ok: true }
    const stripped = beta.split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !CC_ONLY_BETA_FLAG_PREFIXES.some(p => s.startsWith(p)))
      .join(',')
    if (stripped) ctx.outboundHeaders['anthropic-beta'] = stripped
    else delete ctx.outboundHeaders['anthropic-beta']
    return { ok: true }
  },
}
