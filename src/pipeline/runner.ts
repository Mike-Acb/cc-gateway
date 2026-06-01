import type { Feature, FeatureResult, PipelineContext } from '../features/types.js'

export async function run(features: Feature[], ctx: PipelineContext): Promise<FeatureResult> {
  for (const f of features) {
    if (f.appliesTo && !f.appliesTo(ctx)) continue
    const r = await f.run(ctx)
    if (!r.ok) {
      ctx.blockReason = r.blockReason
      ctx.blockSource = r.blockSource
      return r
    }
  }
  return { ok: true }
}
