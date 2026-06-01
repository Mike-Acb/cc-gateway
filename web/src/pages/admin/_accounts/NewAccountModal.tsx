import { useEffect, useMemo, useState } from 'react'
import { api } from '../../../api/client'
import { Modal } from '../../../ui/Modal'
import { Segmented } from '../../../ui/Segmented'
import { Field, Input, Select } from '../../../ui/Field'
import { Button } from '../../../ui/Button'
import { Checkbox } from '../../../ui/Checkbox'
import AccountPolicyFields, { DEFAULT_POLICY, type PolicyValues } from './AccountPolicyFields'
import AccountOptionsForm, { OAUTH_DEFAULT_OPTIONS, APIKEY_DEFAULT_OPTIONS, type AccountOptions } from './AccountOptionsForm'

type AuthKind = 'oauth' | 'api_key'
type Provider = 'anthropic' | 'openai'
type OAuthMode = 'new' | 'import'
type Step = 1 | 2 | 3 | 4

interface OutboundProxy { id: string; name: string }

type TemplateSource = 'manual' | 'cloned' | 'imported'

interface TemplateOption {
  id: string
  name: string
  source: TemplateSource
  source_ua: string | null
  tools_count: number
  is_default: boolean
}

const SOURCE_LABEL: Record<TemplateSource, string> = {
  manual: '手动',
  cloned: '克隆',
  imported: '导入',
}

interface CreatedAccount {
  account_id: string
  name?: string
  email?: string
  account_uuid?: string
}

interface NewAccountModalProps {
  open: boolean
  onClose: () => void
  onSuccess: () => void
}

const STEP_LABELS: Record<Step, string> = { 1: '基础', 2: '凭证', 3: '策略', 4: '结果' }

