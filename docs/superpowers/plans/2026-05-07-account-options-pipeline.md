# 账号选项 + 双 pipeline 装配重构 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 OAuth 与 ApiKey 的逻辑彻底分开,所有"校验/清洗/覆盖/事件"做成可装配的 feature。OAuth 默认全开,ApiKey 按需关闭/覆盖。

**Architecture:** 新增 `features/`(17 个原子 feature 单一实现) + `pipeline/`(装配 + retry + logging) + `oauth/forward.ts` / `apikey/forward.ts`(物理分叉) + `options JSONB` 数据列(030 迁移)。`proxy.ts` 从 1700 行瘦身到 ~200 行。

**Tech Stack:** TypeScript / Node.js HTTP / Postgres JSONB / zod / React + Tailwind / vitest

**Spec:** `docs/superpowers/specs/2026-05-07-account-options-pipeline-design.md`

---

## 总览(7 阶段,30 任务)

| 阶段 | 关注点 | 任务数 | 预计 commit |
|---|---|---|---|
| Phase 1 | DB 030 + zod schema + Account 判别联合 | 4 | 1 |
| Phase 2 | features/ 抽出 5 个校验 + 4 个清洗 + 4 个覆盖 | 6 | 3 |
| Phase 3 | features/cc-canonical/ 包装 + NoTemplateBoundError 删除 | 5 | 2 |
| Phase 4 | pipeline/ 装配 + proxy.ts 切换 + rewriter.ts 删除 | 7 | 2 |
| Phase 5 | logging.ts hooks(event_emitter 调用迁移) | 3 | 1 |
| Phase 6 | 前端 AccountOptionsForm + AccountPolicyFields | 3 | 1 |
| Phase 7 | server route 改 options 字段 + gwbk 部署验证 | 2 | 1 |

每阶段独立 commit、独立测试、独立可 revert。

---

## Phase 1:数据库 schema + 类型基础

### Task 1.1:写 030 迁移文件

**Files:**
- Create: `migrations/030_account_options.sql`
- 已 commit:`migrations/028_account_skip_shape_validation.sql`(保留)
- 已 commit:`migrations/029_account_outbound_user_agent.sql`(保留)

- [ ] **Step 1**:复制设计文档 §4 的 SQL 到 `migrations/030_account_options.sql`。完整内容见 spec `## 4 数据库 schema → 030_account_options.sql`。

- [ ] **Step 2**:本地启 Postgres(或用现有 dev 库)跑 011→028→029→030 顺序应用,确认 14 行迁移成功 + DO block 不变量通过。

```bash
PGPASSWORD=$DEV_PG_PASS psql -h $DEV_PG_HOST -U $DEV_PG_USER -d $DEV_PG_DB -v ON_ERROR_STOP=1 -f migrations/030_account_options.sql
# 期望:看到 NOTICE 或 DO 完成,COMMIT 输出
```

- [ ] **Step 3**:用 028/029 还没提交的状态先 `git add migrations/028_account_skip_shape_validation.sql migrations/029_account_outbound_user_agent.sql`(把两个旧迁移先 commit 进 git,让 deploy-gwbk.sh 对所有库状态一致)。

### Task 1.2:zod schema + 默认值 + Account 判别联合

**Files:**
- Create: `src/features/options.ts`
- Modify: `src/account-pool.ts:1-30`(import + 类型定义);`src/account-pool.ts:280-316`(SELECT 行 → 解码)

- [ ] **Step 1**:写 failing test `tests/features/options.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { AccountOptionsSchema, OAUTH_DEFAULT_OPTIONS, APIKEY_DEFAULT_OPTIONS } from '../../src/features/options.js'

describe('AccountOptionsSchema', () => {
  it('parses OAuth default', () => {
    expect(AccountOptionsSchema.safeParse(OAUTH_DEFAULT_OPTIONS).success).toBe(true)
  })
  it('parses ApiKey default', () => {
    expect(AccountOptionsSchema.safeParse(APIKEY_DEFAULT_OPTIONS).success).toBe(true)
  })
  it('rejects extraHeaders containing authorization', () => {
    const bad = structuredClone(APIKEY_DEFAULT_OPTIONS)
    bad.override.extraHeaders = { authorization: 'evil' }
    expect(AccountOptionsSchema.safeParse(bad).success).toBe(false)
  })
  it('rejects extraHeaders containing x-api-key (case-insensitive)', () => {
    const bad = structuredClone(APIKEY_DEFAULT_OPTIONS)
    bad.override.extraHeaders = { 'X-Api-Key': 'evil' }
    expect(AccountOptionsSchema.safeParse(bad).success).toBe(false)
  })
})
```

- [ ] **Step 2**:运行 `npm test -- tests/features/options.test.ts` 期望 FAIL("Cannot find module").

- [ ] **Step 3**:写 `src/features/options.ts`:

```ts
import { z } from 'zod'

const FORBIDDEN_HEADER_KEYS = new Set([
  'authorization', 'x-api-key', 'host', 'cookie',
  'content-length', 'connection', 'proxy-connection',
  'cdn-loop', 'x-real-ip', 'forwarded',
])

const triState = z.object({
  mode: z.enum(['omit', 'passthrough', 'override']),
  value: z.string().nullable(),
})

const betaState = z.object({
  mode: z.enum(['omit', 'passthrough', 'override', 'append']),
  value: z.string().nullable(),
})

const extraHeaders = z.record(z.string(), z.string()).refine(
  (rec) => Object.keys(rec).every((k) => !FORBIDDEN_HEADER_KEYS.has(k.toLowerCase())),
  { message: 'extraHeaders 禁止包含 authorization / x-api-key / host / cookie 等敏感头' },
)

export const AccountOptionsSchema = z.object({
  validate: z.object({
    body: z.boolean(),
    shape: z.boolean(),
    model: z.boolean(),
    fastMode: z.boolean(),
    requireStream: z.boolean(),
  }),
  clean: z.object({
    ccHeaders: z.boolean(),
    ccBetaFlags: z.boolean(),
    systemText: z.boolean(),
    metadata: z.boolean(),
  }),
  override: z.object({
    userAgent: triState,
    anthropicVersion: triState,
    anthropicBeta: betaState,
    extraHeaders,
  }),
  events: z.object({
    emitTengu: z.boolean(),
  }),
  canonicalCcMessages: z.boolean(),
})

export type AccountOptions = z.infer<typeof AccountOptionsSchema>

export const OAUTH_DEFAULT_OPTIONS: AccountOptions = {
  validate:  { body: true, shape: true, model: true, fastMode: true, requireStream: true },
  clean:     { ccHeaders: false, ccBetaFlags: false, systemText: false, metadata: false },
  override:  {
    userAgent:        { mode: 'omit', value: null },
    anthropicVersion: { mode: 'omit', value: null },
    anthropicBeta:    { mode: 'omit', value: null },
    extraHeaders: {},
  },
  events: { emitTengu: true },
  canonicalCcMessages: true,
}

export const APIKEY_DEFAULT_OPTIONS: AccountOptions = {
  validate:  { body: true, shape: true, model: true, fastMode: true, requireStream: true },
  clean:     { ccHeaders: true, ccBetaFlags: true, systemText: true, metadata: true },
  override:  {
    userAgent:        { mode: 'omit', value: null },
    anthropicVersion: { mode: 'omit', value: null },
    anthropicBeta:    { mode: 'omit', value: null },
    extraHeaders: {},
  },
  events: { emitTengu: false },
  canonicalCcMessages: false,
}

export function decodeOptions(raw: unknown, authKind: 'oauth' | 'api_key'): AccountOptions {
  const parsed = AccountOptionsSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  // 容错:DB row 出错时回退到默认,日志在调用方打
  return authKind === 'oauth' ? OAUTH_DEFAULT_OPTIONS : APIKEY_DEFAULT_OPTIONS
}
```

- [ ] **Step 4**:运行测试 PASS。

```bash
npm test -- tests/features/options.test.ts
```

### Task 1.3:Account 类型改判别联合 + account-pool 读 options

**Files:**
- Modify: `src/account-pool.ts`

- [ ] **Step 1**:把 `OAuthAccount` 单一类型改成判别联合(spec §2 Account 类型片段):

```ts
import { decodeOptions, type AccountOptions } from './features/options.js'

interface AccountCommon {
  id: string
  name: string
  status: string
  accountType: string | null
  weight: number
  models: string[] | null
  // ... 把现 OAuthAccount 里所有 OAuth/ApiKey 都用得到的字段都搬到 AccountCommon
  outboundProxyId: string | null
  identityProfileId: string | null
  ccTemplateId: string | null
  canonicalIdentity: { device_id?: string; account_uuid?: string; email?: string } | null
  organizationUuid: string | null
  accountUuid: string | null
  maxSessions: number
  sessionTtlSeconds: number
  // ...(其余通用字段)
  groupId: string | null
  groupIds: string[]
  authKind: 'oauth' | 'api_key'
  options: AccountOptions
}

export type OAuthAccountVariant = AccountCommon & {
  authKind: 'oauth'
  refreshToken: string
  accessToken: string | null
  expiresAt: number
}

export type ApiKeyAccountVariant = AccountCommon & {
  authKind: 'api_key'
  provider: 'anthropic' | 'openai'
  apiKey: string
  apiBaseUrl: string
}

export type Account = OAuthAccountVariant | ApiKeyAccountVariant
// 兼容老引用名(逐步替换;Phase 4 末删除别名)
export type OAuthAccount = Account
```

