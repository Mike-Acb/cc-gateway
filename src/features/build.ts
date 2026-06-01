import type { Feature } from './types.js'
import type { Account } from '../account-pool.js'
import { bodyIntegrity } from './validation/body-integrity.js'
import { normalizeTemperature } from './validation/normalize-temperature.js'
import { requestShape } from './validation/request-shape.js'
import { modelAllowlist } from './validation/model-allowlist.js'
import { fastModeReject } from './validation/fast-mode-reject.js'
import { requireStream } from './validation/require-stream.js'
import { stripCcHeaders } from './outbound-clean/strip-cc-headers.js'
import { stripCcBetaFlags } from './outbound-clean/strip-cc-beta-flags.js'
import { sanitizeSystemText } from './outbound-clean/sanitize-system-text.js'
import { dropMetadata } from './outbound-clean/drop-metadata.js'
import { userAgent } from './outbound-override/user-agent.js'
import { anthropicVersion } from './outbound-override/anthropic-version.js'
import { anthropicBeta } from './outbound-override/anthropic-beta.js'
import { extraHeaders } from './outbound-override/extra-headers.js'
import { ccBuildHeaders } from './cc-canonical/build-headers.js'
import { ccRewriteMessagesBody } from './cc-canonical/rewrite-messages-body.js'
import { ccSessionBinding } from './cc-canonical/session-binding.js'

export function buildFeatures(account: Account): Feature[] {
  const o = account.options
  const f: Feature[] = []

  // inbound-validate
  // normalizeTemperature 必须放第一位 — 让 requestShape 看到规整后的 temperature,
  // 使原本 unknown_messages_shape (IDE agent 默认 temperature=0) 升级为
  // agentic_*_t1_like / _temperature_one_like 等严格 allowlist 内的 profile。
  if (o.validate.normalizeTemperature) f.push(normalizeTemperature)
  if (o.validate.body)          f.push(bodyIntegrity)
  if (o.validate.shape)         f.push(requestShape)
  if (o.validate.model)         f.push(modelAllowlist)
  if (o.validate.fastMode)      f.push(fastModeReject)
  if (o.validate.requireStream) f.push(requireStream)

  // outbound-canonical
  if (o.canonicalCcMessages) f.push(ccBuildHeaders, ccRewriteMessagesBody, ccSessionBinding)

  // outbound-clean
  if (o.clean.ccHeaders)    f.push(stripCcHeaders)
  if (o.clean.ccBetaFlags)  f.push(stripCcBetaFlags)
  if (o.clean.systemText)   f.push(sanitizeSystemText)
  if (o.clean.metadata)     f.push(dropMetadata)

  // outbound-override(三态 feature 内部判 mode='omit' 直接 noop)
  f.push(userAgent(o.override.userAgent))
  f.push(anthropicVersion(o.override.anthropicVersion))
  f.push(anthropicBeta(o.override.anthropicBeta))
  f.push(extraHeaders(o.override.extraHeaders))

  return f
}
