import type { Feature, FeatureResult, PipelineContext } from '../types.js'
import { isMessagesNotCountTokens } from '../types.js'

export const requireStream: Feature = {
  id: 'require-stream',
  phase: 'inbound-validate',
  appliesTo: isMessagesNotCountTokens,
  run(ctx: PipelineContext): FeatureResult {
    if (!ctx.requestIsStream) {
      return {
        ok: false, status: 400,
        reason: 'Non-streaming requests are not allowed for this account. Set stream: true, or ask an admin to disable validate.requireStream.',
        blockReason: 'non_stream_blocked', blockSource: 'gw',
      }
    }
    return { ok: true }
  },
}
