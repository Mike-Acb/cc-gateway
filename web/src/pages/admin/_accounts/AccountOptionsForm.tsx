import { useState } from 'react'
import { Checkbox } from '../../../ui/Checkbox'
import { Field, Input } from '../../../ui/Field'

// 镜像 src/features/options.ts AccountOptions
type TriMode = 'omit' | 'passthrough' | 'override'
type BetaMode = TriMode | 'append'

export interface AccountOptions {
  validate: {
    body: boolean
    shape: boolean
    shapeAutoComplete: boolean
    aggressiveDisguise: boolean
    normalizeTemperature: boolean
    model: boolean
    fastMode: boolean
    requireStream: boolean
  }
  clean: {
    ccHeaders: boolean
    ccBetaFlags: boolean
    systemText: boolean
    metadata: boolean
    toolUseTrailing: boolean
    capCacheControl: boolean
    canonicalizeNonCCTools: boolean
  }
  override: {
    userAgent: { mode: TriMode; value: string | null }
    anthropicVersion: { mode: TriMode; value: string | null }
    anthropicBeta: { mode: BetaMode; value: string | null }
    extraHeaders: Record<string, string>
  }
  events: { emitTengu: boolean }
  canonicalCcMessages: boolean
}

export const OAUTH_DEFAULT_OPTIONS: AccountOptions = {
  validate:  { body: true, shape: true, shapeAutoComplete: true, aggressiveDisguise: true, normalizeTemperature: true, model: true, fastMode: true, requireStream: false },
  clean:     { ccHeaders: true, ccBetaFlags: true, systemText: true, metadata: true, toolUseTrailing: true, capCacheControl: true, canonicalizeNonCCTools: false },
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
  validate:  { body: true, shape: true, shapeAutoComplete: true, aggressiveDisguise: false, normalizeTemperature: false, model: true, fastMode: true, requireStream: false },
  clean:     { ccHeaders: true, ccBetaFlags: true, systemText: true, metadata: true, toolUseTrailing: true, capCacheControl: true, canonicalizeNonCCTools: false },
  override:  {
    userAgent:        { mode: 'omit', value: null },
    anthropicVersion: { mode: 'omit', value: null },
    anthropicBeta:    { mode: 'omit', value: null },
    extraHeaders: {},
  },
  events: { emitTengu: false },
  canonicalCcMessages: false,
}