export default function NewAccountModal({ open, onClose, onSuccess }: NewAccountModalProps) {
  const [step, setStep] = useState<Step>(1)

  // Step 1
  const [authKind, setAuthKind] = useState<AuthKind>('oauth')
  const [provider, setProvider] = useState<Provider>('anthropic')
  const [outboundProxyId, setOutboundProxyId] = useState<string>('')
  const [proxies, setProxies] = useState<OutboundProxy[]>([])

  // Step 2 (OAuth new)
  const [oauthMode, setOauthMode] = useState<OAuthMode>('new')
  const [authUrl, setAuthUrl] = useState<string>('')
  const [pendingId, setPendingId] = useState<string>('')
  const [codeState, setCodeState] = useState<string>('')
  const [copied, setCopied] = useState(false)

  // Step 2 (Import RT / API Key shared)
  const [name, setName] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [apiBaseUrl, setApiBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [simulateFingerprint, setSimulateFingerprint] = useState(false)
  const [options, setOptions] = useState<AccountOptions>(OAUTH_DEFAULT_OPTIONS)

  // Step 3 — policy (editable with defaults)
  const [policy, setPolicy] = useState<PolicyValues>(DEFAULT_POLICY)
  const [templates, setTemplates] = useState<TemplateOption[]>([])
  const [templateId, setTemplateId] = useState<string>('')

  // Step 4 — result
  const [submitting, setSubmitting] = useState(false)
  const [created, setCreated] = useState<CreatedAccount | null>(null)
  const [errMsg, setErrMsg] = useState<string>('')

  // Fetch proxies on mount
  useEffect(() => {
    if (!open) return
    let cancelled = false
    api<{ proxies: OutboundProxy[] }>('/admin/outbound-proxies')
      .then((resp) => { if (!cancelled) setProxies(resp.proxies ?? []) })
      .catch(() => { if (!cancelled) setProxies([]) })
    api<{ items: TemplateOption[] }>('/admin/cc-disguise-templates')
      .then((resp) => {
        if (cancelled) return
        const items = resp.items ?? []
        setTemplates(items)
        // Auto-select the deployment default so the wizard is usable out-of-the-box
        // and we never send an empty cc_template_id (server would 400 anyway).
        const def = items.find((t) => t.is_default)
        if (def) setTemplateId((prev) => prev || def.id)
      })
      .catch(() => { if (!cancelled) setTemplates([]) })
    return () => { cancelled = true }
  }, [open])

  // When OAuth selected, force provider back to anthropic
  useEffect(() => {
    if (authKind === 'oauth' && provider !== 'anthropic') setProvider('anthropic')
  }, [authKind, provider])

  // 切换 authKind 时,把 options 切到对应的默认值
  useEffect(() => {
    setOptions(authKind === 'api_key' ? APIKEY_DEFAULT_OPTIONS : OAUTH_DEFAULT_OPTIONS)
  }, [authKind])

  const dirty = useMemo(() => {
    return !!(outboundProxyId || name || refreshToken || accessToken || apiBaseUrl || apiKey || codeState || authUrl)
  }, [outboundProxyId, name, refreshToken, accessToken, apiBaseUrl, apiKey, codeState, authUrl])

  function resetAll() {
    setStep(1)
    setAuthKind('oauth'); setProvider('anthropic'); setOutboundProxyId('')
    setOauthMode('new'); setAuthUrl(''); setPendingId(''); setCodeState(''); setCopied(false)
    setName(''); setRefreshToken(''); setAccessToken(''); setApiBaseUrl(''); setApiKey('')
    setSimulateFingerprint(false)
    setOptions(OAUTH_DEFAULT_OPTIONS)
    setPolicy(DEFAULT_POLICY)
    setTemplateId('')
    setSubmitting(false); setCreated(null); setErrMsg('')
  }

  function requestClose() {
    if (dirty && !created) {
      const ok = window.confirm('表单尚未保存，确认关闭？')
      if (!ok) return
    }
    resetAll()
    onClose()
  }

  async function genAuthUrl() {
    setSubmitting(true); setErrMsg('')
    try {
      const resp = await api<{ url: string; state: string }>(
        '/admin/oauth-accounts/auth-url',
        {
          method: 'POST',
          body: JSON.stringify({ outbound_proxy_id: outboundProxyId || null, name: name || null }),
        },
      )
      setAuthUrl(resp.url)
      setPendingId(resp.state)
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : '生成授权链接失败')
    } finally {
      setSubmitting(false)
    }
  }

  function policyPayload() {
    return {
      account_type: policy.account_type,
      max_rpm: policy.max_rpm,
      max_tpm: policy.max_tpm,
      max_concurrent: policy.max_concurrent,
      max_sessions: policy.max_sessions,
      session_ttl_seconds: policy.session_ttl_seconds,
      cooldown_seconds: policy.cooldown_seconds,
      max_retries: policy.max_retries,
      max_daily_req: policy.max_daily_req,
      max_daily_tok: policy.max_daily_tok,
      max_daily_cost: policy.max_daily_cost,
      weight: policy.weight,
      options,
    }
  }

  async function exchangeCode() {
    if (!codeState.trim() || !pendingId) return
    setSubmitting(true); setErrMsg('')
    try {
      const resp = await api<{ id: string; email: string | null; account_uuid: string | null; name?: string }>(
        '/admin/oauth-accounts/exchange',
        {
          method: 'POST',
          body: JSON.stringify({
            code: codeState.trim(),
            name: name || undefined,
            cc_template_id: templateId,
            ...policyPayload(),
          }),
        },
      )
      setCreated({
        account_id: resp.id,
        name: resp.name ?? resp.email ?? undefined,
        email: resp.email ?? undefined,
        account_uuid: resp.account_uuid ?? undefined,
      })
      setStep(4)
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : '换取令牌失败')
      setStep(4)
    } finally {
      setSubmitting(false)
    }
  }

  async function importRT() {
    if (!name.trim() || !refreshToken.trim()) return
    setSubmitting(true); setErrMsg('')
    try {
      const resp = await api<{ id: string; email: string | null; account_uuid: string | null }>(
        '/admin/oauth-accounts/import-rt',
        {
          method: 'POST',
          body: JSON.stringify({
            name: name.trim(),
            refresh_token: refreshToken.trim(),
            access_token: accessToken.trim() || undefined,
            outbound_proxy_id: outboundProxyId || null,
            cc_template_id: templateId,
            ...policyPayload(),
          }),
        },
      )
      setCreated({
        account_id: resp.id,
        name,
        email: resp.email ?? undefined,
        account_uuid: resp.account_uuid ?? undefined,
      })
      setStep(4)
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : '导入失败')
      setStep(4)
    } finally {
      setSubmitting(false)
    }
  }

  async function saveApiKey() {
    if (!name.trim() || !apiBaseUrl.trim() || !apiKey.trim()) return
    setSubmitting(true); setErrMsg('')
    try {
      const resp = await api<{ id: string; name: string }>(
        '/admin/oauth-accounts/api-key',
        {
          method: 'POST',
          body: JSON.stringify({
            name: name.trim(),
            provider,
            api_base_url: apiBaseUrl.trim(),
            api_key: apiKey.trim(),
            simulate_fingerprint: simulateFingerprint,
            outbound_proxy_id: outboundProxyId || null,
            ...policyPayload(),
          }),
        },
      )
      setCreated({ account_id: resp.id, name: resp.name })
      setStep(4)
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : '保存失败')
      setStep(4)
    } finally {
      setSubmitting(false)
    }
  }

  // Submit based on auth flow from step 3
  function submit() {
    if (authKind === 'oauth' && oauthMode === 'new') return exchangeCode()
    if (authKind === 'oauth' && oauthMode === 'import') return importRT()
    if (authKind === 'api_key') return saveApiKey()
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(authUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {/* ignore */}
  }

  function finish() {
    resetAll()
    onSuccess()
  }

  const apiKeyPlaceholder = provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'

  // Gate for stepping forward from step 2 into step 3
  const step2Ready = useMemo(() => {
    if (authKind === 'oauth' && oauthMode === 'new') return !!pendingId && !!codeState.trim()
    if (authKind === 'oauth' && oauthMode === 'import') return !!name.trim() && !!refreshToken.trim()
    if (authKind === 'api_key') return !!name.trim() && !!apiBaseUrl.trim() && !!apiKey.trim()
    return false
  }, [authKind, oauthMode, pendingId, codeState, name, refreshToken, apiBaseUrl, apiKey])

  // Footer per step
  let footer: React.ReactNode = null
  if (step === 1) {
    footer = (
      <>
        <Button variant="ghost" size="sm" onClick={requestClose}>取消</Button>
        <Button variant="primary" size="sm" onClick={() => setStep(2)}>下一步 →</Button>
      </>
    )
  } else if (step === 2) {
    footer = (
      <>
        <Button variant="ghost" size="sm" onClick={() => setStep(1)}>← 上一步</Button>
        <Button variant="primary" size="sm" disabled={!step2Ready} onClick={() => setStep(3)}>
          下一步 →
        </Button>
      </>
    )
  } else if (step === 3) {
    // OAuth accounts must carry a cc_template_id — server rejects creation
    // otherwise (fingerprint-leak defence).
    const templateRequired = authKind === 'oauth'
    const submitReady = !submitting && (!templateRequired || !!templateId)
    footer = (
      <>
        <Button variant="ghost" size="sm" onClick={() => setStep(2)}>← 上一步</Button>
        <Button variant="primary" size="sm" disabled={!submitReady} onClick={submit}>
          {submitting ? '提交中…' : '创建'}
        </Button>
      </>
    )
  } else {
    footer = (
      <>
        <Button variant="ghost" size="sm" onClick={() => setStep(3)}>← 上一步</Button>
        {created ? (
          <Button variant="primary" size="sm" onClick={finish}>完成</Button>
        ) : (
          <Button variant="primary" size="sm" onClick={() => { setErrMsg(''); setStep(3) }}>重试</Button>
        )}
      </>
    )
  }

  return (
    <Modal open={open} onClose={requestClose} title="新建账号" footer={footer}>
      {/* Step indicator */}
      <div className="flex items-center justify-center gap-2 pb-3 font-mono text-[11px] flex-wrap">
        {([1, 2, 3, 4] as Step[]).map((n, i) => {
          const active = n === step
          const done = n < step
          return (
            <span key={n} className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-[3px] ${
                  active
                    ? 'bg-[var(--ink)] text-[var(--bg)]'
                    : done
                      ? 'text-[var(--ink-2)]'
                      : 'text-[var(--ink-3)]'
                }`}
              >
                <span>{n}</span>
                <span>{STEP_LABELS[n]}</span>
              </span>
              {i < 3 && <span className="text-[var(--rule)]">——</span>}
            </span>
          )
        })}
      </div>

      {/* Step 1 */}
      {step === 1 && (
        <div className="border-t border-[var(--rule)] pt-4 flex flex-col gap-4">
          <h2 className="font-serif text-[18px] text-[var(--ink)]">基础</h2>
          <Field label="认证方式">
            <div>
              <Segmented<AuthKind>
                options={[
                  { value: 'oauth', label: 'OAuth' },
                  { value: 'api_key', label: 'API Key' },
                ]}
                value={authKind}
                onChange={(v) => setAuthKind(v)}
              />
            </div>
          </Field>
          <Field
            label="上游厂商"
            hint={authKind === 'oauth' ? 'OAuth 模式当前仅支持 Anthropic' : undefined}
          >
            <div className={authKind === 'oauth' ? 'opacity-50 pointer-events-none' : ''}>
              <Segmented<Provider>
                options={[
                  { value: 'anthropic', label: 'Anthropic' },
                  { value: 'openai', label: 'OpenAI' },
                ]}
                value={provider}
                onChange={(v) => setProvider(v)}
              />
            </div>
          </Field>
          <Field label="出站代理（可选）">
            <Select value={outboundProxyId} onChange={(e) => setOutboundProxyId(e.target.value)}>
              <option value="">不走代理</option>
              {proxies.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </Field>
        </div>
      )}

      {/* Step 2 */}
      {step === 2 && (
        <div className="border-t border-[var(--rule)] pt-4 flex flex-col gap-4">
          <h2 className="font-serif text-[18px] text-[var(--ink)]">凭证</h2>

          {authKind === 'oauth' && (
            <>
              <Field label="OAuth 方式">
                <div>
                  <Segmented<OAuthMode>
                    options={[
                      { value: 'new', label: '新登录' },
                      { value: 'import', label: '导入 RT' },
                    ]}
                    value={oauthMode}
                    onChange={(v) => { setOauthMode(v); setErrMsg('') }}
                  />
                </div>
              </Field>

              {oauthMode === 'new' && (
                <>
                  <Field label="账号名（可选）" hint="留空时将自动使用 OAuth 邮箱前缀">
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="留空自动识别" />
                  </Field>
                  <Field label="授权链接">
                    {!authUrl ? (
                      <Button
                        variant="default"
                        size="sm"
                        disabled={submitting}
                        onClick={genAuthUrl}
                      >
                        {submitting ? '生成中…' : '生成授权链接'}
                      </Button>
                    ) : (
                      <div className="flex items-start gap-2">
                        <code className="flex-1 block border border-[var(--rule)] bg-[var(--mute-bg)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--ink)] rounded break-all select-all">
                          {authUrl}
                        </code>
                        <Button variant="default" size="sm" onClick={copyUrl}>
                          {copied ? '已复制' : '复制'}
                        </Button>
                      </div>
                    )}
                  </Field>
                  <Field label="回调 code#state" hint="浏览器授权后，将 URL 里的 code#state 粘贴到这里">
                    <textarea
                      value={codeState}
                      onChange={(e) => setCodeState(e.target.value)}
                      placeholder="code#state"
                      rows={3}
                      className="border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-1.5 font-mono text-[12px] text-[var(--ink)] rounded focus:outline-none focus:border-[var(--ink)] focus:shadow-[0_0_0_3px_rgba(26,26,26,0.06)] transition-shadow resize-y"
                    />
                  </Field>
                </>
              )}

              {oauthMode === 'import' && (
                <>
                  <Field label="账号名">
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Main pool / Team A…" />
                  </Field>
                  <Field label="refresh_token">
                    <Input value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} placeholder="rt_…" />
                  </Field>
                  <Field label="access_token（可选）">
                    <Input value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder="留空则懒刷新" />
                  </Field>
                </>
              )}
            </>
          )}

          {authKind === 'api_key' && (
            <>
              <Field label="账号名">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="account-openai-1" />
              </Field>
              <Field label="API Base URL">
                <Input value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} placeholder={apiKeyPlaceholder} />
              </Field>
              <Field label="API Key">
                <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
              </Field>
              <Field
                label=""
                hint="仅 OAuth 账号会补发 event_logging / session_init 并走 CC 指纹伪装；API-key 直连账号关闭此项也不影响当前透传路径。"
              >
                <Checkbox
                  label="模拟客户端指纹"
                  checked={simulateFingerprint}
                  onChange={(e) => setSimulateFingerprint(e.target.checked)}
                />
              </Field>
              <div className="text-[11px] text-[var(--ink-3)]">
                校验/清洗/覆盖等高级选项在第 3 步策略页配置(已根据账号类型预填默认值)。
              </div>
            </>
          )}

          {errMsg && (
            <div className="border border-[var(--err)] text-[var(--err)] px-2 py-1.5 text-[11px] rounded">
              {errMsg}
            </div>
          )}
        </div>
      )}

      {/* Step 3 — 策略 */}
      {step === 3 && (
        <div className="border-t border-[var(--rule)] pt-4 flex flex-col gap-4">
          <div className="flex items-baseline justify-between">
            <h2 className="font-serif text-[18px] text-[var(--ink)]">策略</h2>
            <span className="font-mono text-[11px] text-[var(--ink-3)]">
              默认值已填充，如需调整可直接修改
            </span>
          </div>
          <AccountPolicyFields value={policy} onChange={setPolicy} compact />
          <div className="border-t border-[var(--rule)] pt-4">
            <div className="font-mono text-[11px] uppercase tracking-wider text-[var(--ink-2)] pb-3">
              账号选项 (校验 / 清洗 / 覆盖 / 事件)
            </div>
            <AccountOptionsForm
              authKind={authKind}
              value={options}
              onChange={setOptions}
            />
          </div>
          {authKind === 'oauth' && (
            <Field
              label="CC 伪装模板 *"
              hint={
                templates.length === 0
                  ? '尚无可用模板。请先到「CC 伪装」页面从 HAR 导入一个 CC 2.1.112 模板。'
                  : '必选：OAuth 账号必须绑定真实的 CC 指纹模板，未绑定账号上游一律拒绝转发。'
              }
            >
              <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">请选择模板</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.is_default ? '★ ' : ''}{t.name} · {SOURCE_LABEL[t.source]} · {t.tools_count} 工具
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {errMsg && (
            <div className="border border-[var(--err)] text-[var(--err)] px-2 py-1.5 text-[11px] rounded">
              {errMsg}
            </div>
          )}
        </div>
      )}

      {/* Step 4 — 结果 */}
      {step === 4 && (
        <div className="border-t border-[var(--rule)] pt-4 flex flex-col gap-4">
          <h2 className="font-serif text-[18px] text-[var(--ink)]">结果</h2>
          {created ? (
            <div className="flex items-start gap-3">
              <span
                aria-hidden
                className="inline-flex items-center justify-center w-7 h-7 rounded-full text-[var(--bg)] text-[14px] shrink-0"
                style={{ background: 'var(--ok)' }}
              >
                ✓
              </span>
              <div className="flex flex-col gap-1">
                <span className="font-serif text-[16px] text-[var(--ink)]">账号创建成功</span>
                <div className="font-mono text-[11px] text-[var(--ink-2)] flex flex-col gap-0.5">
                  {created.name && <span>名称：{created.name}</span>}
                  {created.email && <span>邮箱：{created.email}</span>}
                  <span>ID：{created.account_id}</span>
                  {created.account_uuid && <span>UUID：{created.account_uuid}</span>}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3">
              <span
                aria-hidden
                className="inline-flex items-center justify-center w-7 h-7 rounded-full text-[var(--bg)] text-[14px] shrink-0"
                style={{ background: 'var(--err)' }}
              >
                !
              </span>
              <div className="flex flex-col gap-1">
                <span className="font-serif text-[16px] text-[var(--ink)]">创建失败</span>
                <span className="font-mono text-[11px] text-[var(--ink-2)]">{errMsg || '未知错误'}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
