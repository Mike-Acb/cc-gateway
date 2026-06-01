# 账号选项 + 双 pipeline 装配重构设计

**日期**:2026-05-07
**目标**:把 OAuth 与 ApiKey 的逻辑彻底分开,所有"校验/清洗/覆盖/事件"做成可装配的 feature。OAuth 默认全开,ApiKey 按需关闭/覆盖。改一处实现两条 pipeline 自动同步。

## 1. 背景与动机

### 现状

- `oauth_accounts` 表既存 OAuth 也存 ApiKey 账号,通过 `auth_kind` 区分(021 引入)。
- ApiKey 目前已经支持两个独立开关:`skip_shape_validation`(028)与 `outbound_user_agent`(029),都是"按账号覆盖"的雏形。
- 现有 `proxy.ts` ~1700 行,出站校验/改写逻辑分散:
  - 入站校验 6 处:`bodyValidationError` / `validateRequestShape` / `getUnsupportedModelReason` / `requestSpeed=fast` / `allow_non_stream` / cc 模板强制绑定
  - ApiKey 直连改写 `buildDirectApiKeyRewrite`:剥头/剥 beta flags/清洗 system 文本/移除 metadata/覆盖 UA
  - OAuth canonical 改写 `applyRewrite + buildCCHeaders + rewriteMessagesBody + getOrAssignSession`
  - event_emitter 三处副作用:`emitSessionInit / emitApiQuery / emitApiSuccess`
- 校验/改写都是按"OAuth 总是做、ApiKey 偶尔可关"的方式硬编码 if/else,新增项要在多处加判断。

### 问题

1. ApiKey 想跳过其他校验(模型白名单、fast 模式、模板绑定)需要每项都加一个新列+CHECK+if 分支。
2. ApiKey 想覆盖更多出站参数(anthropic-version、anthropic-beta、自定义 header)同样要 N 倍 boilerplate。
3. OAuth 与 ApiKey 共享的清洗代码(strip CC 头、剥 beta flag)实质重复:任何修改都要两边同步,容易漏。
4. UI 上 OAuth/ApiKey 两类账号字段集合迥异,前端复用难。

### 目标

- **单一实现**:每个校验/清洗/覆盖逻辑只写一份,OAuth 和 ApiKey 都从功能库引用。
- **按需装配**:Account 上挂 `options` JSONB,装配函数 `buildFeatures(account)` 输出该账号要执行的 feature 列表。
- **OAuth 默认全开**:语义上等同于今天的硬编码行为,UI 显示开关但默认勾选,危险项有 ⚠ 提示而非锁定。
- **ApiKey 默认安全**:校验全开 + 出站清洗全开 + 覆盖全 omit,用户随意按需关闭。
- **代码物理分离**:OAuth 与 ApiKey 仅在 forward 阶段(向上游发送的方向)分支,装配链路完全共用。

### 非目标

- 不做模式预设(preset);分类就是 `auth_kind` 本身。
- 不引入 feature flag 或并行新旧路径,一次性切换。
- 不改 admin 路由结构、池调度、限流、审计、计费等与 pipeline 无关的子系统。
- 不重写 cc 伪装模板、session-slots 等已稳定的子模块,只搬位置。

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│  proxy.ts   HTTP 接入 / 鉴权 / 选账号 / 调度 / 收尾          │
│  ~200 行,从现 ~1700 瘦身                                    │
└────────────────────────┬─────────────────────────────────────┘
                         │
                ┌────────┴─────────┐
                ▼                  ▼
        ┌──────────────┐    ┌──────────────┐
        │ pipeline/    │    │ pipeline/    │
        │ retry.ts     │◀──▶│ logging.ts   │
        │ (429/503 +   │    │ (insertLog/  │
        │  signature)  │    │  event_emit) │
        └──────┬───────┘    └──────────────┘
               │
               ▼
        ┌──────────────────┐
        │ pipeline/        │
        │ handle.ts        │
        │  buildFeatures() │
        │  runner.run()    │
        │  fork forward    │
        └──┬───────────┬───┘
           │           │
   oauth/  │           │  apikey/
  forward.ts          forward.ts
   ↓                   ↓
  api.anthropic    account.apiBaseUrl
