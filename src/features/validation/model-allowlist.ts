import type { Feature, FeatureResult, PipelineContext } from '../types.js'
import { getUnsupportedModelReason } from '../../account-pool.js'

export const modelAllowlist: Feature = {
  id: 'model-allowlist',
  phase: 'inbound-validate',
  run(ctx: PipelineContext): FeatureResult {
    const reason = getUnsupportedModelReason(ctx.requestModel)
    if (reason) {
      return { ok: false, status: 400, reason, blockReason: 'plan_forbidden_model', blockSource: 'gw' }
    }
    return { ok: true }
  },
}
