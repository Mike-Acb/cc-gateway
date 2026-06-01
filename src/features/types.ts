import type { IncomingMessage, ServerResponse, IncomingHttpHeaders } from 'http'
import type { Readable } from 'stream'
import type { Account } from '../account-pool.js'
import type { RequestShape } from '../request-shapes.js'
import type { BlockReason, BlockSource } from '../request-logger.js'

export type Phase =
  | 'inbound-validate'
  | 'outbound-canonical'
  | 'outbound-clean'
  | 'outbound-override'

export const PHASE_ORDER: Phase[] = [
  'inbound-validate', 'outbound-canonical', 'outbound-clean', 'outbound-override',
]

export type FeatureFailure = {
  ok: false
  status: number
  reason: string
  blockReason: BlockReason
  blockSource: BlockSource    // inbound features 都是 'gw';upstream 反向是 'up'(由 forward 写)
}

export type FeatureResult = { ok: true } | FeatureFailure

export interface Feature {
  id: string
  phase: Phase
  appliesTo?: (ctx: PipelineContext) => boolean
  run(ctx: PipelineContext): Promise<FeatureResult> | FeatureResult
}

export interface PipelineContext {
  // 入站只读快照
  readonly req: IncomingMessage
  readonly res: ServerResponse
  readonly method: string
  readonly path: string
  readonly clientName: string
  readonly clientId: string | null
  readonly clientIp: string | null
  readonly traceId: string
  readonly operationId: string
  readonly rootTraceId: string
  readonly parentTraceId: string | null
  readonly requestHeadersIn: Record<string, string | string[] | undefined>
  readonly requestBodyIn: Buffer
  readonly parsedRequestBody: any | null
  readonly requestModel: string | null
  readonly requestSpeed: string | null
  readonly requestIsStream: boolean
  readonly bodyUserId: string | null
  readonly sessionKey: string
  readonly shapeIn: RequestShape

  // 选账号阶段写入
  account: Account
  credential: string

  // pipeline 中间可变态
  outboundHeaders: Record<string, string>
  outboundBody: Buffer
  parsedOutboundBody: any | null
  shapeOut: RequestShape | null
  derivedSessionId: string | null
  forceStripSignatures: boolean
  /**
   * shapeAutoComplete 路径上,gateway 自动补齐的 body 字段名列表
   * (如 ['temperature:1'])。null=未补/未启用;[] 兼容性占位不出现。
   * 进 request_logs.auto_completed_fields 用于审计。
   */
  autoCompletedFields: string[] | null
  /**
   * shapeAutoComplete 触发补齐 + 重分类后的新 RequestShape。
   * null=未触发或重分类与原相同。proxy 在 pipeline 完成后会用它替换
   * rootShapeIn,让下游 (rewriter / validateCCRequest) 看到升级后的 profile。
   */
  shapeInRefined: RequestShape | null

  // 收尾
  upstreamResponse?: { status: number; headers: IncomingHttpHeaders; body: Readable }
  blockReason?: BlockReason
  blockSource?: BlockSource
  emitCtx?: any

  resetOutbound(): void
}

// 跨 phase 通用 helper
export function isMessagesPath(ctx: PipelineContext): boolean {
  return ctx.path.startsWith('/v1/messages')
}
export function isCountTokensPath(ctx: PipelineContext): boolean {
  return ctx.path.includes('/count_tokens')
}
export function isMessagesNotCountTokens(ctx: PipelineContext): boolean {
  return isMessagesPath(ctx) && !isCountTokensPath(ctx)
}
