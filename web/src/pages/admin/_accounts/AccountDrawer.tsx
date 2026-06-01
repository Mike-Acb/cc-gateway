import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../../api/client'
import {
  Drawer,
  Button,
  Checkbox,
  Pill,
  Field,
  Table,
  dialog,
  type Column,
} from '../../../ui'
import { Select } from '../../../ui/Field'
import AccountPolicyFields, { DEFAULT_POLICY, type PolicyValues } from './AccountPolicyFields'
import AccountOptionsForm, { OAUTH_DEFAULT_OPTIONS, APIKEY_DEFAULT_OPTIONS, type AccountOptions } from './AccountOptionsForm'
import {
  RingChart,
  StatusRow,
  BigStat,
  LetterIcon,
  UTIL_COLORS,
  fmtRelative,
  fmtResetIn,
  fmtDuration,
  utilPct,
  type ClaudeUtilization,
} from './parts'

export interface AccountGroup {
  id: string
  name: string
  color?: string | null
}

interface AccountRow {
  id: string
  name: string
  account_type: string | null
  status: string
  health_status: string
  weight: number
  max_rpm: number
  max_tpm: number
  max_concurrent: number
  max_sessions: number
  max_daily_req: number
  max_daily_tok: number
  max_daily_cost: number
  session_ttl_seconds: number
  cooldown_seconds: number
  max_retries: number
  auth_kind?: 'oauth' | 'api_key'
  options?: any
  outbound_proxy_id: string | null
  outbound_proxy_name: string | null
  group_id: string | null
  group_name: string | null
  group_ids?: string[] | null
  expires_at: number | null
  last_used_at: string | null
  last_error: string | null
  total_requests: number | null
  total_tokens: number | null
  total_cost: number | string | null
  canonical_identity: { email?: string; account_uuid?: string } | string | null
  created_at: string
  updated_at: string
}

interface TrendRow { bucket: string; n: number; errors_n: number; ok_n: number }
interface ErrorRow { reason: string; n: number }
interface RecentErrorRow {
  id?: string | number
  created_at: string
  request_model: string | null
  response_status: number | null
  block_reason: string | null
  block_source: string | null
  streaming: boolean | null
  first_token_ms: number | null
}

interface DetailStats {
  concurrent: number
  rpm: number
  tpm: number
  daily_req: number
  daily_tok: number
  daily_cost: number
  active_sessions: number
  cooldown: boolean
  cooldown_reason: string | null
  cooldown_until: string | null
  cooldown_remaining_seconds: number
  errors: number
  claude_utilization: ClaudeUtilization | null
  claude_utilization_updated_at: string | null
}

// Pool-skip event — recorded when pool selector passes over this account
// (concurrent/rpm/tpm/daily limit). Redis-only, newest first, consecutive
// dupes collapsed into `count`. Not in request_logs because the request
// itself doesn't fail (pool moves on to next candidate).
interface SkipLogEntry {
  at: number       // unix ms
  reason: string   // free text like "Blocked by gateway: concurrent 5/5"
  count: number    // consecutive occurrences of this reason
}

interface CostWindows {
  cost_5h: number
  cost_7d: number
  cost_30d: number
  cost_official_5h: number
  cost_official_7d: number
  cost_official_30d: number
  tokens_5h: number
  tokens_7d: number
  tokens_30d: number
  req_5h: number
  req_7d: number
  req_30d: number
}

interface DetailResponse {
  account: AccountRow
  stats: DetailStats
  trend: TrendRow[]
  errors: ErrorRow[]
  recent_errors: RecentErrorRow[]
  cost_windows?: CostWindows
  skip_log?: SkipLogEntry[]
}

interface SessionSlot {
  slot_index: number
  derived_session_id: string | null
  bound_clients: string[]
  reuse_count: number
  last_used_at: string
  created_at: string
  status: 'active' | 'idle'
}

interface SlotHistoryEvent {
  slot_index: number
  action: string
  client_name: string | null
  evicted_client: string | null
  idle_duration_ms: number | null
  reuse_number: number | null
  created_at: string
}

type SlotsData = {
  max_sessions: number
  slots: SessionSlot[]
  history: SlotHistoryEvent[]
}

interface DisguiseStatus {
  status: 'learned' | 'not_learned' | 'no_identity' | 'redis_unavailable'
  source_ua?: string | null
  learned_at?: string | null
  tools_count?: number
  tool_names?: string[]
  system_blocks_count?: number
  using_defaults?: boolean
  template_id?: string | null
  template_name?: string | null
  template_description?: string | null
  template_source?: 'learned' | 'manual' | 'cloned' | null
}

interface TemplateOption {
  id: string
  name: string
  description: string | null
  source: 'learned' | 'manual' | 'cloned'
  source_ua: string | null
  tools_count: number
  system_blocks_count: number
  used_by: number
  updated_at: string
}

function statusTone(status: string): 'ok' | 'mute' | 'err' {
  if (status === 'active') return 'ok'
  if (status === 'disabled') return 'mute'
  return 'err'
}
function statusLabel(status: string): string {
  if (status === 'active') return '正常'
  if (status === 'disabled') return '已停用'
  if (status === 'error') return '异常'
  return status
}
function healthTone(h: string): 'ok' | 'warn' | 'err' | 'mute' {
  if (h === 'healthy') return 'ok'
  if (h === 'failed') return 'err'
  if (h === 'degraded') return 'warn'
  return 'mute'
}

function extractPolicy(a: AccountRow): PolicyValues {
  return {
    account_type: a.account_type ?? DEFAULT_POLICY.account_type,
    weight: a.weight ?? DEFAULT_POLICY.weight,
    max_rpm: a.max_rpm ?? DEFAULT_POLICY.max_rpm,
    max_tpm: a.max_tpm ?? DEFAULT_POLICY.max_tpm,
    max_concurrent: a.max_concurrent ?? DEFAULT_POLICY.max_concurrent,
    max_sessions: a.max_sessions ?? DEFAULT_POLICY.max_sessions,
    session_ttl_seconds: a.session_ttl_seconds ?? DEFAULT_POLICY.session_ttl_seconds,
    cooldown_seconds: a.cooldown_seconds ?? DEFAULT_POLICY.cooldown_seconds,
    max_retries: a.max_retries ?? DEFAULT_POLICY.max_retries,
    max_daily_req: a.max_daily_req ?? DEFAULT_POLICY.max_daily_req,
    max_daily_tok: a.max_daily_tok ?? DEFAULT_POLICY.max_daily_tok,
    max_daily_cost: a.max_daily_cost ?? DEFAULT_POLICY.max_daily_cost,
  }
}