- [ ] **Step 2**:把 `SELECT` 列加 `options`(line ~250 附近的 SELECT 语句):

```sql
SELECT id, name, refresh_token, access_token, expires_at, status, account_type,
       max_rpm, max_tpm, max_concurrent, max_sessions, max_daily_req, max_daily_tok,
       max_daily_cost, weight, models, cooldown_seconds, max_retries, session_ttl_seconds,
       canonical_identity, identity_profile_id, outbound_proxy_id,
       deployment, group_id, auth_kind, provider, api_key, api_base_url,
       simulate_fingerprint, cc_template_id,
       organization_uuid, account_uuid,
       options                                          -- ← 新增
  FROM oauth_accounts ...
```

- [ ] **Step 3**:在 `accounts.map(...)` 行级转换里:
  - 删除 `allowNonStream: !!r.allow_non_stream`
  - 删除 `skipShapeValidation: r.skip_shape_validation === true`
  - 删除 `outboundUserAgent: ...`
  - 加上 `options: decodeOptions(r.options, (r.auth_kind ?? 'oauth') as any)`
  - 凭据字段按 authKind 分支:
    ```ts
    if ((r.auth_kind ?? 'oauth') === 'oauth') {
      return { ...common, authKind: 'oauth', refreshToken: r.refresh_token, accessToken: r.access_token, expiresAt: Number(r.expires_at ?? 0) }
    } else {
      return { ...common, authKind: 'api_key', provider: r.provider as any, apiKey: r.api_key, apiBaseUrl: r.api_base_url }
    }
    ```

- [ ] **Step 4**:`tsc --noEmit` 通过(忽略 proxy.ts 等其他文件下游错误,Phase 2-4 会逐步消解)。先打 `// @ts-expect-error TODO Phase X` 在编译失败的行,后续阶段去掉。

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 5**:运行 `tests/account-groups.test.ts` / `tests/cc-disguise.test.ts` 等不依赖 options 的现有测试 PASS。

### Task 1.4:Phase 1 commit

- [ ] **Step 1**:

```bash
git add migrations/028_account_skip_shape_validation.sql migrations/029_account_outbound_user_agent.sql migrations/030_account_options.sql src/features/options.ts src/account-pool.ts tests/features/options.test.ts
git commit -m "$(cat <<'EOF'
feat(schema): 引入 account_options JSONB + Account 判别联合

新增 030 迁移把 allow_non_stream / skip_shape_validation /
outbound_user_agent 三老列合并入单列 options JSONB,默认值由
auth_kind 决定。features/options.ts 提供 zod schema(拒绝
extraHeaders 写敏感头)+ 默认值。account-pool 改读 options。

028/029 一并 commit 入 git(此前未 commit 但已在 gwbk 跑过)。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2:features/ 校验 + 清洗 + 覆盖 抽出

### Task 2.1:Feature 接口 + Phase 顺序

**Files:**
- Create: `src/features/types.ts`

- [ ] **Step 1**:写 `src/features/types.ts`:

```ts
import type { IncomingMessage, ServerResponse, IncomingHttpHeaders } from 'http'
import type { Readable } from 'stream'
import type { Account } from '../account-pool.js'
import type { RequestShape } from '../request-shapes.js'

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
  blockReason: string
  blockSource: 'gw' | 'plan' | 'oauth' | 'api'
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

  // 收尾
  upstreamResponse?: { status: number; headers: IncomingHttpHeaders; body: Readable }
  blockReason?: string
  blockSource?: string
  emitCtx?: any

  resetOutbound(): void
}

// 跨 phase 通用 helper:常用判 path
export function isMessagesPath(ctx: PipelineContext): boolean {
  return ctx.path.startsWith('/v1/messages')
}
export function isCountTokensPath(ctx: PipelineContext): boolean {
  return ctx.path.includes('/count_tokens')
}
export function isMessagesNotCountTokens(ctx: PipelineContext): boolean {
  return isMessagesPath(ctx) && !isCountTokensPath(ctx)
}
```

- [ ] **Step 2**:`npx tsc --noEmit src/features/types.ts` 单文件检查通过。

### Task 2.2:5 个 inbound-validate features

**Files:**
- Create: `src/features/validation/{body-integrity,request-shape,model-allowlist,fast-mode-reject,require-stream}.ts`
- Create: `tests/features/validation/{...}.test.ts`(各 1 个文件)

每个 feature 用同一模板。这里完整给出 `body-integrity` 作为示例,其余按相同结构写。

- [ ] **Step 1**:写 `src/features/validation/body-integrity.ts`:

```ts
import type { Feature, FeatureResult, PipelineContext } from '../types.js'
import { isMessagesNotCountTokens } from '../types.js'
import { validateThinkingParams } from '../../cc-disguise.js'

// 从原 src/proxy.ts 里提取的 bodyValidationError 计算逻辑
function detectBodyIntegrityError(parsedBody: any): string | null {
  if (!parsedBody || typeof parsedBody !== 'object') return null
  const msgs = (parsedBody as any).messages
  if (!Array.isArray(msgs)) return null
  for (const m of msgs) {
    const content = (m as any)?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if ((block as any).type === 'thinking') {
        const sig = (block as any).signature
        if (sig != null && typeof sig !== 'string') {
          return 'Invalid `signature` in `thinking` block'
        }
      }
      if ((block as any).type === 'text') {
        const text = (block as any).text
        if (typeof text === 'string' && text.length === 0) {
          return 'text content blocks must be non-empty'
        }
      }
    }
  }
  // 也跑 validateThinkingParams(沿用原行为)
  return validateThinkingParams(parsedBody)
}

export const bodyIntegrity: Feature = {
  id: 'body-integrity',
  phase: 'inbound-validate',
  appliesTo: isMessagesNotCountTokens,
  run(ctx: PipelineContext): FeatureResult {
    const err = detectBodyIntegrityError(ctx.parsedRequestBody)
    if (err) {
      return { ok: false, status: 400, reason: err,
               blockReason: 'malformed_block', blockSource: 'gw' }
    }
    return { ok: true }
  },
}
```

- [ ] **Step 2**:测试 `tests/features/validation/body-integrity.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { bodyIntegrity } from '../../../src/features/validation/body-integrity.js'
import { makeCtx } from '../../helpers/make-ctx.js'   // helper,Step 5 创建

describe('body-integrity', () => {
  it('passes when messages well-formed', async () => {
    const ctx = makeCtx({ path: '/v1/messages',
      parsedRequestBody: { messages: [{ role: 'user', content: 'hi' }] } })
    expect(await bodyIntegrity.run(ctx)).toEqual({ ok: true })
  })
  it('fails on non-string thinking signature', async () => {
    const ctx = makeCtx({ path: '/v1/messages', parsedRequestBody: {
      messages: [{ role: 'assistant', content: [{ type: 'thinking', signature: 123 }] }],
    }})
    const r = await bodyIntegrity.run(ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.blockReason).toBe('malformed_block')
  })
  it('fails on empty text block', async () => {
    const ctx = makeCtx({ path: '/v1/messages', parsedRequestBody: {
      messages: [{ role: 'user', content: [{ type: 'text', text: '' }] }],
    }})
    const r = await bodyIntegrity.run(ctx)
    expect(r.ok).toBe(false)
  })
  it('skips when path is /v1/messages/count_tokens', async () => {
    const ctx = makeCtx({ path: '/v1/messages/count_tokens', parsedRequestBody: null })
    expect(bodyIntegrity.appliesTo!(ctx)).toBe(false)
  })
})
```

- [ ] **Step 3**:同样模板创建剩余 4 个 feature(代码搬自 proxy.ts):

| feature | proxy.ts 源行(参考) | failure 码 | appliesTo |
|---|---|---|---|
| `validation/request-shape.ts` | 818-826(`validateRequestShape`) | 400 `shape_forbidden` | isMessagesNotCountTokens |
| `validation/model-allowlist.ts` | 831-844(`getUnsupportedModelReason`) | 400 `plan_forbidden_model` | undefined(所有 path) |
| `validation/fast-mode-reject.ts` | 846-858(`requestSpeed === 'fast'`) | 400 `fast_mode_blocked` | undefined |
| `validation/require-stream.ts` | 1015-1031(`!requestIsStream`) | 400 `non_stream_blocked` | isMessagesNotCountTokens |

每个 feature 用 `bodyIntegrity` 同款骨架,把 proxy.ts 对应判定逻辑搬进 `run()`,失败时返回 `{ ok: false, ... }`。

- [ ] **Step 4**:每个 feature 配一个测试文件,至少 3 个 case:正常通过 / 失败码正确 / appliesTo 行为(若有)。

- [ ] **Step 5**:创建测试 helper `tests/helpers/make-ctx.ts`:

```ts
import type { PipelineContext } from '../../src/features/types.js'

