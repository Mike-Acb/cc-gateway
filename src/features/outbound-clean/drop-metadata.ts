import type { Feature, PipelineContext } from '../types.js'

export const dropMetadata: Feature = {
  id: 'drop-metadata',
  phase: 'outbound-clean',
  run(ctx: PipelineContext) {
    if (!ctx.parsedOutboundBody || typeof ctx.parsedOutboundBody !== 'object') return { ok: true }
    if (!('metadata' in ctx.parsedOutboundBody)) return { ok: true }
    const next = { ...ctx.parsedOutboundBody }
    delete (next as any).metadata
    ctx.parsedOutboundBody = next
    ctx.outboundBody = Buffer.from(JSON.stringify(next), 'utf-8')
    return { ok: true }
  },
}
