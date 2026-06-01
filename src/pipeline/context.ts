import type { IncomingMessage, ServerResponse } from 'http'
import type { PipelineContext } from '../features/types.js'
import type { Account } from '../account-pool.js'
import type { RequestShape } from '../request-shapes.js'

interface CreateInput {
  req: IncomingMessage
  res: ServerResponse
  method: string
  path: string
  clientName: string
  clientId: string | null
  clientIp: string | null
  traceId: string
  operationId: string
  rootTraceId: string
  parentTraceId: string | null
  requestBodyIn: Buffer
  parsedRequestBody: any | null
  requestModel: string | null
  requestSpeed: string | null
  requestIsStream: boolean
  bodyUserId: string | null
  sessionKey: string
  shapeIn: RequestShape
  account: Account
  credential: string
}

function shallowCopyHeaders(src: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v
  }
  return out
}

export function createPipelineContext(input: CreateInput): PipelineContext {
  const requestHeadersIn = input.req.headers as Record<string, string | string[] | undefined>
  const ctx: PipelineContext = {
    req: input.req,
    res: input.res,
    method: input.method,
    path: input.path,
    clientName: input.clientName,
    clientId: input.clientId,
    clientIp: input.clientIp,
    traceId: input.traceId,
    operationId: input.operationId,
    rootTraceId: input.rootTraceId,
    parentTraceId: input.parentTraceId,
    requestHeadersIn,
    requestBodyIn: input.requestBodyIn,
    parsedRequestBody: input.parsedRequestBody,
    requestModel: input.requestModel,
    requestSpeed: input.requestSpeed,
    requestIsStream: input.requestIsStream,
    bodyUserId: input.bodyUserId,
    sessionKey: input.sessionKey,
    shapeIn: input.shapeIn,
    account: input.account,
    credential: input.credential,
    outboundHeaders: shallowCopyHeaders(requestHeadersIn),
    outboundBody: input.requestBodyIn,
    parsedOutboundBody: input.parsedRequestBody,
    shapeOut: null,
    derivedSessionId: null,
    forceStripSignatures: false,
    autoCompletedFields: null,
    shapeInRefined: null,
    resetOutbound() {
      this.outboundHeaders = shallowCopyHeaders(this.requestHeadersIn)
      this.outboundBody = this.requestBodyIn
      this.parsedOutboundBody = this.parsedRequestBody
      this.shapeOut = null
      this.derivedSessionId = null
    },
  } as PipelineContext
  return ctx
}