export function makeCtx(overrides: Partial<PipelineContext>): PipelineContext {
  const baseHeaders = {} as Record<string, string>
  return {
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
    account: {} as any,
    credential: '',
    outboundHeaders: baseHeaders,
    outboundBody: Buffer.alloc(0),
    parsedOutboundBody: null,
    shapeOut: null,
    derivedSessionId: null,
    forceStripSignatures: false,
    resetOutbound() {},
    ...overrides,
  } as PipelineContext
}
```

- [ ] **Step 6**:运行 `npm test -- tests/features/validation/` 全 PASS。

### Task 2.3:4 个 outbound-clean features

**Files:**
- Create: `src/features/outbound-clean/{strip-cc-headers,strip-cc-beta-flags,sanitize-system-text,drop-metadata}.ts`
- Create: `tests/features/outbound-clean/{...}.test.ts`

- [ ] **Step 1**:`src/features/outbound-clean/strip-cc-headers.ts`(从 proxy.ts:1080-1095 搬):

```ts
import type { Feature, PipelineContext } from '../types.js'

const FORWARD_DROP_PREFIXES = ['x-claude-code-', 'x-stainless-', 'cf-', 'x-forwarded-', 'cdn-']
const FORWARD_DROP_EXACT = new Set([
  'authorization', 'x-api-key', 'host', 'content-length', 'connection',
  'proxy-connection', 'accept-encoding', 'cdn-loop', 'x-real-ip', 'forwarded',
  'cookie', 'x-app',
  // 注意:不删 user-agent 这里,user-agent 由 outbound-override/user-agent feature 决定
])

export const stripCcHeaders: Feature = {
  id: 'strip-cc-headers',
  phase: 'outbound-clean',
  run(ctx: PipelineContext) {
    for (const k of Object.keys(ctx.outboundHeaders)) {
      const lower = k.toLowerCase()
      if (FORWARD_DROP_EXACT.has(lower) || FORWARD_DROP_PREFIXES.some(p => lower.startsWith(p))) {
        delete ctx.outboundHeaders[k]
      }
    }
    return { ok: true }
  },
}
```

> 注意:`user-agent` 不在硬清单内,因为 user-agent 三态由 `outbound-override/user-agent` 处理。这跟原 `API_KEY_FORWARD_DROP_EXACT` 包含 `user-agent` 不同,**但等价行为由覆盖 feature 配合默认 mode='omit' 达成**。

- [ ] **Step 2**:`src/features/outbound-clean/strip-cc-beta-flags.ts`(从 proxy.ts:1097-1109 搬 `stripCCBetaFlags`):

```ts
import type { Feature, PipelineContext } from '../types.js'

const CC_ONLY_BETA_FLAG_PREFIXES = ['claude-code-']

export const stripCcBetaFlags: Feature = {
  id: 'strip-cc-beta-flags',
  phase: 'outbound-clean',
  run(ctx: PipelineContext) {
    const beta = ctx.outboundHeaders['anthropic-beta']
    if (!beta) return { ok: true }
    const stripped = beta.split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !CC_ONLY_BETA_FLAG_PREFIXES.some(p => s.startsWith(p)))
      .join(',')
    if (stripped) ctx.outboundHeaders['anthropic-beta'] = stripped
    else delete ctx.outboundHeaders['anthropic-beta']
    return { ok: true }
  },
}
```

- [ ] **Step 3**:`src/features/outbound-clean/sanitize-system-text.ts`(从 proxy.ts:1100-1152 搬 `sanitizeApiKeyRequestBody`/`stripApiKeySystemText`):

```ts
import type { Feature, PipelineContext } from '../types.js'

const BILLING_HEADER_RE = /^\s*x-anthropic-billing-header:[^\n]*(?:\n|$)/gm
const CC_INTRO_RE = /^\s*You are Claude Code, Anthropic's official CLI for Claude\.\s*(?:\n|$)/gm

function strip(text: string): string {
  return text.replace(BILLING_HEADER_RE, '').replace(CC_INTRO_RE, '').trim()
}

function recurse(value: unknown): unknown {
  if (typeof value === 'string') {
    const s = strip(value)
    return s.length > 0 ? s : undefined
  }
  if (Array.isArray(value)) {
    return value.map(recurse).filter(v => v !== undefined)
  }
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'metadata') continue   // 同时移除 metadata,旧 sanitizeApiKeyBodyValue 行为一致
    const next = recurse(v)
    if (next !== undefined) out[k] = next
  }
  return out
}

export const sanitizeSystemText: Feature = {
  id: 'sanitize-system-text',
  phase: 'outbound-clean',
  run(ctx: PipelineContext) {
    if (!ctx.parsedOutboundBody) return { ok: true }
    const sanitized = recurse(ctx.parsedOutboundBody)
    if (sanitized === undefined) return { ok: true }
    ctx.parsedOutboundBody = sanitized
    ctx.outboundBody = Buffer.from(JSON.stringify(sanitized), 'utf-8')
    return { ok: true }
  },
}
```

> 注意:为了避免双重移除 metadata,`drop-metadata` feature 写得幂等(若已无则 no-op)。

- [ ] **Step 4**:`src/features/outbound-clean/drop-metadata.ts`:

```ts
import type { Feature, PipelineContext } from '../types.js'

