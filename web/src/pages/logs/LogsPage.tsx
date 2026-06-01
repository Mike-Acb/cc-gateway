import { Fragment, useEffect, useState } from 'react'
import { api } from '../../api/client'
import { FilterBar, Field, Select, Checkbox, Button, Pill } from '../../ui'

const COL_COUNT = 9

type Log = {
  id: string
  trace_id: string
  created_at: string
  client_name: string
  method: string | null
  path: string | null
  request_model: string | null
  response_status: number | null
  latency_ms: number | null
  first_token_ms: number | null
  streaming: boolean | null
  error_message: string | null
  retry_count: number | null
  block_reason: string | null
  block_source: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_write: number | null
  cache_read: number | null
  total_tokens: number | null
}

type ClientRow = { id: string; name: string }

function fmtMs(v: number | null | undefined) {
  if (v === null || v === undefined) return '-'
  return `${v.toLocaleString()} ms`
}

function blockSourceLabel(s: string | null): string {
  if (!s) return '-'
  if (s === 'gw') return '网关'
  return '上游'
}

function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1 border-b border-[var(--rule-2)] last:border-b-0">
      <span className="w-20 shrink-0 text-[11px] uppercase tracking-wider text-[var(--ink-3)] font-mono">
        {label}
      </span>
      <span className="flex-1 text-[13px] text-[var(--ink)] break-all">{children}</span>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-[11px] font-medium text-[var(--ink-2)] uppercase tracking-[0.14em] mb-1.5">
        {title}
      </h3>
      <div className="rounded-[4px] border border-[var(--rule)] bg-[var(--surface)] px-3 py-1">
        {children}
      </div>
    </section>
  )
}

function ExpandedRow({ log }: { log: Log }) {
  const input = Number(log.input_tokens ?? 0)
  const output = Number(log.output_tokens ?? 0)
  const cacheWrite = Number(log.cache_write ?? 0)
  const cacheRead = Number(log.cache_read ?? 0)
  const total = input + output + cacheWrite + cacheRead
  return (
    <div className="bg-[var(--bg)] px-6 py-5 grid gap-4 md:grid-cols-2">
      <Panel title="请求">
        <KV label="客户端">{log.client_name}</KV>
        <KV label="方法">
          <span className="font-mono text-[12px]">
            {log.method ?? '-'} {log.path ?? ''}
          </span>
        </KV>
        <KV label="模型">{log.request_model ?? '-'}</KV>
        <KV label="流式">{log.streaming ? '是' : '否'}</KV>
        <KV label="trace_id">
          <span className="font-mono text-[11px] text-[var(--ink-3)]">{log.trace_id}</span>
        </KV>
      </Panel>

      <Panel title="响应">
        <KV label="状态">
          {log.block_reason ? (
            <Pill tone="warn">{log.block_reason}</Pill>
          ) : log.response_status ? (
            <Pill tone={log.response_status < 300 ? 'ok' : 'err'}>
              {log.response_status}
            </Pill>
          ) : (
            <Pill tone="err">日志丢失</Pill>
          )}
        </KV>
        <KV label="延迟">
          <span className="tabular-nums">{fmtMs(log.latency_ms)}</span>
        </KV>
        <KV label="首 token">
          <span className="tabular-nums">{fmtMs(log.first_token_ms)}</span>
        </KV>
        <KV label="重试">
          <span className="tabular-nums">{log.retry_count ?? 0}</span>
        </KV>
      </Panel>

      <Panel title="Token 用量">
        <KV label="输入">
          <span className="tabular-nums">{input.toLocaleString()}</span>
        </KV>
        <KV label="输出">
          <span className="tabular-nums">{output.toLocaleString()}</span>
        </KV>
        <KV label="缓存创建">
          <span className="tabular-nums">{cacheWrite.toLocaleString()}</span>
        </KV>
        <KV label="缓存读取">
          <span className="tabular-nums">{cacheRead.toLocaleString()}</span>
        </KV>
        <KV label="合计">
          <span className="tabular-nums font-medium">{total.toLocaleString()}</span>
        </KV>
      </Panel>

      {(log.block_reason || log.error_message) && (
        <Panel title="异常">
          {log.block_reason && (
            <KV label="拦截原因">
              <Pill tone="warn">{log.block_reason}</Pill>
              <span className="ml-2 text-[12px] text-[var(--ink-3)]">
                来源：{blockSourceLabel(log.block_source)}
              </span>
            </KV>
          )}
          {log.error_message && (
            <KV label="错误">
              <span className="font-mono text-[12px] text-[var(--err)]">
                {log.error_message}
              </span>
            </KV>
          )}
        </Panel>
      )}
    </div>
  )
}

