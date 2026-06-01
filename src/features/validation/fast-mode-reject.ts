import type { Feature, FeatureResult, PipelineContext } from '../types.js'

export const fastModeReject: Feature = {
  id: 'fast-mode-reject',
  phase: 'inbound-validate',
  run(ctx: PipelineContext): FeatureResult {
    if (ctx.requestSpeed === 'fast') {
      return {
        ok: false, status: 400,
        reason: 'Fast mode (speed: "fast") is not supported by this gateway',
        blockReason: 'fast_mode_blocked', blockSource: 'gw',
      }
    }
    return { ok: true }
  },
}