export const dropMetadata: Feature = {
  id: 'drop-metadata',
  phase: 'outbound-clean',
  run(ctx: PipelineContext) {
    if (!ctx.parsedOutboundBody || typeof ctx.parsedOutboundBody !== 'object') return { ok: true }
    if (!('metadata' in ctx.parsedOutboundBody)) return { ok: true }
    const next = { ...ctx.parsedOutboundBody }
    delete (next as any).metadata
    ctx.parsedOutboundBody = next
    ctx.outboundBody = Buffer.from(JSON.stringify(next), 'utf-8')
    return { ok: true }
  },
}
```

- [ ] **Step 5**:测试每个 feature(`tests/features/outbound-clean/*.test.ts`),用 `makeCtx({ outboundHeaders: ..., parsedOutboundBody: ... })` 喂入,断言 ctx 改写后符合预期。

- [ ] **Step 6**:运行 `npm test -- tests/features/outbound-clean/` 全 PASS。

### Task 2.4:4 个 outbound-override features

**Files:**
- Create: `src/features/outbound-override/{user-agent,anthropic-version,anthropic-beta,extra-headers}.ts`
- Create: `tests/features/outbound-override/*.test.ts`

- [ ] **Step 1**:`src/features/outbound-override/user-agent.ts`:

```ts
import type { Feature, PipelineContext } from '../types.js'
import type { AccountOptions } from '../options.js'

type Cfg = AccountOptions['override']['userAgent']

export function userAgent(cfg: Cfg): Feature {
  return {
    id: 'user-agent',
    phase: 'outbound-override',
    run(ctx: PipelineContext) {
      if (cfg.mode === 'omit') {
        delete ctx.outboundHeaders['user-agent']
      } else if (cfg.mode === 'passthrough') {
        const ua = ctx.requestHeadersIn['user-agent']
        if (Array.isArray(ua)) ctx.outboundHeaders['user-agent'] = ua[0] ?? ''
        else if (typeof ua === 'string') ctx.outboundHeaders['user-agent'] = ua
      } else if (cfg.mode === 'override' && cfg.value) {
        ctx.outboundHeaders['user-agent'] = cfg.value
      }
      return { ok: true }
    },
  }
}
```

- [ ] **Step 2**:`anthropic-version.ts` 同结构(只是 header key 不同),只支持 `omit / passthrough / override`(无 append)。

- [ ] **Step 3**:`anthropic-beta.ts` 加 `append` 模式:

```ts
} else if (cfg.mode === 'append' && cfg.value) {
  const exist = ctx.outboundHeaders['anthropic-beta']
  ctx.outboundHeaders['anthropic-beta'] = exist ? `${exist},${cfg.value}` : cfg.value
}
```

- [ ] **Step 4**:`extra-headers.ts`:

```ts
import type { Feature, PipelineContext } from '../types.js'

export function extraHeaders(map: Record<string, string>): Feature {
  return {
    id: 'extra-headers',
    phase: 'outbound-override',
    run(ctx: PipelineContext) {
      for (const [k, v] of Object.entries(map)) {
        ctx.outboundHeaders[k.toLowerCase()] = v
      }
      return { ok: true }
    },
  }
}
```

> 安全名单已在 zod schema 兜底(无法写入 DB),这里直接信任。

- [ ] **Step 5**:测试每个 feature(三态/四态各覆盖 + 默认值)。

- [ ] **Step 6**:运行 `npm test -- tests/features/outbound-override/` 全 PASS。

### Task 2.5:`features/build.ts` 装配

**Files:**
- Create: `src/features/build.ts`
- Create: `tests/features/build.test.ts`

- [ ] **Step 1**:写测试断言装配数:

```ts
import { describe, it, expect } from 'vitest'
import { buildFeatures } from '../../src/features/build.js'
import { OAUTH_DEFAULT_OPTIONS, APIKEY_DEFAULT_OPTIONS } from '../../src/features/options.js'

const oauth = { authKind: 'oauth', options: OAUTH_DEFAULT_OPTIONS } as any
const api   = { authKind: 'api_key', options: APIKEY_DEFAULT_OPTIONS } as any

describe('buildFeatures', () => {
  it('OAuth 默认 → 5 校验 + 3 cc-canonical + 0 清洗 + 4 覆盖 = 12', () => {
    const f = buildFeatures(oauth)
    expect(f.length).toBe(12)
    expect(f.find(x => x.id === 'cc-build-headers')).toBeDefined()
    expect(f.find(x => x.id === 'strip-cc-headers')).toBeUndefined()
  })
  it('ApiKey 默认 → 5 + 0 cc + 4 + 4 = 13', () => {
    const f = buildFeatures(api)
    expect(f.length).toBe(13)
    expect(f.find(x => x.id === 'cc-build-headers')).toBeUndefined()
    expect(f.find(x => x.id === 'strip-cc-headers')).toBeDefined()
  })
  it('phase 顺序:inbound-validate 全部排在 outbound-canonical 之前', () => {
    const f = buildFeatures(oauth)
    const phases = f.map(x => x.phase)
    const lastVal = phases.lastIndexOf('inbound-validate')
    const firstCan = phases.indexOf('outbound-canonical')
    expect(lastVal).toBeLessThan(firstCan)
  })
})
```

> 注意:cc-canonical 的 3 个 feature 在 Phase 3 才会创建。这一步先用占位 stub(导出空对象),Phase 3 完成后测试再启用。或者把这条 `it()` 标 `it.todo`,Phase 3 完成后改成 `it`。

- [ ] **Step 2**:写 `src/features/build.ts`:

```ts
import type { Feature } from './types.js'
import type { Account } from '../account-pool.js'
import { bodyIntegrity } from './validation/body-integrity.js'
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
// Phase 3 引入:
// import { ccBuildHeaders } from './cc-canonical/build-headers.js'
// import { ccRewriteMessagesBody } from './cc-canonical/rewrite-messages-body.js'
// import { ccSessionBinding } from './cc-canonical/session-binding.js'

export function buildFeatures(account: Account): Feature[] {
  const o = account.options
  const f: Feature[] = []

  if (o.validate.body)          f.push(bodyIntegrity)
  if (o.validate.shape)         f.push(requestShape)
  if (o.validate.model)         f.push(modelAllowlist)
  if (o.validate.fastMode)      f.push(fastModeReject)
  if (o.validate.requireStream) f.push(requireStream)

  // Phase 3 完成后启用:
  // if (o.canonicalCcMessages) f.push(ccBuildHeaders, ccRewriteMessagesBody, ccSessionBinding)

  if (o.clean.ccHeaders)    f.push(stripCcHeaders)
  if (o.clean.ccBetaFlags)  f.push(stripCcBetaFlags)
  if (o.clean.systemText)   f.push(sanitizeSystemText)
  if (o.clean.metadata)     f.push(dropMetadata)

  f.push(userAgent(o.override.userAgent))
  f.push(anthropicVersion(o.override.anthropicVersion))
  f.push(anthropicBeta(o.override.anthropicBeta))
  f.push(extraHeaders(o.override.extraHeaders))

  return f
}
```

- [ ] **Step 3**:运行 build.test.ts 全 PASS(注意此阶段 OAuth 装配数是 9 而不是 12,phase 3 完成后改回 12)。临时把 OAuth 期望值改 9,加 `// FIXME phase 3 → 12`。

### Task 2.6:Phase 2 commit

- [ ] **Step 1**:

```bash
git add src/features/types.ts src/features/build.ts src/features/validation src/features/outbound-clean src/features/outbound-override tests/features/ tests/helpers/
git commit -m "$(cat <<'EOF'
refactor(features): 抽出 5 个 inbound-validate + 4 个 outbound-clean + 4 个 outbound-override

每个 feature 是单一实现,phase 接口 + appliesTo 跳过机制。
proxy.ts 暂未切换调用,行为零变化。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3:cc-canonical 包装 + NoTemplateBoundError 删除

### Task 3.1:`features/cc-canonical/build-headers.ts`(吸收 NoTemplateBoundError)

**Files:**
- Create: `src/features/cc-canonical/build-headers.ts`
- Modify: `src/cc-disguise.ts`(删 NoTemplateBoundError 类)
- Create: `tests/features/cc-canonical/build-headers.test.ts`

- [ ] **Step 1**:测试:

```ts
import { describe, it, expect } from 'vitest'
import { ccBuildHeaders } from '../../../src/features/cc-canonical/build-headers.js'
import { makeCtx } from '../../helpers/make-ctx.js'

describe('cc-build-headers', () => {
  it('账号无 ccTemplateId → 503 no_cc_template', async () => {
    const ctx = makeCtx({
      account: { authKind: 'oauth', ccTemplateId: null, options: { canonicalCcMessages: true } } as any,
      path: '/v1/messages',
    })
    const r = await ccBuildHeaders.run(ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(503)
      expect(r.blockReason).toBe('no_cc_template')
    }
  })
  // 正常构建 headers 的 case:依赖 buildCCHeaders,集成测试覆盖
})
```

- [ ] **Step 2**:写 `src/features/cc-canonical/build-headers.ts`:

```ts
import type { Feature, PipelineContext } from '../types.js'
import { isMessagesNotCountTokens } from '../types.js'
import { buildCCHeaders, buildEffectiveProfile } from '../../rewriter.js'

export const ccBuildHeaders: Feature = {
  id: 'cc-build-headers',
  phase: 'outbound-canonical',
  appliesTo: isMessagesNotCountTokens,
  async run(ctx: PipelineContext) {
    if (!ctx.account.ccTemplateId) {
      return {
        ok: false, status: 503,
        reason: `account ${ctx.account.id} has no cc_template_id bound`,
        blockReason: 'no_cc_template', blockSource: 'gw',
      }
    }
    const profile = buildEffectiveProfile(ctx.account, null)
    if (!profile) return { ok: true }   // 兼容老路径

    // 调用现 buildCCHeaders,把生成的头合并到 outboundHeaders
    const ccHeaders = await buildCCHeaders({
      account: ctx.account,
      profile,
      derivedSessionId: ctx.derivedSessionId ?? '',
      inboundHeaders: ctx.requestHeadersIn,
      // 其他原 RewriteOptions 字段
    } as any)
    Object.assign(ctx.outboundHeaders, ccHeaders)
    return { ok: true }
  },
}
```

> 备注:`buildCCHeaders` 当前签名跟新 `PipelineContext` 不完全对齐,具体参数适配在 Phase 4 的 retry/handle 整合时统一处理。这一步只要测试 `ccTemplateId==null → 503` PASS,集成由 Phase 4 验证。

- [ ] **Step 3**:`src/cc-disguise.ts`:删除 `NoTemplateBoundError` 类(行 65-72)+ 删除所有 `throw new NoTemplateBoundError(...)`(改成在调用方 return 或转换)。

```bash
# 找出所有引用,确认无遗漏
grep -rn "NoTemplateBoundError" src/ server/src/ tests/
```

逐个改成:`if (!templateId) return null` 或类似不抛异常的形式。proxy.ts 里旧的 catch 分支(line 1503)留给 Phase 4 删。

- [ ] **Step 4**:运行 `npm test -- tests/features/cc-canonical/build-headers.test.ts` PASS。

### Task 3.2:`rewrite-messages-body.ts`(吸收 NonCCRequestError + forceStripSignatures)

**Files:**
- Create: `src/features/cc-canonical/rewrite-messages-body.ts`
- Create: `tests/features/cc-canonical/rewrite-messages-body.test.ts`

- [ ] **Step 1**:测试:

```ts
describe('cc-rewrite-messages-body', () => {
  it('NonCCRequestError → 400 non_cc_request', async () => {
    // 构造一个 ctx 让 rewriteMessagesBody 内部 throw NonCCRequestError
    // (例如 tools 缺 baseline)
    const ctx = makeCtx({ /* ... */ })
    const r = await ccRewriteMessagesBody.run(ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.blockReason).toBe('non_cc_request')
  })
  it('ctx.forceStripSignatures=true → 覆盖 redis 查询', async () => {
    const ctx = makeCtx({ forceStripSignatures: true })
    // 断言 rewriteMessagesBody 被调用时 stripSignatureBlocks=true
    // 用 vi.mock() 替换 rewriter
  })
})
```

- [ ] **Step 2**:`src/features/cc-canonical/rewrite-messages-body.ts`:

```ts
import type { Feature, PipelineContext } from '../types.js'
import { isMessagesNotCountTokens } from '../types.js'
import { rewriteMessagesBody } from '../../rewriter.js'
import { NonCCRequestError } from '../../cc-disguise.js'
import { shouldStripSignatureBlocksForContext } from '../../signature-context.js'