```

### 三层职责

1. **`features/`**:中性功能库。每个 feature 是单一实现,被 OAuth/ApiKey 两条装配路径共享引用。
2. **`pipeline/`**:把 features 装配成有序执行链 + 处理 retry + 日志/事件 hook。
3. **`oauth/` 与 `apikey/`**:仅各自的 `forward.ts`(凭据头、URL 拼接、上游连接)。

### Account 类型(判别联合)

```ts
type AccountCommon = {
  id: string
  name: string
  authKind: 'oauth' | 'api_key'
  options: AccountOptions
  weight, status, healthStatus, ...
  // 通用字段(OAuth 与 ApiKey 都有,cc-canonical 也读)
  outboundProxyId, identityProfileId, ccTemplateId,
  canonicalIdentity, maxSessions, sessionTtlSeconds,
  organizationUuid, accountUuid,
}

type OAuthAccountVariant = AccountCommon & {
  authKind: 'oauth'
  refreshToken: string
  accessToken: string | null
  expiresAt: number
}

type ApiKeyAccountVariant = AccountCommon & {
  authKind: 'api_key'
  provider: 'anthropic' | 'openai'
  apiKey: string
  apiBaseUrl: string
}

type Account = OAuthAccountVariant | ApiKeyAccountVariant
```

OAuth 路径访问 `account.apiKey` 编译期报错;ApiKey 路径访问 `account.refreshToken` 同。所有 cc-canonical feature 读的字段都在 `AccountCommon` 里(P5 修订)。

## 3. AccountOptions 数据模型

### Schema

```ts
type TriState = 'omit' | 'passthrough' | 'override'
type BetaState = TriState | 'append'

interface AccountOptions {
  validate: {
    body: boolean              // 消息体完整性(thinking signature / 空 text block)
    shape: boolean             // 请求形状(empty-tools / side-query 等)
    model: boolean             // 模型白名单
    fastMode: boolean          // 拒绝 speed=fast
    requireStream: boolean     // 强制 stream:true(原 allow_non_stream 反义)
  }
  clean: {
    ccHeaders: boolean         // 剥离 x-claude-code-* / x-stainless-* / cf-* 等
    ccBetaFlags: boolean       // 剥离 anthropic-beta 里的 claude-code-* 前缀
    systemText: boolean        // 删除 system 文本中的 billing-header / CC intro 行
    metadata: boolean          // 删除 body.metadata
  }
  override: {
    userAgent:        { mode: TriState, value: string | null }
    anthropicVersion: { mode: TriState, value: string | null }
    anthropicBeta:    { mode: BetaState, value: string | null }  // append 模式追加而非替换
    extraHeaders:     Record<string, string>                       // 任意自定义头
  }
  events: {
    emitTengu: boolean         // 模拟 CC 发 event_logging 到 anthropic
  }
  canonicalCcMessages: boolean // 是否走 cc-canonical(完整 CC 改写)
}
```

### 默认值

```ts
const OAUTH_DEFAULT_OPTIONS: AccountOptions = {
  validate:  { body: true, shape: true, model: true, fastMode: true,
               requireStream: true },
  clean:     { ccHeaders: false, ccBetaFlags: false,
               systemText: false, metadata: false },
  override:  { userAgent:        { mode: 'omit', value: null },
               anthropicVersion: { mode: 'omit', value: null },
               anthropicBeta:    { mode: 'omit', value: null },
               extraHeaders: {} },
  events:    { emitTengu: true },
  canonicalCcMessages: true,
}

const APIKEY_DEFAULT_OPTIONS: AccountOptions = {
  validate:  { body: true, shape: true, model: true, fastMode: true,
               requireStream: true },
  clean:     { ccHeaders: true, ccBetaFlags: true,
               systemText: true, metadata: true },
  override:  { userAgent:        { mode: 'omit', value: null },
               anthropicVersion: { mode: 'omit', value: null },
               anthropicBeta:    { mode: 'omit', value: null },
               extraHeaders: {} },
  events:    { emitTengu: false },
  canonicalCcMessages: false,
}
```

### Zod schema 与安全名单(P11)

`features/options.ts` 用 zod 定义 schema,服务端 PATCH/POST 路由共用同一 schema 验证:

```ts
const FORBIDDEN_HEADER_KEYS = new Set([
  'authorization', 'x-api-key', 'host', 'cookie',
  'content-length', 'connection', 'proxy-connection',
  'cdn-loop', 'x-real-ip', 'forwarded',
])

const extraHeadersSchema = z.record(z.string(), z.string()).refine(
  (rec) => Object.keys(rec).every((k) => !FORBIDDEN_HEADER_KEYS.has(k.toLowerCase())),
  { message: '禁止覆盖 authorization / x-api-key / host / cookie 等敏感头' },
)
```

写入失败立即 400 + 错误详情。

## 4. 数据库 schema

### 决策

- 单列 JSONB(`options`),不拆 17 个布尔列。
- 028 与 029 已在 gwbk 跑过,不撤回,**新建 030_account_options.sql** 完成数据迁移 + DROP 老列。
- `simulate_fingerprint` / `cc_template_id` 等 CC 伪装层字段保留独立列(不属于校验/清洗/覆盖三组)。

### 030_account_options.sql

```sql
BEGIN;

