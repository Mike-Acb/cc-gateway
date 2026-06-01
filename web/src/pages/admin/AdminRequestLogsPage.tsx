import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../../api/client'
import {
  Button,
  Checkbox,
  Field,
  GroupPill,
  Input,
  Pill,
  Segmented,
  Select,
  Table,
  dialog,
  type Column,
} from '../../ui'

type StatusFilter = 'all' | 'success' | 'error'
type BlockSourceFilter = '' | 'gw' | 'up'
type StreamingFilter = '' | 'true' | 'false'
type SectionKey =
  | 'requestHeadersIn'
  | 'requestHeadersOut'
  | 'requestBodyIn'
  | 'requestBodyOut'
  | 'responseHeaders'
  | 'responseBody'

const JSON_EXPAND_THRESHOLD = 10000

interface FiltersState {
  user_email: string
  client_name: string
  oauth_account_name: string
  group_id: string
  model: string
  status: StatusFilter
  block_source: BlockSourceFilter
  streaming: StreamingFilter
  block_reason: string[]
  since: string
  until: string
}

interface GroupOption {
  id: string
  name: string
}

const BLOCK_REASONS: { value: string; label: string }[] = [
  { value: 'rate_limited', label: '限流' },
  { value: 'plan_forbidden_model', label: '套餐禁模型' },
  { value: 'quota_exceeded', label: '配额耗尽' },
  { value: 'auth_missing', label: '缺失鉴权' },
  { value: 'malformed_block', label: '格式错误' },
  { value: 'upstream_5xx', label: '上游 5xx' },
  { value: 'upstream_429', label: '上游 429' },
]

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'success', label: '成功' },
  { value: 'error', label: '错误' },
]

const BLOCK_SOURCE_OPTIONS: { value: BlockSourceFilter; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'gw', label: '网关' },
  { value: 'up', label: '上游' },
]

const STREAMING_OPTIONS: { value: StreamingFilter; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'true', label: '流式' },
  { value: 'false', label: '非流式' },
]

interface RequestLogListItem {
  id: string
  trace_id: string | null
  operation_id: string | null
  root_trace_id: string | null
  parent_trace_id: string | null
  is_root: boolean
  request_family_in: string | null
  request_family_out: string | null
  shape_profile_in: string | null
  shape_profile_out: string | null
  client_name: string | null
  oauth_account_name: string | null
  selected_group_id: string | null
  selected_group_name: string | null
  selected_group_color: string | null
  method: string | null
  path: string | null
  request_model: string | null
  response_status: number | null
  latency_ms: number | null
  error_message: string | null
  created_at: string
  client_ip: string | null
  streaming: boolean | null
  block_reason: string | null
  block_source: string | null
}

interface RequestLogDetail extends RequestLogListItem {
  related_trace_ids: unknown
  session_key: string | null
  shape_confidence_in: number | null
  shape_confidence_out: number | null
  shape_reason: unknown
  client_id: string | null
  oauth_account_id: string | null
  request_body: string | null
  response_body: string | null
  retry_count: number
  request_headers_in: unknown
  request_headers_out: unknown
  request_body_out: string | null
  response_headers: unknown
}

interface RequestLogsResponse {
  logs: RequestLogListItem[]
  total: number
  page: number
  limit: number
}

const DEFAULT_FILTERS: FiltersState = {
  user_email: '',
  client_name: '',
  oauth_account_name: '',
  group_id: '',
  model: '',
  status: 'all',
  block_source: '',
  streaming: '',
  block_reason: [],
  since: '',
  until: '',
}