const OAUTH_DANGER: Record<string, string> = {
  'validate.body': '关闭后,thinking signature 异常请求会直接出站,可能触发反作弊',
  'validate.shape': '关闭后,empty-tools / side-query 请求会直接出站,Anthropic 可能识别为非 CC',
  'validate.shapeAutoComplete': 'Tier 1 零副作用补齐:(1) 接受 CC 源码确认但 HAR Pending 的 profile;(2) 缺 temperature 自动补 1 (=上游默认值,响应语义不变)。不动 tools / messages / context_management 等会改变响应语义的字段。',
  'validate.aggressiveDisguise': 'Tier 2 主动语义破坏伪装:(1) 客户端非 CC tools (如小写 read/edit) 替换为 template.tools;(2) body.context_management 用 CC 真实形态覆盖;(3) system 整体重置为 [billing + template prompt],丢弃客户端塞的所有 block (含 OpenClaw 等第三方身份泄露 block 和 \'You are Claude Code\' 诱饵)。代价:客户端 tool_use 失效、自定义 compact 失效、客户端 system 业务指令失效 (template 取代)。Anthropic 风控识别风险接近 0,但客户端业务可能断。',
  'validate.normalizeTemperature': 'temperature 规整到 CC 真实分布:thinking active (enabled/adaptive) → 删 temperature;否则 → temperature=1。让 IDE agent (Roo Code / Cline 等默认 temperature=0) 的请求经修正后命中 agentic_*_t1_like profile,自动通过 shape 校验。OAuth 通道默认开,APIKEY 通道默认关 (透传客户端原值)。关闭后 OAuth 通道客户端发 temperature≠1 会被 shape 校验拦下 (unknown_messages_shape)。',
  'validate.model': '关闭后,任意模型字段会被透传,可能触发账户限制',
  'validate.requireStream': '关闭后,非流式请求会直接出站。CC 真实流量永远是 stream=true,Anthropic 可能识别为非 CC',
  'clean.ccHeaders': 'OAuth 启用清洗会剥掉自己的 CC 伪装头,反而暴露身份',
  'clean.ccBetaFlags': '同上',
  'clean.systemText': '同上',
  'clean.metadata': '同上',
  'clean.toolUseTrailing': '关闭后,客户端 SDK 重组 streaming 产生的 [text, tool_use, text(重复)] 畸形会原样发到上游;Anthropic 会以 `tool_use ids found without tool_result blocks immediately after` 报 400 (字面是配对缺失,实际是 block 顺序违规)。仅在 APIKEY 透传到第三方 provider 不期望网关改 body 时关闭。',
  'clean.capCacheControl': '关闭后,body 中累计 cache_control 块超过 4 时会被 Anthropic 上游回 400 "A maximum of 4 blocks with cache_control"。开启时 gateway 在 disguiseBody 之后做最终兜底,按 messages → tools → system 倒序 strip 多余的。OAuth 路径关闭=可能 400;ApiKey 直连第三方 provider 时若上游无此限制可关。',
  'clean.canonicalizeNonCCTools': '把非 CC 风格的 tools (opencode/crush 的 snake_case 命名如 read/exec/sessions_*) 改写成 CC 风格 (Read/Bash/SessionsSpawn) 让请求过 validateCCRequest baseline;tool input_schema 的 camelCase keys 同时改成 snake_case。响应 SSE 阶段反向还原 (tool_use.name + input keys → 客户端约定的命名)。仅在愿意服务非 CC TUI agent 的账号开;主流量请关闭。风险:tool input_schema 字段虽规整,但语义仍是客户端约定的,若 Anthropic 反作弊算 tool schema 指纹可能被识别。',
  'override.userAgent': 'OAuth 必须保持 CC 客户端 UA,覆盖会破坏指纹',
  'canonicalCcMessages': '关闭后 OAuth 以原始客户端身份出站,Anthropic 立即识别异常',
}

function Warn({ authKind, fieldId }: { authKind: string; fieldId: string }) {
  const [open, setOpen] = useState(false)
  if (authKind !== 'oauth' || !OAUTH_DANGER[fieldId]) return null
  const text = OAUTH_DANGER[fieldId]
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        className="ml-1 text-[var(--warn)] cursor-help bg-transparent border-0 p-0 leading-none"
        title={text}
        onClick={(e) => { e.preventDefault(); setOpen(o => !o) }}
        aria-label="show warning"
      >
        ⚠
      </button>
      {open && (
        <span
          className="absolute left-0 top-[1.4em] z-50 max-w-[420px] w-[max-content] bg-[var(--bg)] border border-[var(--warn)] text-[var(--ink)] text-[11px] leading-relaxed p-2 rounded shadow-lg whitespace-normal"
          onClick={() => setOpen(false)}
        >
          {text}
        </span>
      )}
    </span>
  )
}

interface CkProps {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  authKind: string
  fieldId: string
  disabled?: boolean
  reason?: string
}
function Ck({ label, checked, onChange, authKind, fieldId, disabled, reason }: CkProps) {
  return (
    <div className="flex items-center gap-1">
      <Checkbox label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <Warn authKind={authKind} fieldId={fieldId} />
      {disabled && reason && <span className="text-[10px] text-[var(--ink-3)] ml-1">{reason}</span>}
    </div>
  )
}

