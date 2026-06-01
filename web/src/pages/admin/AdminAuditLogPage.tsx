import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api/client'
import {
  Button,
  Field,
  Input,
  Modal,
  Pill,
  Select,
  Table,
  type Column,
} from '../../ui'
import { AUDIT_ACTION_META, AUDIT_RESOURCE_TYPES, actionMeta } from './_audit/actionMeta'

interface AuditRow {
  id: number
  actor_id: string | null
  actor_email: string | null
  action: string
  resource_type: string | null
  resource_id: string | null
  before: unknown
  after: unknown
  summary: string | null
  ip: string | null
  user_agent: string | null
  created_at: string
}

interface AuditListResponse {
  items: AuditRow[]
  total: number
  limit: number
  offset: number
}

interface Filters {
  actor: string
  action: string
  resource_type: string
  since: string
  until: string
}

const DEFAULT_FILTERS: Filters = {
  actor: '',
  action: '',
  resource_type: '',
  since: '',
  until: '',
}

const PAGE_SIZE = 50

function pad(v: number): string {
  return String(v).padStart(2, '0')
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '-'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function shortId(id: string | null): string {
  if (!id) return '-'
  if (id.length <= 16) return id
  return `${id.slice(0, 8)}…${id.slice(-6)}`
}

function toSinceIso(dateStr: string): string {
  // yyyy-mm-dd → local start of day → ISO
  if (!dateStr) return ''
  const d = new Date(`${dateStr}T00:00:00`)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

function toUntilIso(dateStr: string): string {
  // yyyy-mm-dd → local end of day → ISO
  if (!dateStr) return ''
  const d = new Date(`${dateStr}T23:59:59.999`)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined) return '—'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export default function AdminAuditLogPage() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [applied, setApplied] = useState<Filters>(DEFAULT_FILTERS)
  const [items, setItems] = useState<AuditRow[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<AuditRow | null>(null)

  const appliedKey = useMemo(() => JSON.stringify(applied), [applied])

  async function load(nextOffset: number, reset: boolean) {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams()
      qs.set('limit', String(PAGE_SIZE))
      qs.set('offset', String(nextOffset))
      if (applied.actor.trim()) qs.set('actor', applied.actor.trim())
      if (applied.action) qs.set('action', applied.action)
      if (applied.resource_type) qs.set('resource_type', applied.resource_type)
      const sinceIso = toSinceIso(applied.since)
      if (sinceIso) qs.set('since', sinceIso)
      const untilIso = toUntilIso(applied.until)
      if (untilIso) qs.set('until', untilIso)

      const data = await api<AuditListResponse>(`/admin/audit?${qs.toString()}`)
      setTotal(data.total)
      setOffset(nextOffset + data.items.length)
      setItems(reset ? data.items : [...items, ...data.items])
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // reset + reload whenever applied filters change
    void load(0, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedKey])

  const handleSearch = () => {
    setApplied({ ...filters })
  }

  const handleReset = () => {
    setFilters(DEFAULT_FILTERS)
    setApplied(DEFAULT_FILTERS)
  }

  const columns: Column<AuditRow>[] = [
    {
      key: 'created_at',
      header: '时间',
      className: 'whitespace-nowrap text-[var(--ink-2)] tabular-nums',
      render: (r) => formatDateTime(r.created_at),
    },
    {
      key: 'actor',
      header: '操作人',
      render: (r) => r.actor_email ?? <span className="text-[var(--ink-3)]">-</span>,
    },
    {
      key: 'action',
      header: '动作',
      render: (r) => {
        const m = actionMeta(r.action)
        const charLen = m.label.replace(/\s/g, '').length
        return (
          <Pill tone={m.tone}>
            <span className={charLen <= 4 ? 'whitespace-nowrap' : ''}>{m.label}</span>
          </Pill>
        )
      },
    },
    {
      key: 'resource',
      header: '资源',
      render: (r) => (
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-[var(--ink-3)]">{r.resource_type ?? '-'}</span>
          <span
            className="font-mono text-[11px] text-[var(--ink-2)]"
            title={r.resource_id ?? ''}
          >
            {shortId(r.resource_id)}
          </span>
        </div>
      ),
    },
    {
      key: 'summary',
      header: '摘要',
      className: 'max-w-[360px]',
      render: (r) => (
        <span className="block truncate" title={r.summary ?? ''}>
          {r.summary ?? <span className="text-[var(--ink-3)]">-</span>}
        </span>
      ),
    },
    {
      key: 'ip',
      header: 'IP',
      className: 'whitespace-nowrap font-mono text-[11px] text-[var(--ink-3)]',
      render: (r) => r.ip ?? '-',
    },
  ]

  return (
    <div className="max-w-[1300px] mx-auto p-6 space-y-5">
      <header>
        <h1 className="text-[24px] font-semibold text-[var(--ink)]">审计日志</h1>
        <p className="mt-1 text-[13px] text-[var(--ink-3)]">管理员操作全量记录（操作人 / 动作 / 资源 / 时间窗）。</p>
      </header>

      <div className="flex gap-6">
        <aside className="w-[260px] shrink-0 self-start sticky top-4 border border-[var(--rule)] bg-[var(--surface)] rounded p-4 space-y-4 text-[12px] max-h-[calc(100vh-2rem)] overflow-y-auto">
          <h3 className="text-[10px] uppercase tracking-[0.14em] font-mono text-[var(--ink-3)]">过滤条件</h3>
          <Field label="操作人">
            <Input
              value={filters.actor}
              onChange={(e) => setFilters({ ...filters, actor: e.target.value })}
              placeholder="邮箱包含 / UUID"
            />
          </Field>
          <Field label="动作">
            <Select
              value={filters.action}
              onChange={(e) => setFilters({ ...filters, action: e.target.value })}
            >
              <option value="">全部</option>
              {Object.entries(AUDIT_ACTION_META).map(([key, meta]) => (
                <option key={key} value={key}>
                  {meta.label} ({key})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="资源">
            <Select
              value={filters.resource_type}
              onChange={(e) => setFilters({ ...filters, resource_type: e.target.value })}
            >
              <option value="">全部</option>
              {AUDIT_RESOURCE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="开始日期">
            <Input
              type="date"
              value={filters.since}
              onChange={(e) => setFilters({ ...filters, since: e.target.value })}
            />
          </Field>
          <Field label="结束日期">
            <Input
              type="date"
              value={filters.until}
              onChange={(e) => setFilters({ ...filters, until: e.target.value })}
            />
          </Field>
          <div className="flex flex-col gap-2 pt-1">
            <Button variant="primary" onClick={handleSearch} disabled={loading}>搜索</Button>
            <Button variant="ghost" onClick={handleReset} disabled={loading}>重置</Button>
          </div>
        </aside>

        <div className="flex-1 min-w-0 space-y-5">
          {error && (
            <div className="border border-[var(--err)] bg-[#fbe4e4] text-[var(--err)] px-3 py-2 rounded text-[12px]">
              {error}
            </div>
          )}

          <div className="bg-[var(--surface)] border border-[var(--rule)] rounded">
            <Table<AuditRow>
              rows={items}
              columns={columns}
              onRowClick={(r) => setDetail(r)}
              emptyLabel={loading ? '加载中…' : '暂无数据'}
            />
          </div>

          <div className="flex items-center justify-between text-[12px] text-[var(--ink-3)]">
            <span>
              共 {total} 条，已加载 {items.length}
            </span>
            {offset < total && (
              <Button variant="ghost" onClick={() => void load(offset, false)} disabled={loading}>
                {loading ? '加载中…' : `加载更多（剩余 ${total - offset}）`}
              </Button>
            )}
          </div>
        </div>
      </div>

      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={
          detail
            ? `${actionMeta(detail.action).label} · ${detail.resource_type ?? '-'}`
            : '详情'
        }
        footer={
          <Button variant="default" onClick={() => setDetail(null)}>
            关闭
          </Button>
        }
      >
        {detail && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[12px]">
              <div className="bg-[var(--rule-2)] px-3 py-2 rounded">
                <span className="text-[var(--ink-3)]">时间：</span>
                <span className="text-[var(--ink)]">{formatDateTime(detail.created_at)}</span>
              </div>
              <div className="bg-[var(--rule-2)] px-3 py-2 rounded">
                <span className="text-[var(--ink-3)]">操作人：</span>
                <span className="text-[var(--ink)]">{detail.actor_email ?? '-'}</span>
              </div>
              <div className="bg-[var(--rule-2)] px-3 py-2 rounded">
                <span className="text-[var(--ink-3)]">Action：</span>
                <span className="font-mono text-[var(--ink)]">{detail.action}</span>
              </div>
              <div className="bg-[var(--rule-2)] px-3 py-2 rounded">
                <span className="text-[var(--ink-3)]">资源：</span>
                <span className="font-mono text-[var(--ink)]">
                  {detail.resource_type ?? '-'} · {detail.resource_id ?? '-'}
                </span>
              </div>
              <div className="bg-[var(--rule-2)] px-3 py-2 rounded">
                <span className="text-[var(--ink-3)]">IP：</span>
                <span className="font-mono text-[var(--ink)]">{detail.ip ?? '-'}</span>
              </div>
              <div className="bg-[var(--rule-2)] px-3 py-2 rounded truncate" title={detail.user_agent ?? ''}>
                <span className="text-[var(--ink-3)]">UA：</span>
                <span className="text-[var(--ink)]">{detail.user_agent ?? '-'}</span>
              </div>
            </div>

            {detail.summary && (
              <div className="text-[12px] text-[var(--ink-2)] bg-[var(--rule-2)] px-3 py-2 rounded">
                {detail.summary}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-wider font-mono text-[var(--ink-3)] mb-1">
                  Before
                </div>
                <pre className="font-mono text-[11px] text-[var(--ink)] bg-[var(--rule-2)] p-3 rounded max-h-[50vh] overflow-auto whitespace-pre-wrap break-all">
                  {formatJson(detail.before)}
                </pre>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider font-mono text-[var(--ink-3)] mb-1">
                  After
                </div>
                <pre className="font-mono text-[11px] text-[var(--ink)] bg-[var(--rule-2)] p-3 rounded max-h-[50vh] overflow-auto whitespace-pre-wrap break-all">
                  {formatJson(detail.after)}
                </pre>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
