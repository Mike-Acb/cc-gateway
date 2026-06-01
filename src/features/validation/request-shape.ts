import type { Feature, FeatureResult, PipelineContext } from '../types.js'
import { isMessagesNotCountTokens } from '../types.js'
import {
  applyShapeAutoComplete,
  classifyRequestShape,
  validateRequestShape,
} from '../../request-shapes.js'

export const requestShape: Feature = {
  id: 'request-shape',
  phase: 'inbound-validate',
  appliesTo: isMessagesNotCountTokens,
  run(ctx: PipelineContext): FeatureResult {
    const baseInput = {
      method: ctx.method,
      path: ctx.path,
      headers: ctx.requestHeadersIn,
      body: ctx.parsedRequestBody,
      clientName: ctx.clientName,
    }

    // 重分类一次:proxy.ts 的 ctx.shapeIn 是在 inbound-validate 之前算的快照,
    // 而 normalizeTemperature 等前置 feature 已经 mutate 了 body.temperature。
    // 不重分类就会用 stale profile 去对 allowlist —— 比如 normalize 把 0.7 → 1
    // 之后真实形态是 toolless_side_query_temperature_one_like (allowlisted),
    // 但 ctx.shapeIn 还是 _generic_like → 误 400。下面任何"shape 在变"的细节
    // 都依赖这一次重算。
    const liveShape = classifyRequestShape(baseInput)
    const shapeChanged = liveShape.profile !== ctx.shapeIn.profile
    if (shapeChanged) {
      ctx.shapeInRefined = liveShape
      ctx.autoCompletedFields = [
        ...(ctx.autoCompletedFields ?? []),
        `shape_refined:${ctx.shapeIn.profile}->${liveShape.profile}`,
      ]
    }

    // 第一关:严格 allowlist 校验。永远先走严格,不放宽 PENDING。
    const strictErr = validateRequestShape(baseInput, liveShape)
    if (!strictErr) return { ok: true }

    // 严格 fail 之后,看账号是否开启 shapeAutoComplete。
    // 注意:OAuth account 的 options.validate.shape 必须为 true 才会跑到这里
    //       (build.ts:if (o.validate.shape) f.push(requestShape)),所以这里不用再判一次。
    const opts = ctx.account.options
    if (!opts.validate.shapeAutoComplete) {
      return {
        ok: false,
        status: 400,
        reason: strictErr,
        blockReason: 'shape_forbidden',
        blockSource: 'gw',
      }
    }

    // 第二关:permissive 校验(strict allowlist + PENDING 集合都算通过)。
    // 命中 PENDING 时不需要补齐 body,直接放行。
    const permissiveErr = validateRequestShape(baseInput, liveShape, { permissive: true })
    if (!permissiveErr) {
      // 没补字段,但走了宽松通道 — 标记一下用于审计。
      ctx.autoCompletedFields = [
        ...(ctx.autoCompletedFields ?? []),
        `shape_pending_passed:${liveShape.profile}`,
      ]
      return { ok: true }
    }

    // 第三关:尝试补 body 字段(目前只补 temperature),然后**无条件重分类**。
    //
    // 必须无条件重分类的原因:body-integrity feature 跑在本 feature 之前,
    // 如果账号开了 normalizeTemperature,body.temperature 可能已经被它改成 1。
    // 此时 applyShapeAutoComplete 看到 temperature 已合法不再补 → completed=[],
    // 但 body 实际已经合规,只是 ctx.shapeIn 仍是上层 proxy.ts 基于旧 body 算的旧 profile。
    // 不重分类就会误报 shape_forbidden_after_auto_complete。
    const completed = applyShapeAutoComplete(ctx.parsedRequestBody)
    const refinedShape = classifyRequestShape({ ...baseInput, body: ctx.parsedRequestBody })
    const refinedErr = validateRequestShape(
      { ...baseInput, body: ctx.parsedRequestBody },
      refinedShape,
      { permissive: true },
    )
    if (refinedErr) {
      // 补 + 重分类后仍过不了 — 客户端形态根本无法救(thinking enabled/adaptive 但 gate 不允 / 完全异类等)。
      return {
        ok: false,
        status: 400,
        reason: refinedErr,
        blockReason: 'shape_forbidden_after_auto_complete',
        blockSource: 'gw',
      }
    }

    const auditTags = [...completed]
    if (refinedShape.profile !== liveShape.profile) {
      auditTags.push(`shape_refined:${liveShape.profile}->${refinedShape.profile}`)
    }
    if (auditTags.length > 0) {
      ctx.autoCompletedFields = [...(ctx.autoCompletedFields ?? []), ...auditTags]
    }
    // 让下游 (rewriter / validateCCRequest) 看到补齐后的 profile,
    // 否则第二道 gate (cc-disguise) 仍会按原始 generic_like 拒绝。
    ctx.shapeInRefined = refinedShape
    return { ok: true }
  },
}