interface TriProps {
  label: string
  value: { mode: TriMode | BetaMode; value: string | null }
  onChange: (next: { mode: TriMode | BetaMode; value: string | null }) => void
  withAppend?: boolean
  authKind: string
  fieldId: string
}
function Tri({ label, value, onChange, withAppend, authKind, fieldId }: TriProps) {
  const setMode = (mode: TriMode | BetaMode) => {
    if (mode === 'omit' || mode === 'passthrough') {
      onChange({ mode, value: null })
    } else {
      onChange({ mode, value: value.value ?? '' })
    }
  }
  return (
    <Field label={`${label}`} hint={authKind === 'oauth' && OAUTH_DANGER[fieldId] ? `⚠ ${OAUTH_DANGER[fieldId]}` : undefined}>
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-[12px]"><input type="radio" checked={value.mode === 'omit'} onChange={() => setMode('omit')} /> omit</label>
        <label className="text-[12px]"><input type="radio" checked={value.mode === 'passthrough'} onChange={() => setMode('passthrough')} /> 透传</label>
        <label className="text-[12px]"><input type="radio" checked={value.mode === 'override'} onChange={() => setMode('override')} /> 覆盖</label>
        {withAppend && (
          <label className="text-[12px]"><input type="radio" checked={value.mode === 'append'} onChange={() => setMode('append')} /> 追加</label>
        )}
        {(value.mode === 'override' || value.mode === 'append') && (
          <Input
            value={value.value ?? ''}
            onChange={(e) => onChange({ ...value, value: e.target.value })}
            placeholder=""
          />
        )}
      </div>
    </Field>
  )
}

const FORBIDDEN_HEADERS = ['authorization', 'x-api-key', 'host', 'cookie', 'content-length', 'connection']

interface Props {
  authKind: 'oauth' | 'api_key'
  value: AccountOptions
  onChange: (next: AccountOptions) => void
}

