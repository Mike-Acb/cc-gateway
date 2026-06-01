import { DEPLOYMENT } from './db.js'
import { getRedis, isRedisAvailable } from './redis.js'

export function normalizeTemplateBillableExcludedModel(model: string): string {
  return model.replace(/-\d{8}$/, '')
}

export function templateBillableExcludedTokensRedisKey(templateId: string, model: string): string {
  return `cc_disguise_template_billable_excluded:${DEPLOYMENT}:${templateId}:${normalizeTemplateBillableExcludedModel(model)}`
}

export function templateBillableExcludedTokensLockRedisKey(templateId: string, model: string): string {
  return `cc_disguise_template_billable_excluded_lock:${DEPLOYMENT}:${templateId}:${normalizeTemplateBillableExcludedModel(model)}`
}

export function templateBillableExcludedTokensCooldownRedisKey(templateId: string, model: string): string {
  return `cc_disguise_template_billable_excluded_cooldown:${DEPLOYMENT}:${templateId}:${normalizeTemplateBillableExcludedModel(model)}`
}

export async function getTemplateBillableExcludedTokens(
  templateId: string | null,
  model: string | null | undefined,
): Promise<number> {
  const state = await readTemplateBillableExcludedTokens(templateId, model)
  return state.value
}

export async function readTemplateBillableExcludedTokens(
  templateId: string | null,
  model: string | null | undefined,
): Promise<{ hit: boolean; value: number }> {
  if (!templateId || !model || !isRedisAvailable()) return { hit: false, value: 0 }
  const raw = await getRedis().get(templateBillableExcludedTokensRedisKey(templateId, model))
  if (raw === null) return { hit: false, value: 0 }
  const n = Number(raw ?? 0)
  return { hit: true, value: Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0 }
}

export async function setTemplateBillableExcludedTokens(
  templateId: string,
  model: string,
  tokens: number,
): Promise<void> {
  if (!isRedisAvailable()) return
  const n = Math.max(0, Math.floor(Number.isFinite(tokens) ? tokens : 0))
  await getRedis().set(templateBillableExcludedTokensRedisKey(templateId, model), String(n))
}