-- 1) 加 options 列
ALTER TABLE oauth_accounts
  ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 2) 数据迁移(P12:仅迁移空对象的行,防 deploy 重跑覆盖人工修改)
UPDATE oauth_accounts SET options = jsonb_build_object(
  'validate', jsonb_build_object(
    'body',              true,
    'shape',             NOT COALESCE(skip_shape_validation, false),
    'model',             true,
    'fastMode',          true,
    'requireStream',     NOT COALESCE(allow_non_stream, false)
  ),
  'clean', jsonb_build_object(
    'ccHeaders',   auth_kind = 'api_key',
    'ccBetaFlags', auth_kind = 'api_key',
    'systemText',  auth_kind = 'api_key',
    'metadata',    auth_kind = 'api_key'
  ),
  'override', jsonb_build_object(
    'userAgent', jsonb_build_object(
      'mode',  CASE WHEN outbound_user_agent IS NOT NULL THEN 'override' ELSE 'omit' END,
      'value', outbound_user_agent
    ),
    'anthropicVersion', jsonb_build_object('mode','omit','value',NULL),
    'anthropicBeta',    jsonb_build_object('mode','omit','value',NULL),
    'extraHeaders',     '{}'::jsonb
  ),
  'events', jsonb_build_object('emitTengu', auth_kind = 'oauth'),
  'canonicalCcMessages', auth_kind = 'oauth'
)
WHERE NOT (options ? 'validate');  -- 已迁移过的不覆盖

-- 3) 不变量自检(线上跑也能 catch 数据漏搬)
DO $$
DECLARE bad INT;
BEGIN
  SELECT COUNT(*) INTO bad FROM oauth_accounts
   WHERE auth_kind='oauth' AND options->>'canonicalCcMessages' <> 'true';
  IF bad <> 0 THEN RAISE EXCEPTION 'OAuth 账号 canonicalCcMessages 应全为 true,实际有 %', bad; END IF;

  SELECT COUNT(*) INTO bad FROM oauth_accounts
   WHERE skip_shape_validation = true AND options->'validate'->>'shape' <> 'false';
  IF bad <> 0 THEN RAISE EXCEPTION 'skip_shape=true 应迁为 validate.shape=false,异常 %', bad; END IF;

  SELECT COUNT(*) INTO bad FROM oauth_accounts
   WHERE outbound_user_agent IS NOT NULL
     AND (options->'override'->'userAgent'->>'mode' <> 'override'
       OR options->'override'->'userAgent'->>'value' IS DISTINCT FROM outbound_user_agent);
  IF bad <> 0 THEN RAISE EXCEPTION 'outbound_user_agent 迁移异常 %', bad; END IF;
END $$;

-- 4) DROP 老约束 + 老列
ALTER TABLE oauth_accounts
  DROP CONSTRAINT IF EXISTS oauth_accounts_skip_shape_validation_check;

ALTER TABLE oauth_accounts
  DROP COLUMN IF EXISTS allow_non_stream,
  DROP COLUMN IF EXISTS skip_shape_validation,
  DROP COLUMN IF EXISTS outbound_user_agent;

-- 5) 加 options shape CHECK
ALTER TABLE oauth_accounts
  ADD CONSTRAINT oauth_accounts_options_shape_check
  CHECK (
    jsonb_typeof(options->'validate') = 'object'
    AND jsonb_typeof(options->'clean') = 'object'
    AND jsonb_typeof(options->'override') = 'object'
    AND jsonb_typeof(options->'events') = 'object'
    AND (options ? 'canonicalCcMessages')
  );

COMMIT;
```

**gwbk dry-run 验证已通过**(2026-05-07):14 个真实账号(11 OAuth + 3 ApiKey)在事务里跑完整迁移,所有不变量通过,DROP 后 schema 正确,ROLLBACK 不影响数据。

## 5. Pipeline 架构

### PipelineContext

```ts
interface PipelineContext {
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
  account!: Account
  credential!: string

  // pipeline 中间可变态
  outboundHeaders: Record<string, string>
  outboundBody: Buffer
  parsedOutboundBody: any | null
  shapeOut: RequestShape | null
  derivedSessionId: string | null
  forceStripSignatures: boolean   // P3:signature-retry 时 retry.ts 设为 true