export default function AccountOptionsForm({ authKind, value, onChange }: Props) {
  const patchValidate = (k: keyof AccountOptions['validate'], v: boolean) =>
    onChange({ ...value, validate: { ...value.validate, [k]: v } })
  const patchClean = (k: keyof AccountOptions['clean'], v: boolean) =>
    onChange({ ...value, clean: { ...value.clean, [k]: v } })
  const patchOverride = <K extends keyof AccountOptions['override']>(k: K, v: AccountOptions['override'][K]) =>
    onChange({ ...value, override: { ...value.override, [k]: v } })

  const extraJson = JSON.stringify(value.override.extraHeaders, null, 2)
  let extraErr: string | null = null
  try {
    const keys = Object.keys(value.override.extraHeaders)
    const bad = keys.find((k) => FORBIDDEN_HEADERS.includes(k.toLowerCase()))
    if (bad) extraErr = `禁止覆盖敏感头:${bad}`
  } catch {}

  return (
    <div className="flex flex-col gap-5">
      <section>
        <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)] pb-2">入站校验</div>
        <div className="grid grid-cols-2 gap-2">
          <Ck label="消息体完整性" checked={value.validate.body} onChange={(v) => patchValidate('body', v)} authKind={authKind} fieldId="validate.body" />
          <Ck label="请求形状" checked={value.validate.shape} onChange={(v) => patchValidate('shape', v)} authKind={authKind} fieldId="validate.shape" />
          <Ck
            label="形状放宽 + 自动补齐"
            checked={value.validate.shapeAutoComplete}
            onChange={(v) => patchValidate('shapeAutoComplete', v)}
            authKind={authKind}
            fieldId="validate.shapeAutoComplete"
            disabled={!value.validate.shape}
            reason={!value.validate.shape ? '(需先开启请求形状校验)' : undefined}
          />
          <Ck
            label="积极伪装 (语义破坏)"
            checked={value.validate.aggressiveDisguise}
            onChange={(v) => patchValidate('aggressiveDisguise', v)}
            authKind={authKind}
            fieldId="validate.aggressiveDisguise"
          />
          <Ck
            label="temperature 规整到 CC"
            checked={value.validate.normalizeTemperature}
            onChange={(v) => patchValidate('normalizeTemperature', v)}
            authKind={authKind}
            fieldId="validate.normalizeTemperature"
          />
          <Ck label="模型白名单" checked={value.validate.model} onChange={(v) => patchValidate('model', v)} authKind={authKind} fieldId="validate.model" />
          <Ck label="拒绝 fast 模式" checked={value.validate.fastMode} onChange={(v) => patchValidate('fastMode', v)} authKind={authKind} fieldId="validate.fastMode" />
          <Ck label="强制流式" checked={value.validate.requireStream} onChange={(v) => patchValidate('requireStream', v)} authKind={authKind} fieldId="validate.requireStream" />
        </div>
        <div className="text-[11px] text-[var(--ink-3)] pt-2">
          (CC 模板绑定不在此显示;由"高级 → CC canonical"派生:开启则要求绑模板,缺模板会立即 503)
        </div>
      </section>

      <section>
        <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)] pb-2">出站清洗</div>
        <div className="grid grid-cols-2 gap-2">
          <Ck label="剥离 CC 伪装头" checked={value.clean.ccHeaders} onChange={(v) => patchClean('ccHeaders', v)} authKind={authKind} fieldId="clean.ccHeaders" />
          <Ck label="剥离 CC beta flag" checked={value.clean.ccBetaFlags} onChange={(v) => patchClean('ccBetaFlags', v)} authKind={authKind} fieldId="clean.ccBetaFlags" />
          <Ck label="清洗 system 文本" checked={value.clean.systemText} onChange={(v) => patchClean('systemText', v)} authKind={authKind} fieldId="clean.systemText" />
          <Ck label="移除 metadata" checked={value.clean.metadata} onChange={(v) => patchClean('metadata', v)} authKind={authKind} fieldId="clean.metadata" />
          <Ck label="截断 tool_use 后多余块" checked={value.clean.toolUseTrailing} onChange={(v) => patchClean('toolUseTrailing', v)} authKind={authKind} fieldId="clean.toolUseTrailing" />
          <Ck label="cache_control ≤4 兜底" checked={value.clean.capCacheControl} onChange={(v) => patchClean('capCacheControl', v)} authKind={authKind} fieldId="clean.capCacheControl" />
          <Ck label="非 CC 工具集规整 (opencode 等)" checked={value.clean.canonicalizeNonCCTools} onChange={(v) => patchClean('canonicalizeNonCCTools', v)} authKind={authKind} fieldId="clean.canonicalizeNonCCTools" />
        </div>
      </section>

      <section>
        <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)] pb-2">出站覆盖</div>
        <div className="flex flex-col gap-2">
          <Tri label="User-Agent" value={value.override.userAgent} onChange={(v) => patchOverride('userAgent', v as AccountOptions['override']['userAgent'])} authKind={authKind} fieldId="override.userAgent" />
          <Tri label="anthropic-version" value={value.override.anthropicVersion} onChange={(v) => patchOverride('anthropicVersion', v as AccountOptions['override']['anthropicVersion'])} authKind={authKind} fieldId="override.anthropicVersion" />
          <Tri label="anthropic-beta" value={value.override.anthropicBeta} onChange={(v) => patchOverride('anthropicBeta', v as AccountOptions['override']['anthropicBeta'])} withAppend authKind={authKind} fieldId="override.anthropicBeta" />
          <Field label='自定义 Header (JSON,如 {"X-Pool-Key": "abc"})'>
            <textarea
              className="w-full px-2 py-1 text-[12px] font-mono border border-[var(--rule)] rounded bg-[var(--bg)] min-h-[80px]"
              value={extraJson}
              onChange={(e) => {
                try {
                  const parsed = JSON.parse(e.target.value || '{}')
                  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    patchOverride('extraHeaders', parsed as Record<string, string>)
                  }
                } catch {}
              }}
            />
            {extraErr && <div className="text-[11px] text-[var(--err)] pt-1">{extraErr}</div>}
          </Field>
        </div>
      </section>

      <section>
        <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)] pb-2">事件 / 日志</div>
        <Ck
          label="模拟 CC 发 event_logging 到 Anthropic"
          checked={value.events.emitTengu}
          onChange={(v) => onChange({ ...value, events: { emitTengu: v } })}
          authKind={authKind}
          fieldId="events.emitTengu"
          disabled={authKind === 'api_key'}
          reason={authKind === 'api_key' ? '(ApiKey 无 OAuth Bearer,event_logging 只接 OAuth)' : undefined}
        />
      </section>

      <section>
        <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)] pb-2">高级</div>
        <Ck
          label="走 CC canonical 改写 (Anthropic /v1/messages)"
          checked={value.canonicalCcMessages}
          onChange={(v) => onChange({ ...value, canonicalCcMessages: v })}
          authKind={authKind}
          fieldId="canonicalCcMessages"
        />
      </section>
    </div>
  )
}