export const ccRewriteMessagesBody: Feature = {
  id: 'cc-rewrite-messages-body',
  phase: 'outbound-canonical',
  appliesTo: isMessagesNotCountTokens,
  async run(ctx: PipelineContext) {
    let stripSig = ctx.forceStripSignatures
    if (!stripSig) {
      stripSig = await shouldStripSignatureBlocksForContext(
        ctx.sessionKey, ctx.account.id, ctx.requestModel,
      )
    }
    try {
      const result = await rewriteMessagesBody(ctx.outboundBody, ctx.path, /* config */ {} as any, {
        // ...原 RewriteOptions 字段,从 ctx 装
        stripSignatureBlocks: stripSig,
      } as any)
      ctx.outboundBody = result
      try { ctx.parsedOutboundBody = JSON.parse(result.toString('utf-8')) } catch {}
      return { ok: true }
    } catch (err) {
      if (err instanceof NonCCRequestError) {
        return { ok: false, status: 400, reason: 'non-cc request',
                 blockReason: 'non_cc_request', blockSource: 'gw' }
      }
      throw err
    }
  },
}
```

- [ ] **Step 3**:测试 PASS。

### Task 3.3:`session-binding.ts`

**Files:**
- Create: `src/features/cc-canonical/session-binding.ts`
- Create: `tests/features/cc-canonical/session-binding.test.ts`

- [ ] **Step 1**:`src/features/cc-canonical/session-binding.ts`:

```ts
import type { Feature, PipelineContext } from '../types.js'
import { isMessagesNotCountTokens } from '../types.js'
import { getOrAssignSession } from '../../session-slots.js'
import { deriveFallbackSessionId } from '../../rewriter.js'

export const ccSessionBinding: Feature = {
  id: 'cc-session-binding',
  phase: 'outbound-canonical',
  appliesTo: isMessagesNotCountTokens,
  run(ctx: PipelineContext) {
    const id = getOrAssignSession(
      ctx.account.id, ctx.sessionKey, ctx.clientName,
      ctx.account.maxSessions ?? 0,
    ) || deriveFallbackSessionId(ctx.account.canonicalIdentity?.account_uuid ?? ctx.account.id)
    ctx.derivedSessionId = id
    return { ok: true }
  },
}
```

- [ ] **Step 2**:测试 PASS。

### Task 3.4:启用 Phase 2 留的 buildFeatures 注释

**Files:**
- Modify: `src/features/build.ts`
- Modify: `tests/features/build.test.ts`(把 OAuth 期望从 9 改回 12)

- [ ] **Step 1**:取消 build.ts 三个 cc-canonical import + push 注释。

- [ ] **Step 2**:tests/features/build.test.ts 把 `// FIXME phase 3 → 12` 改回 `expect(f.length).toBe(12)`,删掉 `it.todo`。

- [ ] **Step 3**:全测试 PASS。

```bash
npm test -- tests/features/
```

### Task 3.5:Phase 3 commit

```bash
git add src/features/cc-canonical src/features/build.ts src/cc-disguise.ts tests/features/cc-canonical tests/features/build.test.ts
git commit -m "$(cat <<'EOF'
refactor(features): cc-canonical 三 feature 包装 + 吸收 NoTemplateBoundError

cc-build-headers 入口先查 ccTemplateId,缺即返回 503;原
NoTemplateBoundError 类删除。cc-rewrite-messages-body 内部
catch NonCCRequestError 转 ok:false。cc-session-binding 包装
getOrAssignSession + 写 ctx.derivedSessionId。
buildFeatures 装配启用 cc-canonical 分支。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4:pipeline 装配 + proxy.ts 切换 + rewriter.ts 删除

### Task 4.1:`pipeline/context.ts` + `pipeline/runner.ts`

**Files:**
- Create: `src/pipeline/context.ts`
- Create: `src/pipeline/runner.ts`
- Create: `tests/pipeline/runner.test.ts`

- [ ] **Step 1**:`src/pipeline/runner.ts`:

```ts
import type { Feature, FeatureResult, PipelineContext } from '../features/types.js'

export async function run(features: Feature[], ctx: PipelineContext): Promise<FeatureResult> {
  for (const f of features) {
    if (f.appliesTo && !f.appliesTo(ctx)) continue
    const r = await f.run(ctx)
    if (!r.ok) {
      ctx.blockReason = r.blockReason
      ctx.blockSource = r.blockSource
      return r
    }
  }
  return { ok: true }
}
```

- [ ] **Step 2**:`src/pipeline/context.ts`:导出 `createPipelineContext(req, res, body, parsed, ...)` 工厂,初始化 outboundHeaders/Body 为入站浅拷贝,实现 `resetOutbound()`:

```ts
export function createPipelineContext(input: Omit<PipelineContext, 'resetOutbound' | 'outboundHeaders' | 'outboundBody' | 'parsedOutboundBody' | 'shapeOut' | 'derivedSessionId' | 'forceStripSignatures'>): PipelineContext {
  const ctx: PipelineContext = {
    ...input,
    outboundHeaders: shallowCopyHeaders(input.requestHeadersIn),
    outboundBody: input.requestBodyIn,
    parsedOutboundBody: input.parsedRequestBody,
    shapeOut: null,
    derivedSessionId: null,
    forceStripSignatures: false,
    resetOutbound() {
      this.outboundHeaders = shallowCopyHeaders(this.requestHeadersIn)
      this.outboundBody = this.requestBodyIn
      this.parsedOutboundBody = this.parsedRequestBody
      this.shapeOut = null
      this.derivedSessionId = null
      // forceStripSignatures 由 retry 路径决定,不在此处重置
    },
  } as PipelineContext
  return ctx
}

function shallowCopyHeaders(src: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v
  }
  return out
}
```

- [ ] **Step 3**:测试 `tests/pipeline/runner.test.ts`:

```ts
describe('runner', () => {
  it('短路:第二个 feature 失败,第三个不被调用', async () => {
    const calls: string[] = []
    const f1 = { id: 'a', phase: 'inbound-validate' as const, run: () => { calls.push('a'); return { ok: true } as const } }
    const f2 = { id: 'b', phase: 'inbound-validate' as const, run: () => { calls.push('b'); return { ok: false, status: 400, reason: 'x', blockReason: 'y', blockSource: 'gw' as const } } }
    const f3 = { id: 'c', phase: 'inbound-validate' as const, run: () => { calls.push('c'); return { ok: true } as const } }
    const ctx = makeCtx({})
    const r = await run([f1, f2, f3], ctx)
    expect(r.ok).toBe(false)
    expect(calls).toEqual(['a', 'b'])
    expect(ctx.blockReason).toBe('y')
  })
  it('appliesTo=false 跳过', async () => {
    const calls: string[] = []
    const f = { id: 'x', phase: 'inbound-validate' as const,
                appliesTo: () => false,
                run: () => { calls.push('x'); return { ok: true } as const } }
    const ctx = makeCtx({})
    const r = await run([f], ctx)
    expect(r.ok).toBe(true)
    expect(calls).toEqual([])
  })
})
```

- [ ] **Step 4**:测试 PASS。

### Task 4.2:`pipeline/handle.ts` + 两个 forward.ts

**Files:**
- Create: `src/pipeline/handle.ts`
- Create: `src/oauth/forward.ts`
- Create: `src/apikey/forward.ts`
- Create: `tests/pipeline/handle.test.ts`

- [ ] **Step 1**:`src/oauth/forward.ts`:

```ts
import type { PipelineContext } from '../features/types.js'
import { upstreamFromConfig, doFetch } from '../forward-shared.js'  // 把现 forwardToUpstream 内的 fetch 部分抽出共享

export async function send(ctx: PipelineContext): Promise<void> {
  ctx.outboundHeaders['authorization'] = `Bearer ${ctx.credential}`
  const target = upstreamFromConfig(ctx.path)   // 全局 anthropic upstream + path
  await doFetch(ctx, target)
}
```

- [ ] **Step 2**:`src/apikey/forward.ts`:

```ts
import type { PipelineContext } from '../features/types.js'
import type { ApiKeyAccountVariant } from '../account-pool.js'
import { doFetch } from '../forward-shared.js'

export async function send(ctx: PipelineContext): Promise<void> {
  const acct = ctx.account as ApiKeyAccountVariant
  if (acct.provider === 'anthropic') {
    ctx.outboundHeaders['x-api-key'] = ctx.credential
    if (!ctx.outboundHeaders['anthropic-version']) {
      ctx.outboundHeaders['anthropic-version'] = '2023-06-01'
    }
  } else {
    ctx.outboundHeaders['authorization'] = `Bearer ${ctx.credential}`
  }
  const target = new URL(ctx.path, acct.apiBaseUrl).toString()
  await doFetch(ctx, target)
}
```

- [ ] **Step 3**:`src/forward-shared.ts`:把现 proxy.ts:1379-2100 里 fetch + 流式响应 + retry decision 的核心部分抽出。`doFetch(ctx, target)` 返回 `RetryDecision = 'ok' | 'retry-different-account' | 'retry-strip-signatures' | 'fatal'`。

> 这一步是体力活,注意把 proxyRes 流处理、metering、错误日志、event_emitter 调用都搬过来。`event_emitter` 调用在 Phase 5 才迁移到 logging.ts,**此 task 暂保留 proxy.ts 直接调**。

- [ ] **Step 4**:`src/pipeline/handle.ts`:

```ts
import * as oauthForward from '../oauth/forward.js'
import * as apikeyForward from '../apikey/forward.js'
import { buildFeatures } from '../features/build.js'
import { run as runFeatures } from './runner.js'
import type { PipelineContext } from '../features/types.js'

