import {
  readTemplateBillableExcludedTokens,
  setTemplateBillableExcludedTokens,
  templateBillableExcludedTokensCooldownRedisKey,
  templateBillableExcludedTokensLockRedisKey,
} from './billable-exclusion-store.js'
import { isRedisAvailable, getRedis } from './redis.js'
import { calculateBillableExcludedTokensByMessagesProbe } from './billable-exclusion.js'
import { log } from './logger.js'

type RedisLockClient = {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: 'EX', seconds: number, flag?: 'NX'): Promise<string | null>
  del(key: string): Promise<unknown>
}

export type ResolveBillableExcludedTokensArgs = {
  templateId: string | null
  model: string | null | undefined
  outboundBody: Buffer
  upstream: URL
  headers: Record<string, string>
  agent?: any
  traceId?: string
}

export type ResolveBillableExcludedTokensDeps = {
  read: typeof readTemplateBillableExcludedTokens
  write: typeof setTemplateBillableExcludedTokens
  isRedisAvailable: () => boolean
  getRedis: () => RedisLockClient
  calculate: typeof calculateBillableExcludedTokensByMessagesProbe
  sleep: (ms: number) => Promise<void>
  shouldAutoCalculate: () => boolean
  random: () => number
  log?: typeof log
}

const defaultDeps: ResolveBillableExcludedTokensDeps = {
  read: readTemplateBillableExcludedTokens,
  write: setTemplateBillableExcludedTokens,
  isRedisAvailable,
  getRedis,
  calculate: calculateBillableExcludedTokensByMessagesProbe,
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  shouldAutoCalculate: () => process.env.CC_BILLABLE_EXCLUSION_AUTO_MESSAGES_PROBE === 'true',
  random: Math.random,
  log,
}

function randomMessagesProbeBridgeDelayMs(random: () => number): number {
  const r = Math.min(1, Math.max(0, random()))
  return 1000 + Math.floor(r * 2000)
}

async function resolveTemplateBillableExcludedTokensInternal(
  args: ResolveBillableExcludedTokensArgs,
  deps: Partial<ResolveBillableExcludedTokensDeps> = {},
): Promise<number> {
  const d: ResolveBillableExcludedTokensDeps = { ...defaultDeps, ...deps }
  const { templateId, model } = args
  if (!templateId || !model) return 0

  const cached = await d.read(templateId, model)
  if (cached.hit) return cached.value
  if (!d.shouldAutoCalculate()) return 0
  if (!d.isRedisAvailable()) return 0

  const redis = d.getRedis()
  const cooldownKey = templateBillableExcludedTokensCooldownRedisKey(templateId, model)
  if (await redis.get(cooldownKey).catch(() => null)) return 0

  const lockKey = templateBillableExcludedTokensLockRedisKey(templateId, model)
  const acquired = await redis.set(lockKey, String(Date.now()), 'EX', 60, 'NX')
  if (!acquired) {
    for (let i = 0; i < 5; i++) {
      await d.sleep(200)
      const afterWait = await d.read(templateId, model)
      if (afterWait.hit) return afterWait.value
    }
    return 0
  }

  try {
    const raced = await d.read(templateId, model)
    if (raced.hit) return raced.value

    const computed = await d.calculate({
      outboundBody: args.outboundBody,
      model,
      upstream: args.upstream,
      headers: args.headers,
      agent: args.agent,
      traceId: args.traceId,
    })
    if (computed === null) {
      await redis.set(cooldownKey, '1', 'EX', 60).catch(() => null)
      d.log?.('warn', `Billable exclusion messages probe calculation failed: templateId=${templateId}, model=${model}, traceId=${args.traceId ?? ''}`)
      return 0
    }

    await d.write(templateId, model, computed)
    d.log?.('info', `Billable exclusion cached: templateId=${templateId}, model=${model}, tokens=${computed}, traceId=${args.traceId ?? ''}`)
    return computed
  } finally {
    await redis.del(lockKey).catch(() => {})
  }
}

export async function resolveTemplateBillableExcludedTokens(
  args: ResolveBillableExcludedTokensArgs,
  deps: Partial<ResolveBillableExcludedTokensDeps> = {},
): Promise<number> {
  const d: ResolveBillableExcludedTokensDeps = { ...defaultDeps, ...deps }
  let calledMessagesProbe = false
  const result = await resolveTemplateBillableExcludedTokensInternal(args, {
    ...d,
    calculate: async (calcArgs) => {
      calledMessagesProbe = true
      return d.calculate(calcArgs)
    },
  })

  if (calledMessagesProbe) {
    await d.sleep(randomMessagesProbeBridgeDelayMs(d.random))
  }

  return result
}