  // 收尾
  upstreamResponse?: { status: number, headers: IncomingHttpHeaders, body: Readable }
  blockReason?: string
  blockSource?: string
  emitCtx?: EmitContext           // P7:logging.ts 在 onRequestStart 写,onResponseEnd 读

  // P2:retry 时重置出站态
  resetOutbound(): void
}
```

### Feature 接口

```ts
type Phase =
  | 'inbound-validate'      // 早退 4xx/5xx
  | 'outbound-canonical'    // CC 完整改写
  | 'outbound-clean'        // 清洗
  | 'outbound-override'     // 覆盖

type FeatureResult =
  | { ok: true }
  | { ok: false, status: number, reason: string,
      blockReason: string, blockSource: 'gw' | 'plan' | string }

interface Feature {
  id: string
  phase: Phase
  appliesTo?: (ctx: PipelineContext) => boolean   // P1:per-feature 适用范围
  run(ctx: PipelineContext): Promise<FeatureResult> | FeatureResult
}
```

### Runner

```ts
async function run(features: Feature[], ctx: PipelineContext): Promise<FeatureResult> {
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

无并行、无 hook;cross-cutting 逻辑由 runner 之外的 logging.ts 在边界打点。

### 16 个 feature 一览

| Phase | id | 实现来源 | appliesTo | 失败码 |
|---|---|---|---|---|
| inbound-validate | body-integrity | bodyValidationError | `/v1/messages` & !count_tokens | 400 malformed_block |
| inbound-validate | request-shape | validateRequestShape | `/v1/messages` & !count_tokens | 400 shape_forbidden |
| inbound-validate | model-allowlist | getUnsupportedModelReason | 所有 | 400 plan_forbidden_model |
| inbound-validate | fast-mode-reject | requestSpeed==='fast' | 所有 | 400 fast_mode_blocked |
| inbound-validate | require-stream | !requestIsStream | `/v1/messages` & !count_tokens | 400 non_stream_blocked |
| outbound-canonical | cc-build-headers | buildCCHeaders;内部守卫 ccTemplateId==null → 503(吸收原 NoTemplateBoundError) | `/v1/messages` & !count_tokens | 503 no_cc_template |
| outbound-canonical | cc-rewrite-messages-body | rewriteMessagesBody;内部读 ctx.forceStripSignatures 或查 redis(P9) | `/v1/messages` & !count_tokens | 4xx non_cc_request 等(P8) |
| outbound-canonical | cc-session-binding | getOrAssignSession + 写 ctx.derivedSessionId | `/v1/messages` & !count_tokens | — |
| outbound-clean | strip-cc-headers | API_KEY_FORWARD_DROP_* | 所有 | — |
| outbound-clean | strip-cc-beta-flags | stripCCBetaFlags | 所有 | — |
| outbound-clean | sanitize-system-text | sanitizeApiKeyRequestBody | 所有 | — |
| outbound-clean | drop-metadata | delete body.metadata | 所有 | — |
| outbound-override | user-agent | 三态 | 所有 | — |
| outbound-override | anthropic-version | 三态 | 所有 | — |
| outbound-override | anthropic-beta | 四态(含 append) | 所有 | — |
| outbound-override | extra-headers | 注入 + zod 拦截敏感 key | 所有 | — |

### buildFeatures

```ts
function buildFeatures(account: Account): Feature[] {
  const o = account.options
  const f: Feature[] = []

  if (o.validate.body)              f.push(bodyIntegrity)
  if (o.validate.shape)             f.push(requestShape)
  if (o.validate.model)             f.push(modelAllowlist)
  if (o.validate.fastMode)          f.push(fastModeReject)
  if (o.validate.requireStream)     f.push(requireStream)

  if (o.canonicalCcMessages) {
    f.push(ccBuildHeaders, ccRewriteMessagesBody, ccSessionBinding)
  }

  if (o.clean.ccHeaders)    f.push(stripCcHeaders)
  if (o.clean.ccBetaFlags)  f.push(stripCcBetaFlags)
  if (o.clean.systemText)   f.push(sanitizeSystemText)
  if (o.clean.metadata)     f.push(dropMetadata)

  f.push(userAgent(o.override.userAgent))
  f.push(anthropicVersion(o.override.anthropicVersion))
  f.push(anthropicBeta(o.override.anthropicBeta))
  f.push(extraHeaders(o.override.extraHeaders))

  // PHASE_ORDER 排序由调用方保证(buildFeatures 已按上面顺序追加,自然有序)
  return f
}
```

### Pipeline handle

```ts
// pipeline/handle.ts
import * as oauthForward from '../oauth/forward.js'
import * as apikeyForward from '../apikey/forward.js'

export async function handle(ctx: PipelineContext) {
  const features = buildFeatures(ctx.account)
  const result = await runner.run(features, ctx)
  if (!result.ok) {
    await earlyReject(ctx, result.status, result.reason, result.blockReason, result.blockSource)
    return
  }
  const forward = ctx.account.authKind === 'oauth' ? oauthForward : apikeyForward
  await forward.send(ctx)
}
```

### Forward(两条物理分叉)

```ts
// oauth/forward.ts
export async function send(ctx: PipelineContext) {
  ctx.outboundHeaders['authorization'] = `Bearer ${ctx.credential}`
  return doFetch(ctx, anthropicUpstreamUrl(ctx.path))
}

// apikey/forward.ts
export async function send(ctx: PipelineContext) {
  const acct = ctx.account as ApiKeyAccountVariant
  if (acct.provider === 'anthropic') {
    ctx.outboundHeaders['x-api-key'] = ctx.credential
    if (!ctx.outboundHeaders['anthropic-version']) {
      ctx.outboundHeaders['anthropic-version'] = '2023-06-01'  // override 已生效则不会进这里
    }
  } else {
    ctx.outboundHeaders['authorization'] = `Bearer ${ctx.credential}`
  }
  return doFetch(ctx, joinUrl(acct.apiBaseUrl, ctx.path))
}
```

### Retry(P3:两类重试)

```ts
// pipeline/retry.ts
export async function run(maxRetries: number, ctx: PipelineContext, attempt: () => Promise<RetryDecision>) {
  for (let i = 0; i <= maxRetries; i++) {
    const decision = await attempt()
    if (decision === 'ok') return
    if (decision === 'retry-different-account') {
      await reselectAccount(ctx)
      ctx.resetOutbound()                         // P2
      continue
    }
    if (decision === 'retry-strip-signatures') {
      ctx.forceStripSignatures = true             // P3
      ctx.resetOutbound()
      continue
    }
    return  // 'fatal' / 'client-disconnect'
  }
}
```

### Logging hooks(日志补丁)

```ts
// pipeline/logging.ts
export async function onRequestStart(ctx: PipelineContext) {
  await insertRequestLog(ctx)
  if (ctx.account.options.events.emitTengu && ctx.account.authKind === 'oauth') {
    const acct = ctx.account
    const stainlessOs = (ctx.requestHeadersIn['x-stainless-os'] as string) || 'MacOS'
    const clientVersion = (ctx.requestHeadersIn['x-stainless-package-version'] as string) || '2.1.112'
    emitSessionInit(acct.id, ctx.derivedSessionId!, ctx.credential, acct.outboundProxyId,
      acct.canonicalIdentity?.device_id || '', acct.canonicalIdentity?.account_uuid || '',
      acct.canonicalIdentity?.email || '', acct.organizationUuid || '',
      clientVersion, stainlessOs, { /* link */ })
    emitApiQuery(emitCtx, { /* ... */ })
    ctx.emitCtx = emitCtx
  }
}

export async function onResponseEnd(ctx: PipelineContext, usage: Usage, reqId?: string) {
  await updateRequestLog(ctx, usage)
  await recordBilling(ctx, usage)
  if (ctx.emitCtx && ctx.account.options.events.emitTengu && ctx.account.authKind === 'oauth') {
    emitApiSuccess(ctx.emitCtx, { ...usage, requestId: reqId })
  }
}
```

`emitTengu === true` 但 `authKind === 'api_key'` 兜底 disabled — ApiKey 没有 OAuth Bearer,event_logging 接口也只接 OAuth。

### Error → FeatureResult(P8)

不再 throw `NoTemplateBoundError` / `NonCCRequestError`:
- `cc-build-headers` feature 入口先查 `account.ccTemplateId`,为 null 时直接 return `{ ok: false, status: 503, blockReason: 'no_cc_template' }`(吸收原 NoTemplateBoundError 语义)。
- `cc-rewrite-messages-body` feature 内部 try/catch `NonCCRequestError`,转为 `{ ok: false, status: 400, blockReason: 'non_cc_request' }`。
- runner 不接 throw,所有失败由 FeatureResult 承载。
- `cc-disguise.ts` 中的 `NoTemplateBoundError` 类同步删除(无引用)。

## 6. proxy.ts 瘦身后

```ts
export async function handleRequest(req, res, config) {
  const ctx = await buildContext(req, res, config)        // 鉴权/body 读取/parse/shape 分类
  if (!ctx.ok) return earlyReject(ctx)

  const acct = await selectAccountAndToken(ctx)
  if (!acct.ok) return earlyReject(ctx)
  ctx.account = acct.account
  ctx.credential = acct.credential

  await onRequestStart(ctx)                                // logging.ts 副作用 + emit_events
  await onRequestStartCounters(ctx.account.id)             // inflight 登记

  const maxRetries = acct.forced ? 0 : (ctx.account.maxRetries ?? 0)
  await retry.run(maxRetries, ctx, async () => {
    return pipeline.handle(ctx)                            // 内部 buildFeatures + runner.run + forward
  })

  await finalize(ctx)                                      // onResponseEnd + onRequestEndCounters
}
```

目标行数:200 行(从现 1700)。

## 7. 文件树最终

```
src/
  features/
    types.ts                        Feature/Phase/FeatureResult
    options.ts                      AccountOptions + 默认值 + zod schema
    build.ts                        buildFeatures(account) → Feature[](按 PHASE_ORDER 顺序追加)
    validation/
      body-integrity.ts
      request-shape.ts
      model-allowlist.ts
      fast-mode-reject.ts
      require-stream.ts
    cc-canonical/
      build-headers.ts              buildCCHeaders 改装
      rewrite-messages-body.ts      rewriteMessagesBody + signatureContext 查询
      session-binding.ts            getOrAssignSession 包装
    outbound-clean/
      strip-cc-headers.ts
      strip-cc-beta-flags.ts
      sanitize-system-text.ts
      drop-metadata.ts
    outbound-override/
      user-agent.ts                 三态
      anthropic-version.ts          三态
      anthropic-beta.ts             四态
      extra-headers.ts
  pipeline/
    context.ts                      PipelineContext + resetOutbound
    runner.ts                       run(features, ctx) + appliesTo skip
    retry.ts                        429/503 + signature-retry 两路
    logging.ts                      insertRequestLog + event_emitter 调度 + 计费
    handle.ts                       共享 handle + fork forward
  oauth/
    forward.ts                      → api.anthropic.com
  apikey/
    forward.ts                      → account.apiBaseUrl
  proxy.ts                          ~200 行
  event-emitter.ts                  840 行,实现不动,调用点搬到 logging.ts
  cc-disguise.ts                    error 类保留;throw 由 features 内部 catch 转 result
  rewriter.ts                       拆光后删除

web/src/pages/admin/_accounts/
  AccountDrawer.tsx                 引用 AccountOptionsForm
  NewAccountModal.tsx               引用 AccountOptionsForm(第 3 步)
  AccountPolicyFields.tsx           删除 allow_non_stream(P14)
  options/
    AccountOptionsForm.tsx          受控:value/onChange + authKind
    ValidationGroup.tsx
    OutboundCleanGroup.tsx
    OutboundOverrideGroup.tsx
    EventsGroup.tsx                 emitTengu(ApiKey 时 disabled)
    AdvancedGroup.tsx               canonicalCcMessages
    OverrideTriState.tsx            omit/passthrough/override/append
    ExtraHeadersEditor.tsx          json key:value + 敏感 key 校验
    warnings.ts                     OAuth 危险项 ⚠ 文案
```

## 8. 前端 UI

### AccountDrawer 新增"选项" Tab

OAuth/ApiKey 都展示同一表单,差别仅在默认值与 ⚠ 提示。无锁定、无解锁按钮、无 preset。

```
▾ 入站校验
   ☑ 消息体完整性                                  ⚠ (OAuth)
   ☑ 请求形状                                      ⚠ (OAuth)
   ☑ 模型白名单                                    ⚠ (OAuth)
   ☑ 拒绝 fast 模式
   ☑ 强制流式
   (CC 模板绑定不在此显示;由"高级 → CC canonical"自动派生:开则要求绑模板,缺模板出站立即 503)

▾ 出站清洗
   ☐ 剥离 CC 伪装头                                ⚠ (OAuth)
   ☐ 剥离 CC beta flag                             ⚠ (OAuth)
   ☐ 清洗 system 文本                              ⚠ (OAuth)
   ☐ 移除 metadata                                 ⚠ (OAuth)

▾ 出站覆盖
   User-Agent          ◉ omit  ○ 透传  ○ 覆盖 [____]    ⚠ (OAuth)
   anthropic-version   ◉ omit  ○ 透传  ○ 覆盖 [____]
   anthropic-beta      ◉ omit  ○ 透传  ○ 覆盖 [____]  ○ 追加 [____]
   自定义 Header (json)
   [_____________________________________________]

▾ 事件/日志
   ☑ 模拟 CC 发 event_logging 到 Anthropic         (ApiKey 时 disabled)

▾ 高级
   ☑ 走 CC canonical 改写 (Anthropic /v1/messages)  ⚠ (OAuth)
```

⚠ tooltip 文案集中在 `options/warnings.ts`,如:
> "修改可能触发反作弊导致账号封禁,确保你知道在做什么。"

### NewAccountModal

第 3 步"选项":两条流程都引用同一个 `<AccountOptionsForm>`,初始值由后端按 `auth_kind` 填默认(`OAUTH_DEFAULT_OPTIONS` / `APIKEY_DEFAULT_OPTIONS`)。

### AccountPolicyFields 改动(P14)

`allow_non_stream` 字段从 policy 表单删除,语义搬到 `AccountOptionsForm` 的"强制流式"勾选。policy 表单只剩限流/配额/会话相关字段。

## 9. 测试计划

### 已有测试改动

| 文件 | 改动 |
|---|---|
| `request-shapes.test.ts` | 调用方包装成 `requestShape.run(ctx)`,断言不变 |
| `rewriter.test.ts` | 拆成 cc-canonical 三 feature 单测 + outbound-clean 四 feature 单测 |
| `session-slots.test.ts` | 调 `cc-session-binding.run(ctx)` 而非直接 `getOrAssignSession` |
| `signature-context.test.ts` | 接口不变,导入路径调整 |

其他测试(cc-disguise / metering / quota-checker / request-logger / account-groups / audit-log / launcher / rate-limiter / me-* / sync)**不动**。

### 新增测试

```
tests/features/
  options.test.ts                   zod schema:OAuth/ApiKey 默认值通过 parse;extraHeaders 写 'authorization' 被拒
  build.test.ts                     OAuth 默认 → 16 feature 全装配(5 校验 + 3 cc-canonical + 4 清洗 + 4 覆盖);ApiKey 默认 → 13(无 cc-canonical 三个);手工关闭 4 项 → -4
  validation/*.test.ts              5 个 feature 各自单测(成功 + 失败码/reason)
  outbound-clean/*.test.ts          4 个 feature 单测
  outbound-override/*.test.ts       三态 + append 各自;extra-headers 注入与拦截
  cc-canonical/*.test.ts            build-headers/rewrite-messages-body/session-binding 单测
                                    build-headers 测 ccTemplateId==null → 503 no_cc_template(吸收原 NoTemplateBoundError,P8)
                                    rewrite-messages-body 测 forceStripSignatures 覆盖 redis 查询(P3+P9)
                                    rewrite-messages-body 测 NonCCRequestError → ok:false 转换(P8)

tests/pipeline/
  runner.test.ts                    短路:第 N 个失败 N+1 不调,blockReason 写入;appliesTo 跳过(P1)
  handle.test.ts                    端到端:OAuth 完整 CC 改写;ApiKey-anthropic-canonical=true → CC 改写但 x-api-key;
                                    ApiKey 默认 → 直连清洗;ApiKey 关全部校验 → 任意 body 不被拦
  retry.test.ts                     429 → 换号 + ctx.resetOutbound 调用(P2);
                                    400 invalid-signature → 同号 + forceStripSignatures=true(P3);
                                    多次 retry headers/body 不重复 strip(P2)
  logging.test.ts                   OAuth+emitTengu=true → 三个 emit 全调;OAuth+emitTengu=false → 都不调;
                                    ApiKey 任何 emitTengu 设置 → 都不调(P7 兜底)

tests/migrations/
  030.test.ts                       临时库跑 011→028→029→030,断言三老列消失/options 存在/CHECK 生效;
                                    模拟混合数据 → 跑 030 → 断言 options 等价(P12);
                                    重跑 030 → 已迁移行不被覆盖
```

### P13 测试盲区补齐

- OpenAI provider:ApiKey + provider=openai → sanitize-system-text no-op;forward 用 `Authorization: Bearer`
- count_tokens:`/v1/messages/count_tokens` → request-shape / require-stream / cc-canonical 全 skip
- signature-retry:retry.ts 触发 → ctx.forceStripSignatures=true → cc-rewrite-messages-body 强制 strip
- retry-状态重置:多次 retry 后 outboundHeaders 不含上次注入的双份字段

## 10. 部署节奏

```
1. 本地全测试通过(npm test、cd server && npm test、cd web && npm run build)
2. 提交 028/029/030 三个迁移 + 后端 + 前端 + 测试,一次 commit(无 feature flag)
3. bash scripts/deploy-gwbk.sh
   ├─ rsync(含未 commit 兜底)
   ├─ npm install + web build
   ├─ apply *.sql(011/028/029 在 gwbk 已生效会跳过,030 首次跑触发数据迁移)
   └─ pm2 reload
4. gwbk 验证(curl + admin UI):
   - OAuth 抽屉看到 16 项装配开关全勾、危险项 ⚠ 提示
   - ApiKey 抽屉看到默认装配
   - /v1/messages 走 OAuth → 200,日志确认 features 全过
   - /v1/messages 走 ApiKey(canonicalCcMessages=false + 关 model 校验) → 200
   - 改 OAuth 关 canonicalCcMessages,curl → 200(确认 ⚠ 不阻断,且无 cc-canonical 改写)
   - 给一个 ApiKey 账号开 canonicalCcMessages=true 但不绑模板 → 503 no_cc_template(确认 cc-build-headers 守卫)
   - sk-ant-... 直连 ApiKey → 抓包确认 x-api-key + 无 x-claude-code-*
   - count_tokens 路径 → 200(features 跳过验证)
5. 观察 24h:OAuth 账号有无被 ban、shape_forbidden 命中率有无异常
6. 同一 commit 部署到 gw,跑同 030 迁移
7. gw 跑 1-3 天,删除 src/rewriter.ts 残留 re-export(若有)
```

### 回滚

- 代码:`git revert` 此 commit + 重 deploy。
- DB:030 是单向迁移(DROP 老列后无法无损还原)。需要单独写 `030_down.sql`:
  ```sql
  ALTER TABLE oauth_accounts
    ADD COLUMN allow_non_stream BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN skip_shape_validation BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN outbound_user_agent TEXT;
  UPDATE oauth_accounts SET
    allow_non_stream      = NOT (options->'validate'->>'requireStream')::bool,
    skip_shape_validation = NOT (options->'validate'->>'shape')::bool,
    outbound_user_agent   = CASE WHEN options->'override'->'userAgent'->>'mode' = 'override'
                                 THEN options->'override'->'userAgent'->>'value' END;
  ALTER TABLE oauth_accounts
    DROP CONSTRAINT oauth_accounts_options_shape_check,
    DROP COLUMN options;
  ```
- 紧急时可仅 git revert 代码,DB 留着(代码不依赖老列就能跑,只是 admin UI 不能改 options 字段)。

## 11. 实施顺序建议(分 commit)

1. **schema + 类型**:030 迁移 + `features/options.ts` zod schema + Account 判别联合(account-pool.ts 改读 options) — 不动 proxy.ts 行为
2. **features 抽出**:把现有 13 个原子能力搬到 `features/` 各文件,实现保持不变,proxy.ts 暂时引用新位置 — 行为零变化
3. **pipeline 装配**:`pipeline/` 引入 + buildFeatures + handle + retry,proxy.ts 切换到 `pipeline.handle` 调用 — 这一步是核心切换
4. **rewriter.ts 删除 + cc-canonical features 化**:把 buildCCHeaders / rewriteMessagesBody / session-binding 包成 feature
5. **logging.ts 抽出**:event_emitter 三处副作用搬到 logging.ts hook
6. **前端 AccountOptionsForm + AccountPolicyFields 调整**
7. **server/src/routes/oauth-accounts.ts** 改用 options 字段写入

每步独立可测、可 revert,降低事故影响。

## 12. 风险与缓解

| 风险 | 缓解 |
|---|---|
| OAuth 账号在 UI 改坏 options 触发 ban | UI ⚠ 提示;告警通道(后续加)监控 OAuth options 异动审计 |
| 030 迁移在生产数据上漏案例 | 迁移内嵌 DO block 不变量自检 + gwbk dry-run 已通过 |
| pipeline 重构引入回归 | 实施分 7 步独立 commit;每步 npm test 全通过才推进 |
| ApiKey extraHeaders 注入越权头 | zod schema 拒绝敏感 key,400 早返 |
| 新架构 retry 时 outbound 状态污染 | resetOutbound 强制契约,retry.ts 单测覆盖 |
| event_emitter 调用点搬到 logging.ts 后 dedup 失效 | emitSessionInit 内部已有 redis dedup(`isSessionInitialized` key=accountId:sessionId),调用点搬动不影响 |

## 13. 未来扩展(明确不在本次范围)

- **审计 options 变更**:OAuth 账号 options 修改写 audit_log,触发 webhook 通知。
- **更多覆盖参数**:body 字段覆盖(如默认 `temperature`)、按模型路由覆盖等。
- **per-feature 度量**:每个 feature 独立的命中率 / 早退率指标。
- **OAuth 默认值版本化**:OAuth_DEFAULT_OPTIONS 升级时,旧账号自动同步或带 migration。