export async function handle(ctx: PipelineContext): Promise<void> {
  const features = buildFeatures(ctx.account)
  const result = await runFeatures(features, ctx)
  if (!result.ok) {
    ctx.res.writeHead(result.status, { 'Content-Type': 'application/json' })
    ctx.res.end(JSON.stringify({ type: 'error',
      error: { type: 'invalid_request_error', message: result.reason } }))
    return
  }
  const forward = ctx.account.authKind === 'oauth' ? oauthForward : apikeyForward
  await forward.send(ctx)
}
```

- [ ] **Step 5**:集成测试 `tests/pipeline/handle.test.ts`:

```ts
describe('pipeline.handle', () => {
  it('OAuth 默认 → cc-canonical 改写后 forward 写 Bearer', async () => {
    // mock forward / event_emitter,断言 outboundHeaders.authorization 以 Bearer 开头
  })
  it('ApiKey + provider=anthropic 默认 → outboundHeaders.x-api-key 写入', async () => {
    // ...
  })
  it('ApiKey 关全部校验 → /v1/messages 任意 body 不被拦截', async () => {
    // ...
  })
})
```

- [ ] **Step 6**:测试 PASS。

### Task 4.3:`pipeline/retry.ts`(429/503 + signature retry)

**Files:**
- Create: `src/pipeline/retry.ts`
- Create: `tests/pipeline/retry.test.ts`

- [ ] **Step 1**:`src/pipeline/retry.ts`:

```ts
import type { PipelineContext } from '../features/types.js'

export type RetryDecision = 'ok' | 'retry-different-account' | 'retry-strip-signatures' | 'fatal'

export async function runWithRetry(
  maxRetries: number, ctx: PipelineContext,
  reselectAccount: (ctx: PipelineContext) => Promise<void>,
  attempt: () => Promise<RetryDecision>,
): Promise<void> {
  for (let i = 0; i <= maxRetries; i++) {
    const d = await attempt()
    if (d === 'ok' || d === 'fatal') return
    if (d === 'retry-different-account') {
      await reselectAccount(ctx)
      ctx.resetOutbound()
      continue
    }
    if (d === 'retry-strip-signatures') {
      ctx.forceStripSignatures = true
      ctx.resetOutbound()
      continue
    }
  }
}
```

- [ ] **Step 2**:测试 `tests/pipeline/retry.test.ts`(覆盖三个 case):

```ts
describe('runWithRetry', () => {
  it('429 → reselect + reset + 重 attempt', async () => {
    let calls = 0
    const ctx = makeCtx({})
    const resetSpy = vi.spyOn(ctx, 'resetOutbound')
    const resel = vi.fn(async () => {})
    await runWithRetry(2, ctx, resel, async () => {
      calls++
      return calls < 2 ? 'retry-different-account' : 'ok'
    })
    expect(calls).toBe(2)
    expect(resel).toHaveBeenCalledOnce()
    expect(resetSpy).toHaveBeenCalledOnce()
  })
  it('signature retry → forceStripSignatures=true', async () => {
    const ctx = makeCtx({})
    let calls = 0
    await runWithRetry(2, ctx, async () => {}, async () => {
      calls++
      return calls < 2 ? 'retry-strip-signatures' : 'ok'
    })
    expect(ctx.forceStripSignatures).toBe(true)
  })
  it('多次 retry headers 不重复 strip', async () => {
    const ctx = makeCtx({ outboundHeaders: { 'x-claude-code-foo': 'a' } })
    // 模拟 attempt 内部跑 strip-cc-headers 两次,每次重置后 outboundHeaders 是入站快照
    // 详细见集成层
  })
})
```

- [ ] **Step 3**:测试 PASS。

### Task 4.4:proxy.ts 切换到 pipeline.handle

**Files:**
- Modify: `src/proxy.ts`(瘦身从 ~1700 → ~250)

> 这一步是最有风险的一步。**强烈建议:开新 branch,跑全套现有测试 + gwbk smoke 后再 merge**。

- [ ] **Step 1**:在 proxy.ts 顶部加 import:

```ts
import { createPipelineContext } from './pipeline/context.js'
import { handle as pipelineHandle } from './pipeline/handle.js'
import { runWithRetry } from './pipeline/retry.js'
```

- [ ] **Step 2**:把 proxy.ts 主入口函数(line 700+ 的 `handleRequest` 或类似名)的核心改写流程替换为:

```ts
const ctx = createPipelineContext({
  req, res, method, path, clientName, clientId, clientIp,
  traceId, operationId: rootOperationId, rootTraceId: operationRootTraceId ?? traceId,
  parentTraceId: operationParentTraceId,
  requestHeadersIn: req.headers, requestBodyIn: body,
  parsedRequestBody, requestModel, requestSpeed, requestIsStream,
  bodyUserId, sessionKey: rootSessionKey, shapeIn: rootShapeIn,
  account: selectedAccount.account, credential: oauthToken,
})

const maxRetries = effectiveForcedAccountId ? 0 : (selectedAccount?.account.maxRetries ?? 0)
await runWithRetry(maxRetries, ctx,
  async (c) => { /* reselect:沿用现 selectAccount,改 c.account / c.credential */ },
  async () => pipelineHandle(ctx),  // 内部决定 RetryDecision(forward 写到 ctx.upstreamResponse)
)
```

- [ ] **Step 3**:删除 proxy.ts 内已搬到 features 的旧函数:
  - `applyRewrite`(line 1209-1377)
  - `buildDirectApiKeyRewrite`(1154-1201)
  - `sanitizeApiKeyRequestBody` / `sanitizeApiKeyBodyValue`(1118-1152)
  - `stripCCBetaFlags` / `stripApiKeySystemText` / 相关常量
  - `forwardToUpstream`(1379-2100)— 这部分在 `forward-shared.ts` 已抽出
  - 入站校验那段 if/else(976-1031,已被 features 替代)
- [ ] **Step 4**:删除 proxy.ts 顶部已不再使用的 import(`buildCCHeaders`, `rewriteMessagesBody` 等)。

- [ ] **Step 5**:`tsc --noEmit` 干净通过(之前 Phase 1 加的 `// @ts-expect-error` 此时应可移除)。

- [ ] **Step 6**:运行**全套**现有测试,确认 PASS:

```bash
npm test
cd server && npm test
cd ../web && npm run build
```

### Task 4.5:删除 `src/rewriter.ts` 残余 + 共享函数搬位

**Files:**
- Modify: `src/rewriter.ts`(删除已迁移的函数,只留 cc-canonical 三个 feature 还没迁完的纯函数 helper;最终删整个文件)
- Modify: `src/features/cc-canonical/build-headers.ts`(改为直接 import `buildCCHeaders` from `../../rewriter.js` → 改 import `from '../cc-canonical-impl.js'` 或类似新位置)

- [ ] **Step 1**:把 `src/rewriter.ts` 内 `buildCCHeaders` / `rewriteMessagesBody` / `buildEffectiveProfile` / `deriveFallbackSessionId` 全部搬到 `src/features/cc-canonical/_impl.ts`(私有实现,不导出 feature)。

- [ ] **Step 2**:`build-headers.ts` / `rewrite-messages-body.ts` / `session-binding.ts` 改 import 指向 `_impl.ts`。

- [ ] **Step 3**:`grep -rn "from.*rewriter" src/ tests/` 清零后 `rm src/rewriter.ts`。

- [ ] **Step 4**:全测试 PASS。

### Task 4.6:删除 src/proxy.ts 里 `__emitCtx` / `__emitHints` monkey-patch

**Files:**
- Modify: `src/proxy.ts`

- [ ] **Step 1**:把 `(req as any).__emitCtx = emitCtx`、`(req as any).__emitHints = ...`、对应 `(req as any).__emitCtx ?? null` 读取的代码,改为通过 `ctx.emitCtx` 读写。

- [ ] **Step 2**:`grep "__emit" src/` 清零。

### Task 4.7:Phase 4 commit

```bash
git add src/pipeline src/oauth src/apikey src/forward-shared.ts src/proxy.ts src/rewriter.ts src/features/cc-canonical tests/pipeline tests/features/cc-canonical
git rm src/rewriter.ts
git commit -m "$(cat <<'EOF'
refactor(pipeline): proxy.ts 切到 pipeline.handle,rewriter.ts 删除

引入 pipeline/{context,runner,handle,retry}.ts 共享调度,oauth/
forward.ts 与 apikey/forward.ts 物理分叉(凭据头 + 上游 URL)。
proxy.ts 从 ~1700 行瘦身到 ~250 行,主流程仅:接入/选号/调度/收尾。
rewriter.ts 内函数搬到 features/cc-canonical/_impl.ts 后整文件删除。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5:logging.ts hooks(event_emitter 调用迁移)

### Task 5.1:`pipeline/logging.ts`

**Files:**
- Create: `src/pipeline/logging.ts`
- Create: `tests/pipeline/logging.test.ts`

- [ ] **Step 1**:`src/pipeline/logging.ts`:

```ts
import type { PipelineContext } from '../features/types.js'
import { insertRequestLog, updateRequestLog } from '../request-logger.js'
import { emitSessionInit, emitApiQuery, emitApiSuccess } from '../event-emitter.js'
import { recordBilling } from '../billing.js'   // 若已存在

