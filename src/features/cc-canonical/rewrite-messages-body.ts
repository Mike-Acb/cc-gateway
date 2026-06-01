import type { Feature, PipelineContext } from '../types.js'
import { isMessagesNotCountTokens } from '../types.js'
import { NonCCRequestError } from '../../cc-disguise.js'

// Phase 3 占位:错误转换 + ctx.forceStripSignatures 读取契约
// 真正的 rewriteMessagesBody + shouldStripSignatureBlocksForContext 调用 wiring
// 在 Phase 4 切换 proxy.ts 时填充。
export const ccRewriteMessagesBody: Feature = {
  id: 'cc-rewrite-messages-body',
  phase: 'outbound-canonical',
  appliesTo: isMessagesNotCountTokens,
  async run(_ctx: PipelineContext) {
    try {
      // Phase 4:在此调 rewriteMessagesBody(ctx.parsedOutboundBody, ...) 与
      // shouldStripSignatureBlocksForContext(ctx.sessionKey, ctx.account.id, ...)
      // 若 ctx.forceStripSignatures === true,直接覆盖 redis 查询结果为 true。
      return { ok: true as const }
    } catch (err) {
      if (err instanceof NonCCRequestError) {
        return {
          ok: false as const, status: 400,
          reason: 'non-cc request rejected at canonical rewrite',
          blockReason: 'non_cc_request', blockSource: 'gw' as const,
        }
      }
      throw err
    }
  },
}
