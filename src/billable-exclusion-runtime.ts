import { normalizeTemplateBillableExcludedModel } from './billable-exclusion-store.js'
import {
  resolveTemplateBillableExcludedTokens,
  type ResolveBillableExcludedTokensArgs,
  type ResolveBillableExcludedTokensDeps,
} from './billable-exclusion-cache.js'
import { applyBillableExclusion, type UsageData } from './metering.js'
import { log } from './logger.js'

export type BillableExclusionPreflight = {
  model: string | null
  tokens: number | null
}

type Resolver = (
  args: ResolveBillableExcludedTokensArgs,
  deps?: Partial<ResolveBillableExcludedTokensDeps>,
) => Promise<number>

type RuntimeDeps = {
  resolve: Resolver
}

const defaultDeps: RuntimeDeps = {
  resolve: resolveTemplateBillableExcludedTokens,
}

const EMPTY_PREFLIGHT: BillableExclusionPreflight = { model: null, tokens: null }

function extractOutboundModel(outboundBody: Buffer, fallback: string | null | undefined): string | null {
  try {
    const parsed = JSON.parse(outboundBody.toString('utf-8'))
    if (typeof parsed?.model === 'string' && parsed.model.length > 0) return parsed.model
  } catch {}
  return fallback ?? null
}

export async function resolveBillableExclusionPreflight(
  args: {
    shouldMeter: boolean
    path: string
    accountAuthKind: string | null | undefined
    templateId: string | null | undefined
    requestModel: string | null | undefined
    outboundBody: Buffer
    upstream: URL
    headers: Record<string, string>
    agent?: any
    traceId?: string
  },
  deps: Partial<RuntimeDeps> = {},
): Promise<BillableExclusionPreflight> {
  if (!args.shouldMeter || args.path.includes('/count_tokens') || args.accountAuthKind !== 'oauth') {
    return { ...EMPTY_PREFLIGHT }
  }

  const d = { ...defaultDeps, ...deps }
  const model = extractOutboundModel(args.outboundBody, args.requestModel)
  const tokens = await d.resolve({
    templateId: args.templateId ?? null,
    model,
    outboundBody: args.outboundBody,
    upstream: args.upstream,
    headers: args.headers,
    agent: args.agent,
    traceId: args.traceId,
  }, {
    shouldAutoCalculate: () => true,
  }).catch((err) => {
    log('warn', `Billable exclusion preflight failed: ${err?.message ?? String(err)} [trace=${args.traceId ?? ''}]`)
    return 0
  })

  return { model, tokens }
}

export async function resolveBillableExcludedTokensForUsage(
  args: {
    accountAuthKind: string | null | undefined
    templateId: string | null | undefined
    usageModel: string
    preflight: BillableExclusionPreflight
    outboundBody: Buffer
    upstream: URL
    headers: Record<string, string>
    agent?: any
    traceId?: string
  },
  deps: Partial<RuntimeDeps> = {},
): Promise<number> {
  if (args.accountAuthKind !== 'oauth') return 0

  if (
    args.preflight.model
    && normalizeTemplateBillableExcludedModel(args.preflight.model) === normalizeTemplateBillableExcludedModel(args.usageModel)
    && args.preflight.tokens !== null
  ) {
    return args.preflight.tokens
  }

  const d = { ...defaultDeps, ...deps }
  return d.resolve({
    templateId: args.templateId ?? null,
    model: args.usageModel,
    outboundBody: args.outboundBody,
    upstream: args.upstream,
    headers: args.headers,
    agent: args.agent,
    traceId: args.traceId,
  }).catch(() => 0)
}

export async function resolveBillableUsageForRecord(
  args: {
    accountAuthKind: string | null | undefined
    templateId: string | null | undefined
    usage: UsageData
    preflight: BillableExclusionPreflight
    outboundBody: Buffer
    upstream: URL
    headers: Record<string, string>
    agent?: any
    traceId?: string
  },
  deps: Partial<RuntimeDeps> = {},
): Promise<{ excludedTokens: number; billableUsage: UsageData }> {
  const excludedTokens = await resolveBillableExcludedTokensForUsage({
    accountAuthKind: args.accountAuthKind,
    templateId: args.templateId,
    usageModel: args.usage.model,
    preflight: args.preflight,
    outboundBody: args.outboundBody,
    upstream: args.upstream,
    headers: args.headers,
    agent: args.agent,
    traceId: args.traceId,
  }, deps)

  return {
    excludedTokens,
    billableUsage: applyBillableExclusion(args.usage, excludedTokens),
  }
}
