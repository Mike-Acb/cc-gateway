import type { Feature, PipelineContext } from '../types.js'
import { isMessagesNotCountTokens } from '../types.js'

// Phase 3 占位:守卫 ccTemplateId,真正的 buildCCHeaders 调用 wiring
// 在 Phase 4 切换 proxy.ts 到 pipeline.handle 时填充(需要 buildEffectiveProfile +
// ResolvedIdentity 上下文,这些在当前 ctx 还未完整组装)。
export const ccBuildHeaders: Feature = {
  id: 'cc-build-headers',
  phase: 'outbound-canonical',
  appliesTo: isMessagesNotCountTokens,
  run(ctx: PipelineContext) {
    if (!ctx.account.ccTemplateId) {
      return {
        ok: false as const, status: 503,
        reason: `account ${ctx.account.id} has no cc_template_id bound — refusing to forward`,
        blockReason: 'no_cc_template', blockSource: 'gw' as const,
      }
    }
    return { ok: true as const }
  },
}
