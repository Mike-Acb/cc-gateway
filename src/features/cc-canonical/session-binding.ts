import type { Feature, PipelineContext } from '../types.js'
import { isMessagesNotCountTokens } from '../types.js'
import { getOrAssignSession } from '../../session-slots.js'
import { deriveFallbackSessionId } from '../../rewriter.js'

export const ccSessionBinding: Feature = {
  id: 'cc-session-binding',
  phase: 'outbound-canonical',
  appliesTo: isMessagesNotCountTokens,
  async run(ctx: PipelineContext) {
    const id = await getOrAssignSession(
      ctx.account.id, ctx.sessionKey, ctx.clientName,
      ctx.account.maxSessions ?? 0,
    ) || deriveFallbackSessionId(ctx.account.canonicalIdentity?.account_uuid ?? ctx.account.id)
    ctx.derivedSessionId = id
    return { ok: true as const }
  },
}