const DEFAULT_SECTIONS: Record<SectionKey, boolean> = {
  requestHeadersIn: true,
  requestHeadersOut: true,
  requestBodyIn: true,
  requestBodyOut: true,
  responseHeaders: true,
  responseBody: true,
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function truncateText(value: string | null | undefined, max = 60): string {
  if (!value) return '-'
  return value.length > max ? `${value.slice(0, max)}...` : value
}

function truncatePath(value: string | null | undefined, max = 72): string {
  if (!value) return '-'
  return value.length > max ? `${value.slice(0, max)}...` : value
}

function shapeLabel(row: RequestLogListItem): string {
  return row.shape_profile_out || row.shape_profile_in || row.request_family_out || row.request_family_in || '-'
}

function toIso(datetimeLocal: string): string {
  if (!datetimeLocal) return ''
  const d = new Date(datetimeLocal)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

function buildQueryString(filters: FiltersState, page: number, limit: number): string {
  const params = new URLSearchParams()
  params.set('page', String(page))
  params.set('limit', String(limit))

  if (filters.user_email.trim()) params.set('user_email', filters.user_email.trim())
  if (filters.client_name.trim()) params.set('client_name', filters.client_name.trim())
  if (filters.oauth_account_name.trim()) params.set('oauth_account_name', filters.oauth_account_name.trim())
  if (filters.group_id) params.set('group_id', filters.group_id)
  if (filters.model.trim()) params.set('model', filters.model.trim())
  if (filters.status !== 'all') params.set('status', filters.status)
  if (filters.block_source) params.set('block_source', filters.block_source)
  if (filters.streaming) params.set('streaming', filters.streaming)
  if (filters.block_reason.length > 0) params.set('block_reason', filters.block_reason.join(','))
  const sinceIso = toIso(filters.since)
  if (sinceIso) params.set('since', sinceIso)
  const untilIso = toIso(filters.until)
  if (untilIso) params.set('until', untilIso)

  return params.toString()
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''

  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function statusPill(status: number | null | undefined): ReactNode {
  if (status === null || status === undefined || status === 0) {
    return <Pill tone="err">日志丢失</Pill>
  }
  if (status >= 200 && status < 300) return <Pill tone="ok">{status}</Pill>
  return <Pill tone="err">{status}</Pill>
}

const BLOCK_REASON_LABELS: Record<string, string> = {
  rate_limited: '限流',
  plan_forbidden_model: '禁模型',
  quota_exceeded: '配额',
  auth_missing: '缺鉴权',
  malformed_block: '格式错误',
  upstream_5xx: '上游5xx',
  upstream_429: '上游429',
}

function Section({
  title,
  open,
  onToggle,
  action,
  children,
}: {
  title: string
  open: boolean
  onToggle: () => void
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section
      className={`border border-[var(--rule)] rounded bg-[var(--surface)] overflow-hidden flex flex-col min-h-0 ${open ? 'flex-1' : 'shrink-0'}`}
    >
      <div className="flex items-center justify-between px-3 py-2 bg-[var(--rule-2)] border-b border-[var(--rule)] shrink-0">
        <button type="button" onClick={onToggle} className="flex items-center gap-2 text-left">
          <span className="text-[12px] font-medium text-[var(--ink)]">{title}</span>
          <span className="text-[10px] text-[var(--ink-3)] font-mono uppercase">{open ? '收起' : '展开'}</span>
        </button>
        {action}
      </div>
      {open && <div className="p-3 flex-1 min-h-0 overflow-auto">{children}</div>}
    </section>
  )
}

function JsonDisplay({ value }: { value: unknown }) {
  const text = formatJson(value)
  const large = text.length > JSON_EXPAND_THRESHOLD
  const [expanded, setExpanded] = useState(!large)

  useEffect(() => {
    setExpanded(!large)
  }, [text, large])

  if (!text) {
    return <div className="text-[12px] text-[var(--ink-3)]">暂无数据</div>
  }

  if (large && !expanded) {
    return (
      <div className="flex flex-col gap-2">
        <div className="text-[12px] text-[var(--ink-3)]">
          内容较大（{text.length.toLocaleString()} 字符），默认已折叠。
        </div>
        <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
          点击展开
        </Button>
      </div>
    )
  }

  return (
    <pre className="font-mono text-[11px] bg-[var(--rule-2)] rounded p-3 whitespace-pre-wrap break-all overflow-auto text-[var(--ink)] h-full min-h-0">
      {text}
    </pre>
  )
}

function KpiCell({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div
      className={`flex flex-col gap-0.5 px-3 py-1.5 rounded bg-[var(--rule-2)] ${wide ? 'min-w-[340px] max-w-[520px]' : 'min-w-[120px]'}`}
    >
      <span className="text-[10px] text-[var(--ink-3)] uppercase tracking-wide font-mono">{label}</span>
      <div className="text-[12px] text-[var(--ink)] min-w-0">{children}</div>
    </div>
  )
}

function OutboundBody({ inbound, outbound }: { inbound: string | null; outbound: string | null }) {
  const same = inbound === outbound
  const [forceShow, setForceShow] = useState(false)

  useEffect(() => {
    setForceShow(false)
  }, [inbound, outbound])

  if (same && !forceShow) {
    return (
      <div className="flex flex-col gap-2">
        <div className="text-[12px] text-[var(--ink-3)]">与入站相同</div>
        <Button variant="ghost" size="sm" onClick={() => setForceShow(true)}>
          仍然显示
        </Button>
      </div>
    )
  }

  return <JsonDisplay value={outbound} />
}

export default function AdminRequestLogsPage() {
  const [filters, setFilters] = useState<FiltersState>(DEFAULT_FILTERS)
  const [appliedFilters, setAppliedFilters] = useState<FiltersState>(DEFAULT_FILTERS)
  const [groups, setGroups] = useState<GroupOption[]>([])
  const [logs, setLogs] = useState<RequestLogListItem[]>([])
  const [page, setPage] = useState(1)
  const [limit] = useState(50)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null)
  const [selectedLog, setSelectedLog] = useState<RequestLogDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [sections, setSections] = useState<Record<SectionKey, boolean>>(DEFAULT_SECTIONS)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const totalPages = Math.max(1, Math.ceil(total / limit))

  const loadLogs = async (activeFilters: FiltersState, activePage: number) => {
    setLoading(true)
    setError(null)
    try {
      const queryString = buildQueryString(activeFilters, activePage, limit)
      const data = await api<RequestLogsResponse>(`/admin/request-logs?${queryString}`)
      setLogs(data.logs)
      setTotal(data.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  const loadDetail = async (id: string) => {
    setSelectedLogId(id)
    setSelectedLog(null)
    setDetailLoading(true)
    setDetailError(null)
    setSections({ ...DEFAULT_SECTIONS })
    setCopiedKey(null)

    try {
      const data = await api<RequestLogDetail>(`/admin/request-logs/${id}`)
      setSelectedLog(data)
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : '加载详情失败')
    } finally {
      setDetailLoading(false)
    }
  }

  useEffect(() => {
    void loadLogs(appliedFilters, page)
  }, [appliedFilters, page, limit])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await api<{ items: GroupOption[] }>('/admin/groups')
        if (!cancelled) setGroups(data.items ?? [])
      } catch { /* groups dropdown 拿不到不阻塞主表 */ }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = window.setInterval(() => {
      void loadLogs(appliedFilters, page)
    }, 15000)
    return () => window.clearInterval(timer)
  }, [autoRefresh, appliedFilters, page, limit])

  const modalOpen = Boolean(selectedLogId || detailLoading || detailError)
  useEffect(() => {
    if (!modalOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [modalOpen])

  const handleSearch = () => {
    setPage(1)
    setAppliedFilters({ ...filters })
  }

  const handleReset = () => {
    setFilters(DEFAULT_FILTERS)
    setPage(1)
    setAppliedFilters(DEFAULT_FILTERS)
  }

  const handleClearAll = async () => {
    if (!(await dialog.confirm('确定清空所有请求日志？此操作不可恢复。', { danger: true }))) return
    try {
      const result = await api<{ deleted: number }>('/admin/request-logs', { method: 'DELETE' })
      await dialog.alert(`已清空 ${result.deleted} 条日志`)
      loadLogs(appliedFilters, page)
    } catch (err) {
      await dialog.alert('清空失败: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  const closeModal = () => {
    setSelectedLogId(null)
    setSelectedLog(null)
    setDetailError(null)
    setDetailLoading(false)
    setCopiedKey(null)
  }

  useEffect(() => {
    if (!modalOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeModal()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modalOpen])

  const toggleSection = (key: SectionKey) => {
    setSections(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const handleCopy = async (key: string, value: unknown) => {
    const text = formatJson(value)
    if (!text) return
    await navigator.clipboard.writeText(text)
    setCopiedKey(key)
    window.setTimeout(() => {
      setCopiedKey(current => (current === key ? null : current))
    }, 1500)
  }

  const columns: Column<RequestLogListItem>[] = [
    {
      key: 'created_at',
      header: '时间',
      className: 'whitespace-nowrap tabular-nums text-[var(--ink-2)]',
      render: (r) => formatDateTime(r.created_at),
    },
    {
      key: 'client',
      header: '客户端',
      render: (r) => r.client_name || <span className="text-[var(--ink-3)]">-</span>,
    },
    {
      key: 'account',
      header: '账号',
      render: (r) => r.oauth_account_name || <span className="text-[var(--ink-3)]">-</span>,
    },
    {
      key: 'group',
      header: '分组',
      // 4-6 字 CJK 单行不折,组件 whitespace-nowrap;列本身给 min-width 让表格布局留位
      className: 'whitespace-nowrap',
      style: { minWidth: '96px' },
      render: (r) => (
        <GroupPill
          id={r.selected_group_id}
          name={r.selected_group_name}
          color={r.selected_group_color}
        />
      ),
    },
    {
      key: 'operation',
      header: '操作 / 形态',
      className: 'max-w-[260px]',
      render: (r) => (
        <div className="flex flex-col gap-1 min-w-0">
          <div className="flex items-center gap-1">
            <Pill tone={r.is_root ? 'info' : 'mute'}>{r.is_root ? 'root' : 'child'}</Pill>
            {(r.request_family_out || r.request_family_in) && (
              <span className="font-mono text-[10px] text-[var(--ink-2)]">
                {r.request_family_out || r.request_family_in}
              </span>
            )}
          </div>
          <span className="truncate text-[11px] text-[var(--ink-2)]" title={shapeLabel(r)}>
            {shapeLabel(r)}
          </span>
          {r.operation_id && (
            <span className="truncate font-mono text-[10px] text-[var(--ink-3)]" title={r.operation_id}>
              {r.operation_id}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'path',
      header: '方法 + 路径',
      className: 'max-w-[420px]',
      render: (r) => (
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[var(--rule-2)] text-[var(--ink-2)] shrink-0">
            {r.method || '-'}
          </span>
          {r.streaming === true ? (
            <span
              className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-[var(--ink-2)] text-[var(--ink)] shrink-0"
              title="流式响应"
            >
              流
            </span>
          ) : r.streaming === false ? (
            <span
              className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-[var(--rule)] text-[var(--ink-3)] shrink-0"
              title="非流式"
            >
              静
            </span>
          ) : null}
          <span className="truncate text-[var(--ink)]" title={r.path || ''}>
            {truncatePath(r.path)}
          </span>
        </div>
      ),
    },
    {
      key: 'model',
      header: '模型',
      className: 'max-w-[220px]',
      render: (r) => (
        <span className="block truncate" title={r.request_model || ''}>
          {r.request_model || <span className="text-[var(--ink-3)]">-</span>}
        </span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      render: (r) => (
        <div className="flex items-center gap-1">
          {statusPill(r.response_status)}
          {r.block_source === 'gw' && (
            <span title="网关拦截"><Pill tone="warn">网关</Pill></span>
          )}
          {r.block_source === 'up' && (
            <span title="上游拦截"><Pill tone="err">上游</Pill></span>
          )}
          {r.block_reason && (
            <span
              className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[var(--rule-2)] text-[var(--ink-2)]"
              title={r.block_reason}
            >
              {BLOCK_REASON_LABELS[r.block_reason] ?? r.block_reason}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'latency',
      header: '延迟',
      className: 'whitespace-nowrap tabular-nums',
      render: (r) => (r.latency_ms !== null ? `${r.latency_ms} ms` : <span className="text-[var(--ink-3)]">-</span>),
    },
    {
      key: 'error',
      header: '错误',
      className: 'max-w-[280px]',
      render: (r) => (
        <span className="block truncate text-[var(--err)]" title={r.error_message || ''}>
          {r.error_message ? truncateText(r.error_message, 60) : <span className="text-[var(--ink-3)]">-</span>}
        </span>
      ),
    },
  ]

  return (
    <div className="max-w-[1440px] mx-auto p-6 space-y-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold text-[var(--ink)]">请求日志</h1>
          <p className="mt-1 text-[13px] text-[var(--ink-3)]">按时间查看请求记录、状态、延迟与入/出站完整报文。</p>
        </div>
        <Checkbox
          label="自动刷新"
          checked={autoRefresh}
          onChange={event => setAutoRefresh(event.target.checked)}
        />
      </header>

      <div className="flex gap-6">
        <aside className="w-[260px] shrink-0 self-start sticky top-4 border border-[var(--rule)] bg-[var(--surface)] rounded p-4 space-y-4 text-[12px] max-h-[calc(100vh-2rem)] overflow-y-auto">
          <h3 className="text-[10px] uppercase tracking-[0.14em] font-mono text-[var(--ink-3)]">过滤条件</h3>

          <Field label="用户邮箱">
            <Input
              value={filters.user_email}
              onChange={event => setFilters(prev => ({ ...prev, user_email: event.target.value }))}
              placeholder="模糊匹配"
            />
          </Field>
          <Field label="客户端">
            <Input
              value={filters.client_name}
              onChange={event => setFilters(prev => ({ ...prev, client_name: event.target.value }))}
              placeholder="客户端名称"
            />
          </Field>
          <Field label="OAuth 账号">
            <Input
              value={filters.oauth_account_name}
              onChange={event => setFilters(prev => ({ ...prev, oauth_account_name: event.target.value }))}
              placeholder="账号名"
            />
          </Field>
          <Field label="分组">
            <Select
              value={filters.group_id}
              onChange={event => setFilters(prev => ({ ...prev, group_id: event.target.value }))}
            >
              <option value="">全部</option>
              <option value="__none__">共享池（无分组）</option>
              {groups.map(g => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="模型">
            <Input
              value={filters.model}
              onChange={event => setFilters(prev => ({ ...prev, model: event.target.value }))}
              placeholder="模型名包含"
            />
          </Field>

          <Field label="状态">
            <Segmented<StatusFilter>
              options={STATUS_OPTIONS}
              value={filters.status}
              onChange={v => setFilters(prev => ({ ...prev, status: v }))}
            />
          </Field>
          <Field label="来源">
            <Segmented<BlockSourceFilter>
              options={BLOCK_SOURCE_OPTIONS}
              value={filters.block_source}
              onChange={v => setFilters(prev => ({ ...prev, block_source: v }))}
            />
          </Field>
          <Field label="流式">
            <Segmented<StreamingFilter>
              options={STREAMING_OPTIONS}
              value={filters.streaming}
              onChange={v => setFilters(prev => ({ ...prev, streaming: v }))}
            />
          </Field>

          <Field label="拦截原因">
            <div className="flex flex-wrap gap-1">
              {BLOCK_REASONS.map(r => {
                const on = filters.block_reason.includes(r.value)
                return (
                  <button
                    key={r.value}
                    type="button"
                    onClick={() => setFilters(prev => ({
                      ...prev,
                      block_reason: on
                        ? prev.block_reason.filter(x => x !== r.value)
                        : [...prev.block_reason, r.value],
                    }))}
                    className={`px-2 py-0.5 rounded-[3px] text-[11px] font-mono border transition-colors ${on
                      ? 'bg-[var(--ink)] text-[var(--bg)] border-[var(--ink)]'
                      : 'bg-[var(--surface)] text-[var(--ink-2)] border-[var(--rule)] hover:bg-[var(--rule-2)]'
                    }`}
                  >
                    {r.label}
                  </button>
                )
              })}
            </div>
          </Field>

          <Field label="开始时间">
            <Input
              type="datetime-local"
              value={filters.since}
              onChange={event => setFilters(prev => ({ ...prev, since: event.target.value }))}
            />
          </Field>
          <Field label="结束时间">
            <Input
              type="datetime-local"
              value={filters.until}
              onChange={event => setFilters(prev => ({ ...prev, until: event.target.value }))}
            />
          </Field>

          <div className="flex flex-col gap-2 pt-1">
            <Button variant="primary" onClick={handleSearch} disabled={loading}>搜索</Button>
            <Button variant="ghost" onClick={handleReset} disabled={loading}>重置</Button>
            <Button variant="danger" onClick={handleClearAll} disabled={loading}>清空日志</Button>
          </div>
        </aside>

        <div className="flex-1 min-w-0 space-y-5">
          {error && (
            <div className="border border-[var(--err)] bg-[#fbe4e4] text-[var(--err)] px-3 py-2 rounded text-[12px]">
              {error}
            </div>
          )}

          <div className="bg-[var(--surface)] border border-[var(--rule)] rounded overflow-x-auto">
            <Table<RequestLogListItem>
              rows={logs}
              columns={columns}
              onRowClick={(r) => void loadDetail(r.id)}
              emptyLabel={loading ? '加载中…' : '暂无数据'}
            />
          </div>

          <div className="flex items-center justify-between text-[12px] text-[var(--ink-3)]">
            <span>
              共 {total} 条， 第 {page} 页 / 共 {totalPages} 页
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPage(current => Math.max(1, current - 1))}
                disabled={loading || page <= 1}
              >
                上一页
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPage(current => Math.min(totalPages, current + 1))}
                disabled={loading || page >= totalPages}
              >
                下一页
              </Button>
            </div>
          </div>
        </div>
      </div>

      {(selectedLogId || detailLoading || detailError) && (
        <div
          className="fixed inset-0 z-50 bg-black/40 overflow-hidden overscroll-contain"
          onClick={closeModal}
          onWheel={(e) => e.stopPropagation()}
          onTouchMove={(e) => e.stopPropagation()}
        >
          <div
            className="relative w-[96vw] h-[94vh] sm:w-[94vw] sm:h-[92vh] mx-auto my-[3vh] bg-[var(--surface)] border border-[var(--rule)] rounded shadow-[0_8px_32px_rgba(0,0,0,0.15)] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="shrink-0 px-5 py-3 border-b border-[var(--rule)] bg-[var(--surface)] flex items-center justify-between gap-4">
              <div className="flex items-baseline gap-3 min-w-0">
                <strong className="font-serif font-normal text-[16px] text-[var(--ink)] shrink-0">请求详情</strong>
                {selectedLog?.trace_id && (
                  <button
                    type="button"
                    onClick={() => void handleCopy('traceId', selectedLog.trace_id)}
                    className="font-mono text-[11px] text-[var(--ink-3)] hover:text-[var(--ink)] truncate"
                    title="点击复制 trace_id"
                  >
                    {copiedKey === 'traceId' ? '已复制' : selectedLog.trace_id}
                  </button>
                )}
              </div>
              <Button variant="ghost" size="sm" onClick={closeModal}>
                关闭
              </Button>
            </header>

            <div className="flex-1 overflow-hidden flex flex-col bg-[var(--bg)]">
              {detailLoading ? (
                <div className="flex-1 flex items-center justify-center text-[14px] text-[var(--ink-3)]">加载详情中...</div>
              ) : detailError ? (
                <div className="flex-1 flex items-center justify-center text-[14px] text-[var(--err)]">{detailError}</div>
              ) : selectedLog ? (
                <>
                  <div className="shrink-0 px-5 py-3 border-b border-[var(--rule)] bg-[var(--surface)] overflow-x-auto">
                    <div className="flex items-stretch gap-2 min-w-max text-[12px]">
                      <KpiCell label="方法 + 路径" wide>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface)] text-[var(--ink-2)] border border-[var(--rule)] shrink-0">
                            {selectedLog.method || '-'}
                          </span>
                          <span className="text-[var(--ink)] truncate font-mono" title={selectedLog.path || ''}>
                            {selectedLog.path || '-'}
                          </span>
                        </div>
                      </KpiCell>
                      <KpiCell label="状态">{statusPill(selectedLog.response_status)}</KpiCell>
                      <KpiCell label="延迟">
                        <span className="text-[var(--ink)] font-mono tabular-nums">
                          {selectedLog.latency_ms !== null ? `${selectedLog.latency_ms} ms` : '-'}
                        </span>
                      </KpiCell>
                      <KpiCell label="模型">
                        <span className="text-[var(--ink)] truncate" title={selectedLog.request_model || ''}>
                          {selectedLog.request_model || '-'}
                        </span>
                      </KpiCell>
                      <KpiCell label="客户端">
                        <span className="text-[var(--ink)] truncate" title={selectedLog.client_name || ''}>
                          {selectedLog.client_name || '-'}
                        </span>
                      </KpiCell>
                      <KpiCell label="账号">
                        <span className="text-[var(--ink)] truncate" title={selectedLog.oauth_account_name || ''}>
                          {selectedLog.oauth_account_name || '-'}
                        </span>
                      </KpiCell>
                      <KpiCell label="分组">
                        <GroupPill
                          id={selectedLog.selected_group_id}
                          name={selectedLog.selected_group_name}
                          color={selectedLog.selected_group_color}
                        />
                      </KpiCell>
                      <KpiCell label="Operation" wide>
                        <div className="font-mono break-all">{selectedLog.operation_id || '-'}</div>
                      </KpiCell>
                      <KpiCell label="关系">
                        <div className="flex items-center gap-2">
                          <Pill tone={selectedLog.is_root ? 'info' : 'mute'}>{selectedLog.is_root ? 'root' : 'child'}</Pill>
                          <span className="font-mono text-[11px]">{selectedLog.parent_trace_id || '-'}</span>
                        </div>
                      </KpiCell>
                      <KpiCell label="Shape In">
                        <span className="font-mono text-[11px]">{selectedLog.shape_profile_in || selectedLog.request_family_in || '-'}</span>
                      </KpiCell>
                      <KpiCell label="Shape Out">
                        <span className="font-mono text-[11px]">{selectedLog.shape_profile_out || selectedLog.request_family_out || '-'}</span>
                      </KpiCell>
                      <KpiCell label="时间">
                        <span className="text-[var(--ink)] font-mono whitespace-nowrap">
                          {formatDateTime(selectedLog.created_at)}
                        </span>
                      </KpiCell>
                      <KpiCell label="Root Trace" wide>
                        <div className="font-mono break-all">{selectedLog.root_trace_id || '-'}</div>
                      </KpiCell>
                      <KpiCell label="Session Key" wide>
                        <div className="font-mono break-all">{selectedLog.session_key || '-'}</div>
                      </KpiCell>
                    </div>
                  </div>

                  <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4 p-3 sm:p-5 overflow-auto md:overflow-hidden">
                    <div className="flex flex-col gap-3 md:overflow-hidden md:min-h-0">
                      <Section
                        title="入站请求头（Client → Gateway）"
                        open={sections.requestHeadersIn}
                        onToggle={() => toggleSection('requestHeadersIn')}
                      >
                        <JsonDisplay value={selectedLog.request_headers_in} />
                      </Section>
                      <Section
                        title="入站请求体（Client → Gateway）"
                        open={sections.requestBodyIn}
                        onToggle={() => toggleSection('requestBodyIn')}
                        action={
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleCopy('requestBodyIn', selectedLog.request_body)}
                          >
                            {copiedKey === 'requestBodyIn' ? '已复制' : '复制'}
                          </Button>
                        }
                      >
                        <JsonDisplay value={selectedLog.request_body} />
                      </Section>
                    </div>
                    <div className="flex flex-col gap-3 md:overflow-hidden md:min-h-0">
                      <Section
                        title="出站请求头（Gateway → Anthropic）"
                        open={sections.requestHeadersOut}
                        onToggle={() => toggleSection('requestHeadersOut')}
                      >
                        <JsonDisplay value={selectedLog.request_headers_out} />
                      </Section>
                      <Section
                        title="出站请求体（Gateway → Anthropic，改写后）"
                        open={sections.requestBodyOut}
                        onToggle={() => toggleSection('requestBodyOut')}
                        action={
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleCopy('requestBodyOut', selectedLog.request_body_out)}
                          >
                            {copiedKey === 'requestBodyOut' ? '已复制' : '复制'}
                          </Button>
                        }
                      >
                        <OutboundBody
                          inbound={selectedLog.request_body}
                          outbound={selectedLog.request_body_out}
                        />
                      </Section>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 px-5 pb-3 h-[32vh] shrink-0">
                    <Section
                      title="响应头"
                      open={sections.responseHeaders}
                      onToggle={() => toggleSection('responseHeaders')}
                    >
                      <JsonDisplay value={selectedLog.response_headers} />
                    </Section>
                    <Section
                      title="响应体"
                      open={sections.responseBody}
                      onToggle={() => toggleSection('responseBody')}
                      action={
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleCopy('responseBody', selectedLog.response_body)}
                        >
                          {copiedKey === 'responseBody' ? '已复制' : '复制'}
                        </Button>
                      }
                    >
                      <JsonDisplay value={selectedLog.response_body} />
                    </Section>
                  </div>

                  {selectedLog.error_message && (
                    <div className="sticky bottom-0 bg-[#fbe4e4] border-t border-[var(--err)] text-[var(--err)] font-mono text-[11px] px-5 py-3 whitespace-pre-wrap break-all">
                      {selectedLog.error_message}
                    </div>
                  )}
                </>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