export async function onRequestStart(ctx: PipelineContext): Promise<void> {
  await insertRequestLog({ /* ctx → fields */ } as any)
  if (ctx.account.options.events.emitTengu && ctx.account.authKind === 'oauth') {
    const acct = ctx.account
    const stainlessOs = (ctx.requestHeadersIn['x-stainless-os'] as string) || 'MacOS'
    const clientVersion = (ctx.requestHeadersIn['x-stainless-package-version'] as string) || '2.1.112'
    const sessId = ctx.derivedSessionId ?? ''
    if (sessId) {
      emitSessionInit(acct.id, sessId, ctx.credential, acct.outboundProxyId,
        acct.canonicalIdentity?.device_id || '',
        acct.canonicalIdentity?.account_uuid || '',
        acct.canonicalIdentity?.email || '',
        acct.organizationUuid || '',
        clientVersion, stainlessOs,
        { operationId: ctx.operationId, rootTraceId: ctx.rootTraceId,
          parentTraceId: ctx.parentTraceId, sessionKey: ctx.sessionKey })
    }
    const emitCtx = { /* ... 沿用现 emitCtx 结构 */ }
    emitApiQuery(emitCtx, { /* hints */ })
    ctx.emitCtx = emitCtx
  }
}

export async function onResponseEnd(ctx: PipelineContext, usage: any, reqId?: string): Promise<void> {
  await updateRequestLog({ /* ctx → fields */ } as any)
  await recordBilling(ctx, usage).catch(() => {})
  if (ctx.emitCtx && ctx.account.options.events.emitTengu && ctx.account.authKind === 'oauth') {
    emitApiSuccess(ctx.emitCtx, { ...usage, requestId: reqId })
  }
}
```

- [ ] **Step 2**:测试:

```ts
describe('logging hooks', () => {
  it('OAuth+emitTengu=true → 三个 emit 都被调用', async () => {
    // mock event-emitter,断言 emitSessionInit/emitApiQuery 在 onRequestStart 调用,emitApiSuccess 在 onResponseEnd
  })
  it('OAuth+emitTengu=false → 都不调用', async () => {})
  it('ApiKey 任何 emitTengu 设置 → 都不调用(兜底)', async () => {})
})
```

- [ ] **Step 3**:测试 PASS。

### Task 5.2:proxy.ts / forward-shared.ts 切到 logging hooks

**Files:**
- Modify: `src/proxy.ts`(`insertRequestLog` 调用替换为 `onRequestStart`)
- Modify: `src/forward-shared.ts`(`emitApiSuccess` 调用替换为 `onResponseEnd`)

- [ ] **Step 1**:proxy.ts 主入口在选定账号 + 创建 ctx 之后,加 `await onRequestStart(ctx)`,删除原 `insertRequestLog` 直接调用 + `emitSessionInit` + `emitApiQuery`。

- [ ] **Step 2**:forward-shared.ts 响应 end 处理处,把 `updateRequestLog` + `emitApiSuccess` + 计费写入,统一替换为 `await onResponseEnd(ctx, usage, reqId)`。

- [ ] **Step 3**:`grep -n "emitSessionInit\|emitApiQuery\|emitApiSuccess" src/` 应该只剩 `event-emitter.ts` 自身和 `pipeline/logging.ts`。

- [ ] **Step 4**:全测试 PASS。

### Task 5.3:Phase 5 commit

```bash
git add src/pipeline/logging.ts src/proxy.ts src/forward-shared.ts tests/pipeline/logging.test.ts
git commit -m "$(cat <<'EOF'
refactor(pipeline): event_emitter 三处副作用迁到 logging.ts hooks

onRequestStart 统一调度 insertRequestLog + emitSessionInit/emitApiQuery
(仅 OAuth + emitTengu=true);onResponseEnd 调度 updateRequestLog +
emitApiSuccess + 计费。proxy.ts/forward-shared.ts 切到 hooks 调用。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6:前端 AccountOptionsForm

### Task 6.1:`AccountOptionsForm` 主组件 + 子组件

**Files:**
- Create: `web/src/pages/admin/_accounts/options/AccountOptionsForm.tsx`
- Create: `web/src/pages/admin/_accounts/options/{ValidationGroup,OutboundCleanGroup,OutboundOverrideGroup,EventsGroup,AdvancedGroup}.tsx`
- Create: `web/src/pages/admin/_accounts/options/OverrideTriState.tsx`
- Create: `web/src/pages/admin/_accounts/options/ExtraHeadersEditor.tsx`
- Create: `web/src/pages/admin/_accounts/options/warnings.ts`

- [ ] **Step 1**:`warnings.ts`:

```ts
export const OAUTH_DANGER_FIELDS: Record<string, string> = {
  'validate.body':       '关闭后,网关会把 thinking signature 异常的请求直接转发给 Anthropic,可能触发反作弊。',
  'validate.shape':      '关闭后,empty-tools / side-query 请求会直接出站,Anthropic 可能识别为非 CC 客户端。',
  'validate.model':      '关闭后,任意模型字段会被透传,可能触发账户限制。',
  'clean.ccHeaders':     'OAuth 启用清洗会剥掉自己的 CC 伪装头,反而暴露身份。',
  'clean.ccBetaFlags':   '同上。',
  'clean.systemText':    '同上。',
  'clean.metadata':      '同上。',
  'override.userAgent':  'OAuth 必须保持 CC 客户端 UA,覆盖会破坏指纹。',
  'canonicalCcMessages': '关闭后 OAuth 会以原始客户端身份出站,Anthropic 立即识别异常。',
}

export function isOAuthDangerField(authKind: string, fieldId: string): boolean {
  return authKind === 'oauth' && fieldId in OAUTH_DANGER_FIELDS
}
```

- [ ] **Step 2**:`OverrideTriState.tsx`:

```tsx
import type { TriState } from '../types'   // mode + value 类型

interface Props {
  value: TriState                            // { mode, value }
  onChange: (next: TriState) => void
  withAppend?: boolean                       // anthropic-beta 用
  fieldId: string
  authKind: string
}

export function OverrideTriState({ value, onChange, withAppend, fieldId, authKind }: Props) {
  const dangerHint = isOAuthDangerField(authKind, fieldId) ? OAUTH_DANGER_FIELDS[fieldId] : null
  return (
    <div className="flex items-center gap-3">
      <label><input type="radio" checked={value.mode === 'omit'}
        onChange={() => onChange({ mode: 'omit', value: null })} /> omit</label>
      <label><input type="radio" checked={value.mode === 'passthrough'}
        onChange={() => onChange({ mode: 'passthrough', value: null })} /> 透传</label>
      <label><input type="radio" checked={value.mode === 'override'}
        onChange={() => onChange({ mode: 'override', value: value.value ?? '' })} /> 覆盖</label>
      {withAppend && (
        <label><input type="radio" checked={value.mode === 'append'}
          onChange={() => onChange({ mode: 'append', value: value.value ?? '' })} /> 追加</label>
      )}
      {(value.mode === 'override' || value.mode === 'append') && (
        <input className="flex-1 px-2 py-1 border" value={value.value ?? ''}
          onChange={(e) => onChange({ ...value, value: e.target.value })} />
      )}
      {dangerHint && <span title={dangerHint}>⚠</span>}
    </div>
  )
}
```

- [ ] **Step 3**:`AccountOptionsForm.tsx`(整合 5 个 group + 受控 value/onChange):

```tsx
import { ValidationGroup } from './ValidationGroup'
import { OutboundCleanGroup } from './OutboundCleanGroup'
// ...
import type { AccountOptions } from '../../../../api/types'

interface Props {
  authKind: 'oauth' | 'api_key'
  value: AccountOptions
  onChange: (next: AccountOptions) => void
}

export function AccountOptionsForm({ authKind, value, onChange }: Props) {
  return (
    <div className="flex flex-col gap-4">
      <ValidationGroup authKind={authKind} value={value.validate}
        onChange={(v) => onChange({ ...value, validate: v })} />
      <OutboundCleanGroup authKind={authKind} value={value.clean}
        onChange={(v) => onChange({ ...value, clean: v })} />
      <OutboundOverrideGroup authKind={authKind} value={value.override}
        onChange={(v) => onChange({ ...value, override: v })} />
      <EventsGroup authKind={authKind} value={value.events}
        onChange={(v) => onChange({ ...value, events: v })} />
      <AdvancedGroup authKind={authKind} value={{ canonicalCcMessages: value.canonicalCcMessages }}
        onChange={(v) => onChange({ ...value, canonicalCcMessages: v.canonicalCcMessages })} />
    </div>
  )
}
```