function policyEq(a: PolicyValues, b: PolicyValues): boolean {
  return (Object.keys(a) as (keyof PolicyValues)[]).every((k) => a[k] === b[k])
}

type Tab = 'slots' | 'disguise' | 'errors' | 'policy' | 'groups' | 'credentials'

export default function AccountDrawer({
  accountId,
  groups,
  open,
  onClose,
  onChange,
}: {
  accountId: string | null
  groups: AccountGroup[]
  open: boolean
  onClose: () => void
  onChange: () => void
}) {
  const [detail, setDetail] = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState<null | {
    ok: boolean
    gateway_status?: number
    latency_ms?: number
    preview?: string
    error?: string | null
    selected_account_name?: string
    model?: string
  }>(null)
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])
  const [policy, setPolicy] = useState<PolicyValues>(DEFAULT_POLICY)
  const [initialPolicy, setInitialPolicy] = useState<PolicyValues>(DEFAULT_POLICY)
  const [tab, setTab] = useState<Tab>('slots')
  const [options, setOptions] = useState<AccountOptions>(OAUTH_DEFAULT_OPTIONS)
  const [initialOptions, setInitialOptions] = useState<AccountOptions>(OAUTH_DEFAULT_OPTIONS)
  const [outboundProxyId, setOutboundProxyId] = useState<string>('')
  const [initialOutboundProxyId, setInitialOutboundProxyId] = useState<string>('')
  const [proxies, setProxies] = useState<Array<{ id: string; name: string }>>([])
  const [slotsData, setSlotsData] = useState<SlotsData | null>(null)
  const [disguise, setDisguise] = useState<DisguiseStatus | null>(null)
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null)
  // Credentials tab — loaded on demand, audit-logged each load
  const [credentials, setCredentials] = useState<{
    source_session_key: string | null
    refresh_token: string | null
    access_token: string | null
    expires_at: number | null
    created_at: string | null
    source_proxy_at_import: string | null
    current_proxy: string | null
  } | null>(null)
  const [credentialsRevealed, setCredentialsRevealed] = useState<Set<string>>(new Set())
  const [credentialsLoading, setCredentialsLoading] = useState(false)
  const [credentialsError, setCredentialsError] = useState<string | null>(null)

  // Load full credentials (with audit log written server-side)
  async function loadCredentials() {
    if (!accountId) return
    setCredentialsLoading(true)
    setCredentialsError(null)
    try {
      const data = await api<{
        source_session_key: string | null
        refresh_token: string | null
        access_token: string | null
        expires_at: number | null
        created_at: string | null
        source_proxy_at_import: string | null
        current_proxy: string | null
      }>(`/admin/oauth-accounts/${accountId}/reveal-credentials`, { method: 'POST' })
      setCredentials(data)
      setCredentialsRevealed(new Set())
    } catch (e: any) {
      setCredentialsError(e?.message || '查看凭据失败')
    } finally {
      setCredentialsLoading(false)
    }
  }
  function toggleReveal(key: string) {
    setCredentialsRevealed(prev => {
      const next = new Set(prev)
      if (next.has(key)) { next.delete(key) } else { next.add(key) }
      if (!prev.has(key)) {
        // Auto-hide after 5s
        setTimeout(() => {
          setCredentialsRevealed(p => { const n = new Set(p); n.delete(key); return n })
        }, 5000)
      }
      return next
    })
  }
  function maskCredential(value: string | null): string {
    if (!value) return '—'
    if (value.length <= 20) return value.slice(0, 3) + '***'
    return value.slice(0, 15) + '***' + value.slice(-4)
  }

  const load = useCallback(async () => {
    if (!accountId) return
    setLoading(true)
    setError(null)
    try {
      const data = await api<DetailResponse>(`/admin/oauth-accounts/${accountId}`)
      setDetail(data)
      const ids = Array.isArray(data.account.group_ids)
        ? data.account.group_ids.filter((x): x is string => typeof x === 'string' && x.length > 0)
        : (data.account.group_id ? [data.account.group_id] : [])
      setSelectedGroupIds(ids)
      const p = extractPolicy(data.account)
      setPolicy(p)
      setInitialPolicy(p)
      const opts = (data.account.options ?? (data.account.auth_kind === 'api_key' ? APIKEY_DEFAULT_OPTIONS : OAUTH_DEFAULT_OPTIONS)) as AccountOptions
      setOptions(opts)
      setInitialOptions(opts)
      const opx = data.account.outbound_proxy_id ?? ''
      setOutboundProxyId(opx)
      setInitialOutboundProxyId(opx)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load account')
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    if (!open || !accountId) {
      setDetail(null)
      setSlotsData(null)
      setDisguise(null)
      setTemplates(null)
      return
    }
    void load()
    // 拉出口代理列表给 selector 用
    api<{ proxies: Array<{ id: string; name: string }> }>('/admin/outbound-proxies')
      .then((r) => setProxies(r.proxies ?? []))
      .catch(() => setProxies([]))
  }, [open, accountId, load])

  // Lazy-load tab data as needed
  useEffect(() => {
    if (!open || !accountId) return
    if (tab === 'slots' && slotsData === null) {
      api<SlotsData>(`/admin/oauth-accounts/${accountId}/session-slots`)
        .then((d) => setSlotsData({ ...d, history: d.history ?? [] }))
        .catch(() => setSlotsData({ max_sessions: 0, slots: [], history: [] }))
    }
    if (tab === 'disguise') {
      if (disguise === null) {
        api<DisguiseStatus>(`/admin/oauth-accounts/${accountId}/disguise-status`)
          .then(setDisguise).catch(() => setDisguise({ status: 'not_learned', using_defaults: true }))
      }
      if (templates === null) {
        api<{ items: TemplateOption[] }>('/admin/cc-disguise-templates')
          .then((d) => setTemplates(d.items ?? []))
          .catch(() => setTemplates([]))
      }
    }
  }, [tab, open, accountId, slotsData, disguise, templates])

  async function toggleEnabled() {
    if (!detail || busy) return
    setBusy(true)
    try {
      const next = detail.account.status === 'disabled' ? 'active' : 'disabled'
      await api(`/admin/oauth-accounts/${detail.account.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      })
      await load()
      onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update status')
    } finally {
      setBusy(false)
    }
  }

  async function resetToken() {
    if (!detail || busy) return
    if (!(await dialog.confirm('重置 OAuth token 会强制刷新该账号的凭证，是否继续？', { danger: true }))) return
    setBusy(true)
    try {
      await api(`/admin/oauth-accounts/${detail.account.id}/refresh`, { method: 'POST' })
      await load()
      onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to refresh token')
    } finally {
      setBusy(false)
    }
  }

  async function refreshUsage() {
    if (!detail || busy) return
    setBusy(true)
    try {
      await api(`/admin/oauth-accounts/${detail.account.id}/refresh-usage`, { method: 'POST' })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to refresh usage')
    } finally {
      setBusy(false)
    }
  }

  async function testAccount() {
    if (!detail || busy) return
    setBusy(true)
    setTestResult(null)
    try {
      const r = await api<any>(`/admin/oauth-accounts/${detail.account.id}/test`, { method: 'POST' })
      setTestResult({
        ok: !!r.ok,
        gateway_status: r.gateway_status,
        latency_ms: r.latency_ms,
        preview: r.preview,
        error: r.error,
        selected_account_name: r.selected_account_name,
        model: r.model,
      })
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : 'Test failed' })
    } finally {
      setBusy(false)
    }
  }

  async function clearError() {
    if (!detail || busy) return
    setBusy(true)
    try {
      await api(`/admin/oauth-accounts/${detail.account.id}/clear-error`, { method: 'POST' })
      await load()
      onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to clear error')
    } finally {
      setBusy(false)
    }
  }

  async function deleteAccount() {
    if (!detail || busy) return
    if (!(await dialog.confirm(`确认删除账号「${detail.account.name}」？此操作不可恢复`, { danger: true }))) return
    setBusy(true)
    try {
      await api(`/admin/oauth-accounts/${detail.account.id}`, { method: 'DELETE' })
      onChange()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete account')
    } finally {
      setBusy(false)
    }
  }

  function toggleGroup(gid: string) {
    setSelectedGroupIds((cur) => cur.includes(gid) ? cur.filter((x) => x !== gid) : [...cur, gid])
  }

  async function saveGroups() {
    if (!detail || busy) return
    setBusy(true)
    try {
      await api(`/admin/oauth-accounts/${detail.account.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          group_ids: selectedGroupIds,
          group_id: selectedGroupIds[0] ?? null,
        }),
      })
      await load()
      onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to assign groups')
    } finally {
      setBusy(false)
    }
  }

  async function savePolicy() {
    if (!detail || busy) return
    setBusy(true)
    try {
      const payload: Record<string, unknown> = {
        ...policy,
        options,
        outbound_proxy_id: outboundProxyId || null,
      }
      await api(`/admin/oauth-accounts/${detail.account.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
      await load()
      onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save policy')
    } finally {
      setBusy(false)
    }
  }

  async function clearDisguise() {
    if (!detail || busy) return
    if (!(await dialog.confirm('解除模板绑定？下次请求会重新学习', { danger: false }))) return
    setBusy(true)
    try {
      await api(`/admin/oauth-accounts/${detail.account.id}/disguise-template`, { method: 'DELETE' })
      setDisguise(null)
      setTab('disguise')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to clear disguise')
    } finally {
      setBusy(false)
    }
  }

  async function bindTemplate(templateId: string) {
    if (!detail || busy) return
    setBusy(true)
    try {
      await api(`/admin/oauth-accounts/${detail.account.id}/cc-template`, {
        method: 'PUT',
        body: JSON.stringify({ template_id: templateId }),
      })
      setDisguise(null)
      setTab('disguise')
      onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to bind template')
    } finally {
      setBusy(false)
    }
  }

  const currentGroupIds: string[] = useMemo(() => detail
    ? (Array.isArray(detail.account.group_ids) && detail.account.group_ids.length > 0
        ? detail.account.group_ids
        : (detail.account.group_id ? [detail.account.group_id] : []))
    : [], [detail])

  const groupsDirty = useMemo(() => {
    if (selectedGroupIds.length !== currentGroupIds.length) return true
    const a = [...selectedGroupIds].sort()
    const b = [...currentGroupIds].sort()
    return a.some((v, i) => v !== b[i])
  }, [selectedGroupIds, currentGroupIds])

  const policyDirty = useMemo(
    () => !policyEq(policy, initialPolicy)
      || outboundProxyId !== initialOutboundProxyId
      || JSON.stringify(options) !== JSON.stringify(initialOptions),
    [policy, initialPolicy, outboundProxyId, initialOutboundProxyId, options, initialOptions],
  )

  const accountEmail: string | null = useMemo(() => {
    if (!detail) return null
    const ci = detail.account.canonical_identity
    if (!ci) return null
    if (typeof ci === 'string') {
      try { return (JSON.parse(ci) as any)?.email ?? null } catch { return null }
    }
    return (ci as any)?.email ?? null
  }, [detail])

  const recentColumns: Column<RecentErrorRow>[] = [
    {
      key: 'when',
      header: '时间',
      render: (r) => (
        <span className="font-mono text-[11px] text-[var(--ink-2)]">
          {new Date(r.created_at).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'model',
      header: '模型',
      render: (r) => <span className="font-mono text-[11px]">{r.request_model ?? '-'}</span>,
    },
    {
      key: 'status',
      header: '状态',
      render: (r) => {
        const s = r.response_status ?? 0
        const tone = s >= 500 ? 'err' : s >= 400 ? 'warn' : 'mute'
        return <Pill tone={tone}>{s || '-'}</Pill>
      },
    },
    {
      key: 'reason',
      header: '原因',
      render: (r) => (
        <span className="font-mono text-[11px] text-[var(--ink-2)]">
          {r.block_reason ?? '-'}{r.block_source ? ` (${r.block_source})` : ''}
        </span>
      ),
    },
  ]

  const title = detail ? detail.account.name : '账号详情'

  return (
    <Drawer open={open} title={title} onClose={onClose} width={680}>
      {loading && !detail && (
        <div className="text-[12px] text-[var(--ink-3)]">加载中…</div>
      )}
      {error && (
        <div className="mb-4 border border-[var(--err)] text-[var(--err)] p-2 text-[12px] rounded">
          {error}
        </div>
      )}
      {detail && (
        <div className="space-y-5">
          {/* Header */}
          <section className="flex items-start gap-3">
            <LetterIcon name={detail.account.name} type={detail.account.account_type} size={44} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[17px] font-semibold text-[var(--ink)] truncate">
                  {detail.account.name}
                </span>
                <Pill tone={statusTone(detail.account.status)}>{statusLabel(detail.account.status)}</Pill>
                <Pill tone={healthTone(detail.account.health_status)}>{detail.account.health_status || 'unknown'}</Pill>
                {detail.stats.cooldown && <Pill tone="warn">冷却中</Pill>}
              </div>
              <div className="text-[11px] text-[var(--ink-3)] mt-1 font-mono">
                {detail.account.account_type ?? '-'} · 最后使用 {fmtRelative(detail.account.last_used_at)}
                {accountEmail && <> · {accountEmail}</>}
                {detail.stats.claude_utilization_updated_at && (
                  <> · 用量 {fmtRelative(detail.stats.claude_utilization_updated_at)}更新</>
                )}
              </div>
            </div>
          </section>

          {/* Main grid: rings + realtime */}
          <section className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div className="lg:col-span-2 grid grid-cols-2 sm:grid-cols-4 gap-3">
              <RingChart
                label="5 小时"
                percentage={utilPct(detail.stats.claude_utilization?.five_hour)}
                color={UTIL_COLORS.five_hour}
                resetIn={fmtResetIn(detail.stats.claude_utilization?.five_hour?.resets_at)}
              />
              <RingChart
                label="7 天"
                percentage={utilPct(detail.stats.claude_utilization?.seven_day)}
                color={UTIL_COLORS.seven_day}
                resetIn={fmtResetIn(detail.stats.claude_utilization?.seven_day?.resets_at)}
              />
              <RingChart
                label="Opus"
                percentage={utilPct(detail.stats.claude_utilization?.seven_day_opus)}
                color={UTIL_COLORS.opus}
                resetIn={fmtResetIn(detail.stats.claude_utilization?.seven_day_opus?.resets_at)}
              />
              <RingChart
                label="Sonnet"
                percentage={utilPct(detail.stats.claude_utilization?.seven_day_sonnet)}
                color={UTIL_COLORS.sonnet}
                resetIn={fmtResetIn(detail.stats.claude_utilization?.seven_day_sonnet?.resets_at)}
              />
            </div>
            <div className="bg-[var(--mute-bg)] rounded-lg p-3 space-y-2">
              <div className="text-[10px] font-semibold text-[var(--ink-3)] uppercase tracking-wider mb-1">
                实时状态
              </div>
              <StatusRow
                label="并发"
                value={`${detail.stats.concurrent}${detail.account.max_concurrent > 0 ? ` / ${detail.account.max_concurrent}` : ''}`}
              />
              <StatusRow
                label="RPM"
                value={`${detail.stats.rpm}${detail.account.max_rpm > 0 ? ` / ${detail.account.max_rpm}` : ''}`}
              />
              <StatusRow
                label="TPM"
                value={`${detail.stats.tpm.toLocaleString()}${detail.account.max_tpm > 0 ? ` / ${detail.account.max_tpm.toLocaleString()}` : ''}`}
              />
              <StatusRow
                label="会话"
                value={`${detail.stats.active_sessions}${detail.account.max_sessions > 0 ? ` / ${detail.account.max_sessions}` : ''}`}
              />
              {detail.stats.cooldown && (
                <StatusRow label="冷却剩余" value={fmtDuration(detail.stats.cooldown_remaining_seconds)} />
              )}
              {detail.stats.cooldown && detail.stats.cooldown_reason && (
                <div className="rounded bg-[var(--warn)]/10 text-[var(--warn)] px-2 py-1.5 text-[11px] leading-5">
                  <div className="font-medium">冷却原因</div>
                  <div className="mt-0.5 break-words">{detail.stats.cooldown_reason}</div>
                </div>
              )}
              {!detail.stats.cooldown && detail.account.last_error && (
                <div className="rounded bg-[var(--err)]/10 text-[var(--err)] px-2 py-1.5 text-[11px] leading-5">
                  <div className="font-medium">最近错误</div>
                  <div className="mt-0.5 break-words">{detail.account.last_error}</div>
                </div>
              )}
            </div>
          </section>

          {/* Tabs */}
          <section>
            <div className="flex border-b border-[var(--rule)] flex-wrap">
              <TabButton active={tab === 'slots'} onClick={() => setTab('slots')}>
                Session Slots
                <span className={`ml-1.5 text-[10px] font-mono px-1.5 py-0.5 rounded ${
                  tab === 'slots' ? 'bg-[var(--ink)] text-[var(--bg)]' : 'bg-[var(--mute-bg)] text-[var(--ink-3)]'
                }`}>
                  {(slotsData?.slots.length ?? 0)}/{slotsData?.max_sessions ?? detail.account.max_sessions ?? 0}
                </span>
              </TabButton>
              <TabButton active={tab === 'disguise'} onClick={() => setTab('disguise')}>CC 伪装</TabButton>
              <TabButton active={tab === 'policy'} onClick={() => setTab('policy')}>
                策略{policyDirty && <span className="ml-1 text-[var(--warn)]">•</span>}
              </TabButton>
              <TabButton active={tab === 'groups'} onClick={() => setTab('groups')}>
                分组{groupsDirty && <span className="ml-1 text-[var(--warn)]">•</span>}
              </TabButton>
              <TabButton active={tab === 'errors'} onClick={() => setTab('errors')}>错误</TabButton>
              <TabButton active={tab === 'credentials'} onClick={() => setTab('credentials')}>凭据</TabButton>
            </div>

            <div className="pt-4">
              {tab === 'slots' && (
                <SessionSlotsBody
                  slots={slotsData?.slots ?? []}
                  max={slotsData?.max_sessions ?? detail.account.max_sessions ?? 0}
                  history={slotsData?.history ?? []}
                />
              )}
              {tab === 'disguise' && (
                <DisguiseBody
                  data={disguise}
                  templates={templates}
                  onClear={() => void clearDisguise()}
                  onBind={(id) => void bindTemplate(id)}
                  busy={busy}
                />
              )}
              {tab === 'policy' && (
                <div className="flex flex-col gap-6">
                  <AccountPolicyFields value={policy} onChange={setPolicy} />
                  <div className="border-t border-[var(--rule)] pt-4">
                    <div className="font-mono text-[11px] uppercase tracking-wider text-[var(--ink-2)] pb-3">
                      出口代理
                    </div>
                    <Field label="绑定出口代理(可选)" hint={proxies.length === 0 ? '暂无可用代理 - 先去 系统 → 代理 添加' : undefined}>
                      <Select
                        value={outboundProxyId}
                        onChange={(e) => setOutboundProxyId((e.target as HTMLSelectElement).value)}
                        disabled={proxies.length === 0}
                      >
                        <option value="">不走代理</option>
                        {proxies.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </Select>
                    </Field>
                    {detail.account.outbound_proxy_name && (
                      <div className="text-[11px] text-[var(--ink-3)] pt-1">
                        当前生效:<span className="font-mono">{detail.account.outbound_proxy_name}</span>
                      </div>
                    )}
                  </div>
                  <div className="border-t border-[var(--rule)] pt-4">
                    <div className="font-mono text-[11px] uppercase tracking-wider text-[var(--ink-2)] pb-3">
                      账号选项 (校验 / 清洗 / 覆盖 / 事件)
                    </div>
                    <AccountOptionsForm
                      authKind={(detail.account.auth_kind ?? 'oauth') as 'oauth' | 'api_key'}
                      value={options}
                      onChange={setOptions}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="primary" size="sm" onClick={() => void savePolicy()} disabled={!policyDirty || busy}>
                      {busy ? '保存中…' : '保存'}
                    </Button>
                    {policyDirty && (
                      <Button variant="ghost" size="sm" onClick={() => { setPolicy(initialPolicy); setOptions(initialOptions); setOutboundProxyId(initialOutboundProxyId) }} disabled={busy}>
                        撤销更改
                      </Button>
                    )}
                  </div>
                </div>
              )}
              {tab === 'groups' && (
                <div>
                  <Field label="所属分组" hint="不勾选即共享池；可勾选多个以同时归入多组">
                    <div className="border border-[var(--rule)] rounded p-2 max-h-[180px] overflow-y-auto space-y-1 bg-[var(--bg)]">
                      {groups.length === 0 ? (
                        <div className="text-[11px] text-[var(--ink-3)] px-1 py-1">暂无可选分组。</div>
                      ) : (
                        groups.map((g) => (
                          <label
                            key={g.id}
                            className="flex items-center gap-2 px-1 py-0.5 cursor-pointer hover:bg-[var(--rule-2)] rounded"
                          >
                            <Checkbox
                              checked={selectedGroupIds.includes(g.id)}
                              onChange={() => toggleGroup(g.id)}
                              disabled={busy}
                            />
                            <span className="text-[12px] text-[var(--ink)]">{g.name}</span>
                          </label>
                        ))
                      )}
                    </div>
                  </Field>
                  <div className="mt-2 flex items-center gap-2">
                    <Button variant="primary" size="sm" disabled={busy || !groupsDirty} onClick={() => void saveGroups()}>
                      {busy ? '保存中…' : '保存分组'}
                    </Button>
                    {groupsDirty && (
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setSelectedGroupIds(currentGroupIds)}>
                        撤销更改
                      </Button>
                    )}
                  </div>
                </div>
              )}
              {tab === 'errors' && (
                <div className="space-y-5">
                  {/* Section 1: pool selector skip events (Redis, real-time state) */}
                  <div>
                    <div className="text-[11px] font-medium text-[var(--ink-2)] mb-1.5">
                      池选择跳过（实时）
                    </div>
                    <p className="text-[10px] text-[var(--ink-3)] mb-2 leading-relaxed">
                      选账号时被此账号跳过的原因（concurrent/RPM/TPM/每日限额已达上限）。这些是 <b>池层面的软跳过</b>，请求本身没有失败 —— 池会继续选下一个账号。连续相同原因会合并计数。
                    </p>
                    {(detail.skip_log?.length ?? 0) === 0 ? (
                      <div className="text-[11px] text-[var(--ink-3)] border border-[var(--rule)] rounded px-3 py-2">
                        暂无跳过记录。
                      </div>
                    ) : (
                      <div className="border border-[var(--rule)] rounded divide-y divide-[var(--rule)]">
                        {detail.skip_log!.map((s, i) => (
                          <div key={i} className="px-3 py-1.5 flex items-center justify-between gap-3 text-[11px]">
                            <span className="font-mono text-[var(--ink-3)] shrink-0 tabular-nums">
                              {new Date(s.at).toLocaleString('zh-CN', { hour12: false })}
                            </span>
                            <span className="flex-1 truncate text-[var(--ink-2)]" title={s.reason}>
                              {s.reason}
                            </span>
                            {s.count > 1 && (
                              <span className="shrink-0 font-mono text-[10px] px-1.5 py-[1px] rounded bg-[var(--mute-bg)] text-[var(--ink-2)]">
                                ×{s.count}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Section 2: actual request failures (PG, persisted history) */}
                  <div>
                    <div className="text-[11px] font-medium text-[var(--ink-2)] mb-1.5">
                      请求失败（历史）
                    </div>
                    <p className="text-[10px] text-[var(--ink-3)] mb-2 leading-relaxed">
                      实际绑定到此账号并失败的请求（HTTP ≥ 400 或被网关拦截）。来源：<code className="font-mono">request_logs</code>。
                    </p>
                    <Table<RecentErrorRow>
                      rows={detail.recent_errors}
                      columns={recentColumns}
                      emptyLabel="暂无失败请求。"
                    />
                  </div>
                </div>
              )}
              {tab === 'credentials' && (
                <div className="space-y-3">
                  <div className="text-[11px] text-[var(--ink-3)] leading-relaxed">
                    凭据信息 (导入时记录的 ck / 当前 refresh / access token / 关联代理)。<br/>
                    点击"查看凭据"会在 audit_logs 留下记录,5 秒自动隐藏。
                  </div>
                  {!credentials && (
                    <Button
                      variant="default"
                      size="sm"
                      disabled={credentialsLoading}
                      onClick={() => void loadCredentials()}
                    >
                      {credentialsLoading ? '加载中…' : '查看凭据'}
                    </Button>
                  )}
                  {credentialsError && (
                    <div className="text-[11px] text-[var(--err)]">{credentialsError}</div>
                  )}
                  {credentials && (
                    <div className="space-y-2 border border-[var(--rule)] rounded p-3 text-[11px] font-mono">
                      {([
                        ['source_session_key', '导入 ck', credentials.source_session_key],
                        ['refresh_token', 'Refresh Token', credentials.refresh_token],
                        ['access_token', 'Access Token', credentials.access_token],
                      ] as Array<[string, string, string | null]>).map(([key, label, value]) => (
                        <div key={key} className="flex items-start gap-2">
                          <span className="w-24 shrink-0 text-[var(--ink-3)]">{label}:</span>
                          <span className="flex-1 break-all">
                            {credentialsRevealed.has(key) ? (value || '—') : maskCredential(value)}
                          </span>
                          {value && (
                            <>
                              <button
                                onClick={() => toggleReveal(key)}
                                className="text-[10px] text-[var(--ink-3)] hover:text-[var(--ink)] shrink-0"
                                title={credentialsRevealed.has(key) ? '隐藏' : '显示 (5秒后自动隐藏)'}
                              >
                                {credentialsRevealed.has(key) ? '隐藏' : '查看'}
                              </button>
                              <button
                                onClick={() => { void navigator.clipboard.writeText(value) }}
                                className="text-[10px] text-[var(--ink-3)] hover:text-[var(--ink)] shrink-0"
                                title="复制完整值"
                              >
                                复制
                              </button>
                            </>
                          )}
                        </div>
                      ))}
                      <div className="border-t border-[var(--rule)] pt-2 mt-1 space-y-1 text-[var(--ink-3)]">
                        <div className="flex gap-2">
                          <span className="w-24 shrink-0">导入时间:</span>
                          <span className="flex-1">{credentials.created_at ? new Date(credentials.created_at).toLocaleString('zh-CN', { hour12: false }) : '—'}</span>
                        </div>
                        <div className="flex gap-2">
                          <span className="w-24 shrink-0">Token 过期:</span>
                          <span className="flex-1">{credentials.expires_at ? new Date(credentials.expires_at).toLocaleString('zh-CN', { hour12: false }) : '—'}</span>
                        </div>
                        <div className="flex gap-2">
                          <span className="w-24 shrink-0">导入时代理:</span>
                          <span className="flex-1 break-all">{credentials.source_proxy_at_import || '— (无 / 历史账号未记录)'}</span>
                        </div>
                        <div className="flex gap-2">
                          <span className="w-24 shrink-0">当前代理:</span>
                          <span className="flex-1 break-all">{credentials.current_proxy || '— (无)'}</span>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => { setCredentials(null); setCredentialsRevealed(new Set()) }}
                      >
                        关闭凭据视图
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Footer daily stats */}
          <section className="pt-4 border-t border-[var(--rule)] grid grid-cols-3 gap-4">
            <BigStat label="今日请求" value={detail.stats.daily_req.toLocaleString()} />
            <BigStat label="今日 Token" value={detail.stats.daily_tok.toLocaleString()} />
            <BigStat label="今日费用" value={`$${detail.stats.daily_cost.toFixed(2)}`} />
          </section>

          {/* 历史窗口费用消耗 — 数据源 usage_records (PG 月分区表),与今日 Redis 计数器
              是不同口径:Redis 给即时累计,usage_records 给长时间窗历史。
              双列展示:
                官方价 = Anthropic 真实开支 (cost / billing_multiplier 反推)
                计费价 = 用户视角 (已乘 group multiplier)
              倍率 = 计费价 / 官方价,= 1.000 表示无加成。 */}
          {detail.cost_windows && (
            <CostWindowsCard cw={detail.cost_windows} />
          )}

          {/* Actions */}
          <section className="flex flex-wrap gap-2 pt-4 border-t border-[var(--rule)]">
            <Button variant="default" onClick={() => void toggleEnabled()} disabled={busy}>
              {detail.account.status === 'disabled' ? '启用' : '停用'}
            </Button>
            <Button variant="default" onClick={() => void resetToken()} disabled={busy}>重置 Token</Button>
            <Button variant="default" onClick={() => void refreshUsage()} disabled={busy}>刷新用量</Button>
            <Button variant="default" onClick={() => void testAccount()} disabled={busy}>测试</Button>
            <Button variant="ghost" onClick={() => void clearError()} disabled={busy}>清除错误</Button>
            <div className="ml-auto" />
            <Button variant="ghost" onClick={() => void deleteAccount()} disabled={busy}>删除</Button>
          </section>

          {/* Test result panel */}
          {testResult && (
            <section className="border border-[var(--rule)] rounded p-3 text-[12px]">
              <div className="flex items-center gap-2 mb-2">
                <Pill tone={testResult.ok ? 'ok' : 'err'}>{testResult.ok ? '测试通过' : '测试失败'}</Pill>
                {testResult.gateway_status !== undefined && (
                  <span className="font-mono text-[11px] text-[var(--ink-3)]">HTTP {testResult.gateway_status}</span>
                )}
                {testResult.latency_ms !== undefined && (
                  <span className="font-mono text-[11px] text-[var(--ink-3)]">{testResult.latency_ms}ms</span>
                )}
                {testResult.model && (
                  <span className="font-mono text-[11px] text-[var(--ink-3)]">{testResult.model}</span>
                )}
                <button onClick={() => setTestResult(null)} className="ml-auto text-[11px] text-[var(--ink-3)] hover:text-[var(--ink)]">×</button>
              </div>
              {testResult.preview && (
                <div className="font-mono text-[11px] text-[var(--ink)] bg-[var(--surface-2)] border border-[var(--rule)] p-2 rounded whitespace-pre-wrap break-all max-h-32 overflow-auto">
                  {testResult.preview}
                </div>
              )}
              {testResult.error && (
                <div className="font-mono text-[11px] text-[var(--err)] mt-2 whitespace-pre-wrap break-all">
                  {testResult.error}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </Drawer>
  )
}

function TabButton({ active, onClick, children }: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2 text-[12px] font-medium border-b-2 transition-colors ${
        active
          ? 'border-[var(--ink)] text-[var(--ink)]'
          : 'border-transparent text-[var(--ink-3)] hover:text-[var(--ink)]'
      }`}
    >
      {children}
    </button>
  )
}