export default function LogsPage() {
  const [items, setItems] = useState<Log[]>([])
  const [cursor, setCursor] = useState<{ createdAt: string; id: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [clientId, setClientId] = useState('')
  const [blockedOnly, setBlockedOnly] = useState(false)
  const [clients, setClients] = useState<ClientRow[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  useEffect(() => {
    api<any>('/clients')
      .then((r) => {
        const rows: ClientRow[] = Array.isArray(r)
          ? r
          : Array.isArray(r?.items)
          ? r.items
          : []
        setClients(rows.map((c) => ({ id: c.id, name: c.name })))
      })
      .catch(() => setClients([]))
  }, [])

  async function load(reset: boolean) {
    setLoading(true)
    try {
      const qs = new URLSearchParams()
      qs.set('limit', '50')
      if (clientId) qs.set('client_id', clientId)
      if (blockedOnly) qs.set('blocked', 'true')
      if (!reset && cursor) {
        qs.set('cursor_at', cursor.createdAt)
        qs.set('cursor_id', cursor.id)
      }
      const r = await api<{ items: Log[]; cursor: { createdAt: string; id: string } | null }>(
        `/me/logs?${qs.toString()}`,
      )
      setItems((prev) => (reset ? r.items : [...prev, ...r.items]))
      setCursor(r.cursor)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load(true)
    setExpanded({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, blockedOnly])

  function toggle(traceId: string) {
    setExpanded((p) => ({ ...p, [traceId]: !p[traceId] }))
  }

  return (
    <div className="max-w-[1280px] mx-auto space-y-6">
      <header>
        <h1 className="text-[26px] font-serif">请求日志</h1>
        <p className="text-[13px] text-[var(--mute)] mt-1">
          点击行展开查看 Token 用量与请求详情
        </p>
      </header>

      <FilterBar>
        <Field label="客户端">
          <Select value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">全部</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Checkbox
          label="仅看被拦截"
          checked={blockedOnly}
          onChange={(e) => setBlockedOnly(e.target.checked)}
        />
      </FilterBar>

      {items.length === 0 ? (
        <div className="p-6 text-center text-[var(--ink-3)] text-[12px]">没有日志。</div>
      ) : (
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-[var(--rule)] text-left font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">
              <th className="px-3 py-2 w-6"></th>
              <th className="px-3 py-2">时间</th>
              <th className="px-3 py-2">客户端</th>
              <th className="px-3 py-2">模型</th>
              <th className="px-3 py-2">状态</th>
              <th className="px-3 py-2 text-right">延迟</th>
              <th className="px-3 py-2 text-right">首 token</th>
              <th className="px-3 py-2 text-right">Token 用量</th>
              <th className="px-3 py-2">流式</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => {
              const open = !!expanded[r.trace_id]
              return (
                <Fragment key={r.trace_id}>
                  <tr
                    onClick={() => toggle(r.trace_id)}
                    className={`border-b border-[var(--rule)] cursor-pointer hover:bg-[var(--rule-2)] ${
                      open ? 'bg-[var(--rule-2)]' : ''
                    }`}
                  >
                    <td className="px-3 py-2 text-[var(--ink-3)] select-none">
                      <span
                        className="inline-block transition-transform"
                        style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
                      >
                        ›
                      </span>
                    </td>
                    <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">{r.client_name}</td>
                    <td className="px-3 py-2">{r.request_model ?? '-'}</td>
                    <td className="px-3 py-2">
                      {r.block_reason ? (
                        <Pill tone="warn">{r.block_reason}</Pill>
                      ) : r.response_status ? (
                        <Pill tone={r.response_status < 300 ? 'ok' : 'err'}>
                          {r.response_status}
                        </Pill>
                      ) : (
                        <Pill tone="err">日志丢失</Pill>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMs(r.latency_ms)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {fmtMs(r.first_token_ms)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {Number(r.total_tokens) > 0
                        ? Number(r.total_tokens).toLocaleString()
                        : '-'}
                    </td>
                    <td className="px-3 py-2">{r.streaming ? '是' : '否'}</td>
                  </tr>
                  {open && (
                    <tr key={`${r.trace_id}-x`} className="border-b border-[var(--rule)]">
                      <td colSpan={COL_COUNT} className="p-0">
                        <ExpandedRow log={r} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      )}

      {cursor && (
        <div className="text-center">
          <Button variant="ghost" disabled={loading} onClick={() => load(false)}>
            {loading ? '加载中…' : '加载更多'}
          </Button>
        </div>
      )}
    </div>
  )
}