- [ ] **Step 4**:`ValidationGroup.tsx`(5 个 checkbox + ⚠ 提示):

```tsx
const fields: Array<{ key: keyof AccountOptions['validate']; label: string }> = [
  { key: 'body', label: '消息体完整性 (thinking sig / 空 text)' },
  { key: 'shape', label: '请求形状 (empty-tools / side-query)' },
  { key: 'model', label: '模型白名单' },
  { key: 'fastMode', label: '拒绝 fast 模式' },
  { key: 'requireStream', label: '强制流式' },
]
// 渲染:Checkbox + ⚠ 当 isOAuthDangerField(authKind, `validate.${key}`)
```

- [ ] **Step 5**:`OutboundCleanGroup.tsx` / `OutboundOverrideGroup.tsx` / `EventsGroup.tsx`(后者 ApiKey 时 disabled) / `AdvancedGroup.tsx` 同款骨架。

- [ ] **Step 6**:`ExtraHeadersEditor.tsx`(json 编辑 + 客户端校验拒绝敏感 key,显示与 zod 一致的错误信息)。

### Task 6.2:`AccountDrawer` + `NewAccountModal` 接入 + `AccountPolicyFields` 删 allow_non_stream

**Files:**
- Modify: `web/src/pages/admin/_accounts/AccountDrawer.tsx`
- Modify: `web/src/pages/admin/_accounts/NewAccountModal.tsx`
- Modify: `web/src/pages/admin/_accounts/AccountPolicyFields.tsx`

- [ ] **Step 1**:`AccountDrawer.tsx` 在策略 Tab 之外/内增加"选项"section,引用 `<AccountOptionsForm authKind={detail.account.auth_kind} value={options} onChange={setOptions} />`,保存时 PATCH `{ options }`。

- [ ] **Step 2**:删除 AccountDrawer 中老的 `skipShapeValidation` / `outboundUserAgent` state + 输入框。

- [ ] **Step 3**:`NewAccountModal.tsx` 第 3 步用 `<AccountOptionsForm>`,初始 value 由后端按 `auth_kind` 默认填(POST 时如果没填 options,后端用默认)。

- [ ] **Step 4**:`AccountPolicyFields.tsx` 删除 `allow_non_stream` 字段。

- [ ] **Step 5**:`web/api/types.ts`(若有)加入 `AccountOptions` 类型,与后端 zod schema 对齐。

- [ ] **Step 6**:`cd web && npm run build` PASS;`npm run lint` 干净。

### Task 6.3:Phase 6 commit

```bash
git add web/src/pages/admin/_accounts/options web/src/pages/admin/_accounts/AccountDrawer.tsx web/src/pages/admin/_accounts/NewAccountModal.tsx web/src/pages/admin/_accounts/AccountPolicyFields.tsx web/src/api/
git commit -m "$(cat <<'EOF'
feat(admin): AccountOptionsForm 取代 ApiKey-only 字段

OAuth 与 ApiKey 都展示同一受控表单(校验/清洗/覆盖/事件/高级),差别仅
在默认值与 ⚠ 危险项 tooltip。删除 AccountPolicyFields 的 allow_non_stream
(语义并入 options.validate.requireStream)。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 7:server route + 部署

### Task 7.1:`server/src/routes/oauth-accounts.ts` 改 options 字段

**Files:**
- Modify: `server/src/routes/oauth-accounts.ts`(line 453, 548-549, 733-734, 1622-1714)

- [ ] **Step 1**:列表 SELECT 把 `COALESCE(oa.skip_shape_validation, FALSE) AS skip_shape_validation, oa.outbound_user_agent` 替换为 `oa.options`。前端列表展示如需仍可显示"是否跳过 shape"等,从 `options.validate.shape` 衍生。

- [ ] **Step 2**:PATCH allowlist 把 `'skip_shape_validation', 'outbound_user_agent'` 替换为 `'options'`。值用 zod schema 验证(从 server 引入 `AccountOptionsSchema`):

```ts
import { AccountOptionsSchema } from '../../../src/features/options.js'
// PATCH handler:
if (key === 'options') {
  const parsed = AccountOptionsSchema.safeParse(req.body[key])
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message })
    return
  }
  await query('UPDATE oauth_accounts SET options = $1 WHERE id = $2', [parsed.data, accountId])
}
```

- [ ] **Step 3**:`POST /api-key`:把 `skip_shape_validation` / `outbound_user_agent` 入参替换为 `options`(可选,缺省用 `APIKEY_DEFAULT_OPTIONS`),用 zod 验证。

- [ ] **Step 4**:`POST /` 创建 OAuth 同上,缺省用 `OAUTH_DEFAULT_OPTIONS`。

- [ ] **Step 5**:`grep -n "skip_shape_validation\|outbound_user_agent\|allow_non_stream" server/src/` 应该清零(除了 audit log 中可能保留旧字段名作为历史记录的部分)。

- [ ] **Step 6**:`cd server && npm run build && npm test` PASS。

### Task 7.2:gwbk 部署 + 验证 + commit

- [ ] **Step 1**:本地全测试通过。

```bash
npm test && cd server && npm test && cd ../web && npm run build && cd ..
```

- [ ] **Step 2**:commit Phase 7:

```bash
git add server/src/routes/oauth-accounts.ts server/src/
git commit -m "$(cat <<'EOF'
feat(server): admin 路由改用 options 字段

POST/PATCH/SELECT 全部读写 options JSONB,zod schema 兜底
(extraHeaders 拒敏感 key)。删除 skip_shape_validation /
outbound_user_agent / allow_non_stream 三老字段引用。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3**:部署 gwbk:

```bash
bash scripts/deploy-gwbk.sh
```

- [ ] **Step 4**:gwbk 验证 checklist(spec §10):
  - [ ] 打开 admin UI,OAuth 抽屉看到 16 项装配开关全勾、危险项 ⚠ 提示
  - [ ] ApiKey 抽屉看到默认装配(校验全开、清洗全开、覆盖全 omit、emitTengu 关、canonicalCcMessages 关)
  - [ ] 用 `curl -X POST https://gwbk.example.com/v1/messages -H 'authorization: Bearer <token>' -d '{"model":"claude-sonnet-4-5","stream":true,"messages":[{"role":"user","content":"hi"}]}'` 测一条 OAuth 请求 → 200,日志确认 features 全过(可在 admin 请求日志页看 features 链路)
  - [ ] 改 OAuth 关 canonicalCcMessages,curl → 200,但出站抓包确认 **无 cc 伪装头**(语义符合预期)
  - [ ] 给一个 ApiKey 账号开 canonicalCcMessages=true 但不绑模板 → 503 no_cc_template
  - [ ] sk-ant-... 直连 ApiKey curl → 200,抓包确认 x-api-key + 无 x-claude-code-*
  - [ ] count_tokens curl → 200(features 跳过)

- [ ] **Step 5**:观察 24 小时:OAuth 账号无封禁、shape_forbidden 命中率与之前持平。

- [ ] **Step 6**:24h 通过后,部署 gw:`bash scripts/deploy-gw.sh`(若无该脚本,人工 rsync 同 deploy-gwbk.sh 流程;memory `feedback_deploy_promotion` 提到 gwbk→gw 顺序推进)。

- [ ] **Step 7**:gw 跑 1-3 天,稳定后无 follow-up。

---

## Self-Review

### 1. Spec coverage(spec → task 映射)

- §1 背景动机:无对应 task(背景知识)
- §2 总体架构:Task 4.1-4.7
- §3 AccountOptions schema:Task 1.2 / 1.3
- §4 数据库 schema(030):Task 1.1
- §5 Pipeline 架构:Task 4.1-4.4
- §6 proxy.ts 瘦身:Task 4.4
- §7 文件树:贯穿 Phase 2-6
- §8 前端 UI:Phase 6
- §9 测试计划:贯穿(每 task 自带 TDD)
- §10 部署节奏:Task 7.2
- §11 实施顺序(7 步):正好对应 Phase 1-7
- §12 风险:Task 1.1 / 4.4 / 7.2 各有缓解(gwbk dry-run / 分阶段 commit / 24h 观察)
- §13 未来扩展:不在范围

✓ 全部覆盖。

### 2. Placeholder 扫描

- 所有"如果有 X 模块"都写明了路径检查命令
- step 描述里没有 unfilled blank;`// FIXME phase 3` / `// @ts-expect-error TODO Phase X` 是受控的临时代码标记,有明确清除时机(Phase 3 / Phase 4)
- 测试代码有具体 assert,不是"测试上面的内容"

✓ 通过。

### 3. 类型一致性

- `AccountOptions` 在 Task 1.2 定义,后续 Task 1.3 / 2.5 / 6.1 / 7.1 引用一致
- `Feature` 在 Task 2.1 定义,后续 2.2-2.4 / 3.1-3.3 / 4.1 引用一致
- `PipelineContext` 在 Task 2.1 定义,Task 4.1 实现工厂函数
- `RetryDecision` 在 Task 4.3 定义,Task 4.2 forward 函数返回
- 所有引用都对得上

✓ 通过。