function SessionSlotsBody({
  slots, max, history,
}: { slots: SessionSlot[]; max: number; history: SlotHistoryEvent[] }) {
  const [expanded, setExpanded] = useState<number | null>(null)

  if (max === 0) {
    return <div className="text-[12px] text-[var(--ink-3)]">未配置 max_sessions；当前走共享调度</div>
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">
          使用中 {slots.length} / {max}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">
          最近事件 {history.length}
        </span>
      </div>
      <div className="flex gap-[3px] h-[4px] mb-3 rounded overflow-hidden">
        {Array.from({ length: max }, (_, i) => {
          const slot = slots[i]
          const color = !slot
            ? 'var(--rule)'
            : slot.status === 'active' ? 'var(--ok)' : 'var(--warn)'
          return <div key={i} className="flex-1 rounded" style={{ background: color }} />
        })}
      </div>

      {slots.length === 0 && (
        <div className="text-[11px] text-[var(--ink-3)] mb-2">暂无活跃会话槽</div>
      )}

      {slots.map((slot) => {
        const open = expanded === slot.slot_index
        const slotHist = history.filter((h) => h.slot_index === slot.slot_index)
        return (
          <div key={slot.slot_index} className="mb-1">
            <button
              type="button"
              onClick={() => setExpanded(open ? null : slot.slot_index)}
              className={`w-full text-left rounded px-2 py-1.5 flex items-center gap-2 transition-colors ${
                open ? 'bg-[var(--surface-2)] border border-[var(--rule)]' : 'bg-[var(--mute-bg)] hover:bg-[var(--surface-2)]'
              }`}
            >
              <span className="font-mono text-[10px] text-[var(--ink-3)] border border-[var(--rule)] rounded w-[18px] h-[18px] flex items-center justify-center bg-[var(--surface)] shrink-0">
                {slot.slot_index}
              </span>
              <span
                className="w-[6px] h-[6px] rounded-full shrink-0"
                style={{ background: slot.status === 'active' ? 'var(--ok)' : 'var(--warn)' }}
              />
              <span className="font-mono text-[11px] text-[var(--ink-2)] flex-1 truncate">
                {slot.derived_session_id ?? '-'}
              </span>
              <span className="font-mono text-[10px] text-[var(--ink-3)] tabular-nums shrink-0">
                复用×{slot.reuse_count}
              </span>
              <span
                className="font-mono text-[10px] shrink-0"
                style={{ color: slot.status === 'active' ? 'var(--ok)' : 'var(--ink-3)' }}
              >
                {fmtRelative(slot.last_used_at)}
              </span>
              <span className="font-mono text-[10px] text-[var(--ink-3)] shrink-0">
                {open ? '▾' : '▸'}
              </span>
            </button>
            {open && (
              <div className="mt-1 pl-[26px] pr-2 pb-2 space-y-1 text-[11px]">
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[var(--ink-3)]">
                  <span>创建 {fmtRelative(slot.created_at)}</span>
                  <span>状态 {slot.status}</span>
                </div>
                {slot.bound_clients.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {slot.bound_clients.map((c, i) => (
                      <span key={i} className="font-mono text-[10px] bg-[var(--mute-bg)] text-[var(--ink-2)] px-1.5 py-0.5 rounded">
                        {c}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="text-[var(--ink-3)]">无绑定客户端</div>
                )}
                {slotHist.length > 0 ? (
                  <div className="border-t border-[var(--rule)] pt-1 space-y-0.5">
                    <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">历史事件</div>
                    {slotHist.slice(0, 10).map((h, i) => (
                      <div key={i} className="flex gap-2 font-mono text-[10px] text-[var(--ink-2)]">
                        <span className="text-[var(--ink-3)] w-[70px] shrink-0">{fmtRelative(h.created_at)}</span>
                        <span className="font-medium w-[60px] shrink-0">{h.action}</span>
                        <span className="truncate flex-1">
                          {h.client_name ?? ''}
                          {h.evicted_client ? ` ← ${h.evicted_client}` : ''}
                          {h.reuse_number ? ` · reuse#${h.reuse_number}` : ''}
                          {h.idle_duration_ms ? ` · idle ${(h.idle_duration_ms / 1000).toFixed(1)}s` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[var(--ink-3)]">无历史事件</div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

const SOURCE_LABEL: Record<'learned' | 'manual' | 'cloned', string> = {
  learned: '学习',
  manual: '手动',
  cloned: '克隆',
}

function DisguiseBody({ data, templates, onClear, onBind, busy }: {
  data: DisguiseStatus | null
  templates: TemplateOption[] | null
  onClear: () => void
  onBind: (id: string) => void
  busy: boolean
}) {
  const [pickerId, setPickerId] = useState<string>('')

  if (!data) return <div className="text-[12px] text-[var(--ink-3)]">加载中…</div>
  if (data.status === 'no_identity') {
    return <div className="text-[12px] text-[var(--ink-3)]">账号未同步身份信息，无法启用伪装</div>
  }

  const bound = data.status === 'learned' && !!data.template_id
  const opts = templates ?? []
  const current = bound ? opts.find((t) => t.id === data.template_id) : null

  return (
    <div className="space-y-4 text-[12px]">
      {bound ? (
        <div className="rounded border border-[var(--rule)] bg-[var(--mute-bg)] p-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-[var(--ink)]">{data.template_name ?? current?.name ?? '未命名'}</span>
            {data.template_source && (
              <Pill tone={data.template_source === 'learned' ? 'ok' : data.template_source === 'manual' ? 'mute' : 'warn'}>
                {SOURCE_LABEL[data.template_source]}
              </Pill>
            )}
          </div>
          {data.template_description && (
            <div className="text-[11px] text-[var(--ink-3)]">{data.template_description}</div>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-[var(--ink-2)]">
            {data.source_ua && <span>UA: {data.source_ua}</span>}
            {data.learned_at && <span>学习于 {fmtRelative(data.learned_at)}</span>}
            <span>工具 {data.tools_count ?? 0}</span>
            <span>system 块 {data.system_blocks_count ?? 0}</span>
          </div>
          {data.tool_names && data.tool_names.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {data.tool_names.map((n) => (
                <span key={n} className="font-mono text-[10px] bg-[var(--surface)] border border-[var(--rule)] px-1.5 py-0.5 rounded">
                  {n}
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="text-[12px]" style={{ color: 'var(--err)' }}>
          尚未绑定模板 · 上游将拒绝转发（防止指纹泄漏），请立即手动绑定
        </div>
      )}

      <div>
        <div className="text-[10px] font-semibold text-[var(--ink-3)] uppercase tracking-wider mb-1.5">
          {bound ? '切换为已存模板' : '绑定已存模板'}
        </div>
        {templates === null ? (
          <div className="text-[11px] text-[var(--ink-3)]">加载模板中…</div>
        ) : opts.length === 0 ? (
          <div className="text-[11px] text-[var(--ink-3)]">暂无可用模板</div>
        ) : (
          <div className="flex items-center gap-2">
            <select
              value={pickerId}
              onChange={(e) => setPickerId(e.target.value)}
              disabled={busy}
              className="flex-1 h-8 px-2 border border-[var(--rule)] bg-[var(--surface)] text-[12px] rounded"
            >
              <option value="">选择模板…</option>
              {opts.map((t) => (
                <option key={t.id} value={t.id} disabled={t.id === data.template_id}>
                  {t.name} · {SOURCE_LABEL[t.source]} · {t.tools_count} 工具
                  {t.id === data.template_id ? ' (当前)' : ''}
                </option>
              ))}
            </select>
            <Button
              variant="primary"
              size="sm"
              onClick={() => pickerId && onBind(pickerId)}
              disabled={busy || !pickerId || pickerId === data.template_id}
            >
              绑定
            </Button>
          </div>
        )}
      </div>

      {bound && (
        <div>
          <Button variant="ghost" size="sm" onClick={onClear} disabled={busy}>
            解除绑定
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * 历史额度消耗:5h / 7d / 30d 三个时间窗,列出请求数 / Token / 官方价 / 计费价 / 倍率。
 * 数据源 usage_records (PG 月分区);跟今日 Redis 计数器是不同口径。
 *
 * UI 设计:
 *  - 表格化布局优于之前的 3 列卡片 — 同窗口的指标横向对齐,便于纵向比较趋势 (5h<7d<30d)
 *  - 官方价 用 ink-2 弱化 (Anthropic 真实开支,内部对账用)
 *  - 计费价 用 ink 强化 + tabular-nums (用户视角的网关收款)
 *  - 倍率 仅在 ≠1.0 时以 Pill 显示,默认无 group / 共享池场景 (= 1.000) 隐藏
 */
function CostWindowsCard({ cw }: { cw: CostWindows }) {
  const rows: Array<{ label: string; req: number; tok: number; off: number; bill: number }> = [
    { label: '最近 5 小时', req: cw.req_5h, tok: cw.tokens_5h, off: cw.cost_official_5h, bill: cw.cost_5h },
    { label: '最近 7 天', req: cw.req_7d, tok: cw.tokens_7d, off: cw.cost_official_7d, bill: cw.cost_7d },
    { label: '最近 30 天', req: cw.req_30d, tok: cw.tokens_30d, off: cw.cost_official_30d, bill: cw.cost_30d },
  ]
  const fmtMul = (off: number, bill: number): string | null => {
    if (off <= 0) return null
    const m = bill / off
    if (Math.abs(m - 1) < 0.001) return null
    return m.toFixed(3) + '×'
  }
  const fmtNum = (n: number) => n.toLocaleString()

  return (
    <section className="pt-4 border-t border-[var(--rule)]">
      <div className="flex items-baseline justify-between pb-2">
        <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">
          历史额度消耗
        </div>
        <div className="text-[10px] text-[var(--ink-3)]">
          来源 <code className="font-mono">usage_records</code> · 官方价 = Anthropic 真实开支 · 计费价 = 已乘 group 倍率
        </div>
      </div>
      <div className="rounded-md border border-[var(--rule)] overflow-hidden">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="bg-[var(--mute-bg)] text-[var(--ink-3)] font-mono uppercase tracking-wider text-[10px]">
              <th className="text-left px-3 py-2 font-medium">窗口</th>
              <th className="text-right px-3 py-2 font-medium">请求</th>
              <th className="text-right px-3 py-2 font-medium">Token</th>
              <th className="text-right px-3 py-2 font-medium">官方价</th>
              <th className="text-right px-3 py-2 font-medium">计费价</th>
              <th className="text-right px-3 py-2 font-medium">倍率</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const mul = fmtMul(r.off, r.bill)
              return (
                <tr
                  key={r.label}
                  className={i < rows.length - 1 ? 'border-b border-[var(--rule-2)]' : ''}
                >
                  <td className="px-3 py-2 text-[var(--ink-2)]">{r.label}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-mono text-[var(--ink-2)]">{fmtNum(r.req)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-mono text-[var(--ink-2)]">{fmtNum(r.tok)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-mono text-[var(--ink-3)]">${r.off.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-mono font-medium text-[var(--ink)]">${r.bill.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right">
                    {mul ? (
                      <span className="font-mono tabular-nums text-[10px] px-1.5 py-0.5 rounded bg-[var(--mute-bg)] text-[var(--ink-2)]">
                        {mul}
                      </span>
                    ) : (
                      <span className="font-mono tabular-nums text-[10px] text-[var(--ink-3)]">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
