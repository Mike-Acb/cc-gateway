import type { PipelineContext } from '../../src/features/types.js'
import type { Account } from '../../src/account-pool.js'
import { OAUTH_DEFAULT_OPTIONS, APIKEY_DEFAULT_OPTIONS } from '../../src/features/options.js'

function fakeAccount(authKind: 'oauth' | 'api_key'): Account {
  const common = {
    id: `acct-${authKind}`,
    name: `test-${authKind}`,
    status: 'active',
    accountType: 'pro',
    maxRpm: 60, maxTpm: 80000, maxConcurrent: 5, maxSessions: 3,
    maxDailyReq: 0, maxDailyTok: 0, maxDailyCost: 0,
    weight: 10, models: null, cooldownSeconds: 60, maxRetries: 2,
    sessionTtlSeconds: 0,
    outboundProxyId: null,
    canonicalIdentity: null,
    identityProfile: null,
    groupId: null,
    groupIds: [],
    authKind,
    simulateFingerprint: true,
    organizationUuid: null,
    accountUuidCol: null,
    ccTemplateId: 'tpl-1',
    options: authKind === 'oauth' ? OAUTH_DEFAULT_OPTIONS : APIKEY_DEFAULT_OPTIONS,
  }
  if (authKind === 'oauth') {
    return { ...common, authKind: 'oauth', refreshToken: 'r', accessToken: 'a', expiresAt: 0 } as Account
  }
  return { ...common, authKind: 'api_key', provider: 'anthropic', apiKey: 'sk-x', apiBaseUrl: 'https://api.anthropic.com' } as Account
}

export function makeCtx(overrides: Partial<PipelineContext> & { authKind?: 'oauth' | 'api_key' } = {}): PipelineContext {
  const { authKind = 'oauth', ...rest } = overrides
  const baseHeaders: Record<string, string> = {}
  const ctx: PipelineContext = {
    req: {} as any,
    res: {} as any,
    method: 'POST',
    path: '/v1/messages',
    clientName: 'test',
    clientId: null,
    clientIp: null,
    traceId: 't', operationId: 'o', rootTraceId: 'r', parentTraceId: null,
    requestHeadersIn: {},
    requestBodyIn: Buffer.alloc(0),
    parsedRequestBody: null,
    requestModel: 'claude-sonnet-4-5',
    requestSpeed: null,
    requestIsStream: true,
    bodyUserId: null,
    sessionKey: 's',
    shapeIn: { family: 'message', profile: 'free', confidence: 100, reason: [] } as any,
    account: fakeAccount(authKind),
    credential: 'cred',
    outboundHeaders: baseHeaders,
    outboundBody: Buffer.alloc(0),
    parsedOutboundBody: null,
    shapeOut: null,
    derivedSessionId: null,
    forceStripSignatures: false,
    autoCompletedFields: null,
    shapeInRefined: null,
    resetOutbound() {
      this.outboundHeaders = { ...this.requestHeadersIn } as any
      this.outboundBody = this.requestBodyIn
      this.parsedOutboundBody = this.parsedRequestBody
      this.shapeOut = null
      this.derivedSessionId = null
    },
    ...rest,
  } as PipelineContext
  return ctx
}
