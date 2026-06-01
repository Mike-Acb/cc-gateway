import type { Feature, FeatureResult, PipelineContext } from '../types.js'
import { isMessagesNotCountTokens } from '../types.js'

/**
 * 把 temperature 规整到 CC 真实分布:
 *   - thinking active (enabled/adaptive) → 删 temperature
 *   - 否则 → temperature = 1 (覆盖任意值)
 *
 * CC source: claude.ts `temperature = !hasThinking ? (override ?? 1) : undefined`
 *
 * 必须在 inbound-validate 第一步跑 — 让 unknown_messages_shape (如 IDE agent
 * 默认 temperature=0) 经修正后能重分类为 agentic_*_t1_like / _temperature_one_like,
 * 自动通过后续 requestShape 校验,而不必依赖 shapeAutoComplete 的 PENDING 兜底。
 *
 * 与 applyShapeAutoComplete 的差别:
 *   - applyShapeAutoComplete 只在 temperature===undefined 时补 1 (零副作用)
 *   - 这里会**覆盖**客户端原值,有语义影响 (temperature=0 改成 1 让模型更随机)
 *     所以用独立开关 + OAuth 默认开 / APIKEY 默认关 (透传客户端原值)
 *
 * 不抛错,纯 mutation。返回 ok:true 永远放行 — 实际形态校验由后续 requestShape 接力。
 */
export const normalizeTemperature: Feature = {
  id: 'normalize-temperature',
  phase: 'inbound-validate',
  appliesTo: isMessagesNotCountTokens,
  run(ctx: PipelineContext): FeatureResult {
    const body = ctx.parsedRequestBody
    if (!body || typeof body !== 'object') return { ok: true }

    const t = body.thinking?.type
    const hasActiveThinking = t === 'enabled' || t === 'adaptive'
    const tags: string[] = []

    if (hasActiveThinking) {
      if ('temperature' in body) {
        tags.push(`normalize_temp:thinking_active_dropped:${body.temperature}`)
        delete body.temperature
      }
    } else {
      if (body.temperature !== 1) {
        const prev = body.temperature
        body.temperature = 1
        tags.push(`normalize_temp:set_one:${prev === undefined ? 'unset' : prev}`)
      }
    }

    if (tags.length > 0) {
      ctx.autoCompletedFields = [...(ctx.autoCompletedFields ?? []), ...tags]
    }
    return { ok: true }
  },
}
