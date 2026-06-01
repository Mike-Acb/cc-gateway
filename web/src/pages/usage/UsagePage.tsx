import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api/client'
import {
  FilterBar, Segmented, Field, Select, Button,
  MultiLine, Pie, type PieSlice,
} from '../../ui'

type Bucket = {
  t: string
  client_id: string
  client_name: string
  model: string
  count: number
  tokens: number
  input_tokens: number
  output_tokens: number
  cache_read: number
  cache_write: number
  blocked: number
}

type LogRow = {
  id: string
  trace_id: string
  created_at: string
  client_name: string
  request_model: string | null
  response_status: number | null
  latency_ms: number | null
  first_token_ms: number | null
  streaming: boolean | null
  retry_count: number
  block_reason: string | null
  block_source: string | null
  error_message: string | null
  input_tokens: string | number
  output_tokens: string | number
  cache_write: string | number
  cache_read: string | number
  total_tokens: string | number
  cost: string | number | null
  model_pattern: string | null
  input_mtok: string | number | null
  output_mtok: string | number | null
  cache_read_mtok: string | number | null
  cache_write_mtok: string | number | null
  consumed_subscription_id: string | null
  consumed_plan_name: string | null
  consumed_plan_type: string | null
  current_balance: string | number | null
  consumed_balance_after: string | number | null
}

type LogsCursor = { createdAt: string; id: string } | null

type ClientRow = { id: string; name: string }

type WindowKey = '24h' | '7d' | '30d'
type MetricKey = 'count' | 'tokens'

const WINDOW_OPTIONS: { value: WindowKey; label: string }[] = [
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
]

const METRIC_OPTIONS: { value: MetricKey; label: string }[] = [
  { value: 'count', label: '请求数' },
  { value: 'tokens', label: 'Token' },
]

const PALETTE = [
  'var(--accent)',
  'var(--info)',
  'var(--ok)',
  'var(--warn)',
  'var(--ink-2)',
  'var(--err)',
]

function colorForIdx(i: number): string {
  return PALETTE[i % PALETTE.length]
}

function windowToRange(w: WindowKey): { since: Date; until: Date; granularity: 'hour' | 'day' } {
  const until = new Date()
  if (w === '24h') {
    return { since: new Date(until.getTime() - 86_400_000), until, granularity: 'hour' }
  }
  if (w === '7d') {
    return { since: new Date(until.getTime() - 7 * 86_400_000), until, granularity: 'day' }
  }
  return { since: new Date(until.getTime() - 30 * 86_400_000), until, granularity: 'day' }
}

function formatBucketLabel(raw: string, granularity: 'hour' | 'day'): string {
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return raw.slice(5, 16)
  const pad = (n: number) => String(n).padStart(2, '0')
  if (granularity === 'hour') {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`
  }
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function formatCompact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(Math.round(n))
}

function formatRowTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatMs(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function toNum(v: string | number | null | undefined): number {
  if (v == null) return 0
  const n = typeof v === 'string' ? Number(v) : v
  return Number.isFinite(n) ? n : 0
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0'
  if (n < 0.0001) return `$${n.toFixed(6)}`
  if (n < 0.01)   return `$${n.toFixed(5)}`
  if (n < 1)      return `$${n.toFixed(4)}`
  return `$${n.toFixed(3)}`
}

type CostBreakdown = {
  inputUsd: number
  outputUsd: number
  cacheReadUsd: number
  cacheWriteUsd: number
  baseUsd: number
  totalUsd: number
  multiplier: number
  inputMtok: number
  outputMtok: number
  cacheReadMtok: number
  cacheWriteMtok: number
  hasPricing: boolean
}

function breakdownCost(r: LogRow): CostBreakdown {
  const inTok  = toNum(r.input_tokens)
  const outTok = toNum(r.output_tokens)
  const cR     = toNum(r.cache_read)
  const cW     = toNum(r.cache_write)
  const im = toNum(r.input_mtok)
  const om = toNum(r.output_mtok)
  const crm = toNum(r.cache_read_mtok)
  const cwm = toNum(r.cache_write_mtok)
  const hasPricing = r.input_mtok != null
  const inputUsd      = (inTok  / 1_000_000) * im
  const outputUsd     = (outTok / 1_000_000) * om
  const cacheReadUsd  = (cR     / 1_000_000) * crm
  const cacheWriteUsd = (cW     / 1_000_000) * cwm
  const baseUsd = inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd
  const totalUsd = toNum(r.cost)
  // Infer the multiplier from recorded cost vs. reconstructed base cost.
  // Fall back to 1 when base is zero (blocked/empty responses).
  const multiplier = baseUsd > 0 ? totalUsd / baseUsd : 1
  return {
    inputUsd, outputUsd, cacheReadUsd, cacheWriteUsd,
    baseUsd, totalUsd, multiplier,
    inputMtok: im, outputMtok: om,
    cacheReadMtok: crm, cacheWriteMtok: cwm,
    hasPricing,
  }
}

function formatFirstTokenMs(r: LogRow): string {
  if (r.first_token_ms != null) return formatMs(r.first_token_ms)
  if (r.streaming === false) return '— (非流式)'
  return '—'
}

function statusPill(row: LogRow): { text: string; tone: 'ok' | 'warn' | 'err' | 'mute' } {
  if (row.block_reason) return { text: row.block_reason, tone: row.block_source === 'gw' ? 'warn' : 'err' }
  const s = row.response_status ?? 0
  if (s >= 200 && s < 300) return { text: String(s), tone: 'ok' }
  if (s >= 400 && s < 500) return { text: String(s), tone: 'warn' }
  if (s >= 500) return { text: String(s), tone: 'err' }
  return { text: '—', tone: 'mute' }
}

export default function UsagePage() {
  const [windowKey, setWindowKey] = useState<WindowKey>('24h')
  const [metric, setMetric] = useState<MetricKey>('tokens')
  const [clientId, setClientId] = useState('')
  const [model, setModel] = useState('')
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [clients, setClients] = useState<ClientRow[]>([])
  const [loading, setLoading] = useState(true)

  // Per-request logs (time-sorted DESC)
  const [logs, setLogs] = useState<LogRow[]>([])
  const [logsCursor, setLogsCursor] = useState<LogsCursor>(null)
  const [logsLoading, setLogsLoading] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

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

  const range = useMemo(() => windowToRange(windowKey), [windowKey])

  useEffect(() => {
    setLoading(true)
    const qs = new URLSearchParams({
      granularity: range.granularity,
      since: range.since.toISOString(),
      until: range.until.toISOString(),
      ...(clientId ? { client_id: clientId } : {}),
      ...(model ? { model } : {}),
    })
    api<{ buckets: Bucket[] }>(`/me/usage?${qs.toString()}`)
      .then((r) => setBuckets(r.buckets ?? []))
      .catch(() => setBuckets([]))
      .finally(() => setLoading(false))
  }, [range, clientId, model])

  const loadLogs = useCallback(async (cursor: LogsCursor) => {
    setLogsLoading(true)
    const qs = new URLSearchParams({ limit: '50' })
    if (clientId) qs.set('client_id', clientId)
    if (model) qs.set('model', model)
    if (cursor) {
      qs.set('cursor_at', cursor.createdAt)
      qs.set('cursor_id', cursor.id)
    }
    try {
      const r = await api<{ items: LogRow[]; cursor: LogsCursor }>(`/me/logs?${qs.toString()}`)
      setLogs((prev) => (cursor ? [...prev, ...(r.items ?? [])] : (r.items ?? [])))
      setLogsCursor(r.cursor ?? null)
    } catch {
      if (!cursor) setLogs([])
      setLogsCursor(null)
    } finally {
      setLogsLoading(false)
    }
  }, [clientId, model])

  useEffect(() => {
    setExpanded(new Set())
    loadLogs(null)
  }, [loadLogs])

  // Line series:
  // - if a model is filtered AND metric === 'tokens' → per-token-type breakdown
  //   (input / output / cache_read / cache_write)
  // - otherwise → per-model aggregated by chosen metric
  const breakdownByType = model !== '' && metric === 'tokens'
  const lineData = useMemo(() => {
    const tSet = new Set<string>()
    for (const b of buckets) tSet.add(b.t)
    const xAxis = [...tSet].sort()

    if (breakdownByType) {
      const agg = {
        input: new Map<string, number>(),
        output: new Map<string, number>(),
        cache_read: new Map<string, number>(),
        cache_write: new Map<string, number>(),
      }
      for (const b of buckets) {
        agg.input.set(b.t,       (agg.input.get(b.t)       ?? 0) + (b.input_tokens  ?? 0))
        agg.output.set(b.t,      (agg.output.get(b.t)      ?? 0) + (b.output_tokens ?? 0))
        agg.cache_read.set(b.t,  (agg.cache_read.get(b.t)  ?? 0) + (b.cache_read    ?? 0))
        agg.cache_write.set(b.t, (agg.cache_write.get(b.t) ?? 0) + (b.cache_write   ?? 0))
      }
      const series = [
        { label: 'Input',   color: PALETTE[0], points: xAxis.map((t) => agg.input.get(t)       ?? 0) },
        { label: 'Output',  color: PALETTE[1], points: xAxis.map((t) => agg.output.get(t)      ?? 0) },
        { label: '缓存读',  color: PALETTE[2], points: xAxis.map((t) => agg.cache_read.get(t)  ?? 0) },
        { label: '缓存写',  color: PALETTE[3], points: xAxis.map((t) => agg.cache_write.get(t) ?? 0) },
      ]
      return { xAxis, series }
    }

    const models = new Set<string>()
    for (const b of buckets) models.add(b.model)
    const modelList = [...models].sort()
    const key = (t: string, m: string) => `${t}\u0000${m}`
    const agg = new Map<string, number>()
    for (const b of buckets) {
      const prev = agg.get(key(b.t, b.model)) ?? 0
      agg.set(key(b.t, b.model), prev + (metric === 'count' ? b.count : b.tokens))
    }
    const series = modelList.map((m, i) => ({
      label: m,
      color: colorForIdx(i),
      points: xAxis.map((t) => agg.get(key(t, m)) ?? 0),
    }))
    return { xAxis, series }
  }, [buckets, metric, breakdownByType])

  // Pie: total share by model over the window
  const pieSlices: PieSlice[] = useMemo(() => {
    const agg = new Map<string, number>()
    for (const b of buckets) {
      const v = metric === 'count' ? b.count : b.tokens
      agg.set(b.model, (agg.get(b.model) ?? 0) + v)
    }
    const entries = [...agg.entries()].sort((a, b) => b[1] - a[1])
    return entries.map(([label, value], i) => ({ label, value, color: colorForIdx(i) }))
  }, [buckets, metric])

  const pieTotal = pieSlices.reduce((s, x) => s + x.value, 0)

  function toggleRow(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function exportCsv() {
    const header = 'time,client,model,status,input,output,cache_write,cache_read,total,cost_usd,first_token_ms,total_ms'
    const rows = logs.map((r) => [
      r.created_at,
      r.client_name,
      r.request_model ?? '',
      r.block_reason ?? r.response_status ?? '',
      toNum(r.input_tokens),
      toNum(r.output_tokens),
      toNum(r.cache_write),
      toNum(r.cache_read),
      toNum(r.total_tokens),
      toNum(r.cost).toFixed(6),
      r.first_token_ms ?? '',
      r.latency_ms ?? '',
    ].join(','))
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `usage-logs-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="max-w-[1280px] mx-auto space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[26px] font-serif">用量</h1>
          <p className="text-[13px] text-[var(--mute)] mt-1">折线趋势 + 分模型占比</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">窗口</span>
            <Segmented<WindowKey> value={windowKey} options={WINDOW_OPTIONS} onChange={setWindowKey} />
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">指标</span>
            <Segmented<MetricKey> value={metric} options={METRIC_OPTIONS} onChange={setMetric} />
          </div>
        </div>
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
        <Field label="模型">
          <Select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">全部</option>
            <option value="claude-opus-4-7">Opus 4.7</option>
            <option value="claude-sonnet-4-6">Sonnet 4.6</option>
            <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
          </Select>
        </Field>
        <div className="ml-auto">
          <Button variant="ghost" onClick={exportCsv}>
            导出 CSV
          </Button>
        </div>
      </FilterBar>

      <section className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5">
        <div className="border border-[var(--rule)] bg-[var(--surface)] rounded p-4 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[13px] font-medium text-[var(--ink)]">
              {breakdownByType
                ? `Token 分类 — ${model}`
                : `${metric === 'count' ? '请求数' : 'Token'} — 按${range.granularity === 'hour' ? '小时' : '天'}`}
            </h2>
            <span className="text-[11px] text-[var(--ink-3)] font-mono tabular-nums">
              {loading ? '加载中…' : `${buckets.length} 条`}
            </span>
          </div>
          {lineData.series.length === 0 ? (
            <div className="flex-1 min-h-[220px] flex items-center justify-center text-[12px] text-[var(--ink-3)]">
              暂无数据
            </div>
          ) : (
            <div className="flex-1 min-h-0">
              <MultiLine
                series={lineData.series}
                xLabels={lineData.xAxis}
                height={240}
                formatX={(raw) => formatBucketLabel(raw, range.granularity)}
              />
            </div>
          )}
        </div>

        <div className="border border-[var(--rule)] bg-[var(--surface)] rounded p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[13px] font-medium text-[var(--ink)]">模型占比</h2>
            <span className="text-[11px] text-[var(--ink-3)] font-mono">
              {metric === 'count' ? '按请求数' : '按 Token'}
            </span>
          </div>
          <Pie
            slices={pieSlices}
            size={180}
            layout="vertical"
            centerLabel="合计"
            centerValue={formatCompact(pieTotal)}
            formatValue={formatCompact}
          />
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[14px] font-medium">明细</h2>
          <span className="text-[11px] text-[var(--ink-3)] font-mono tabular-nums">
            {logsLoading && logs.length === 0 ? '加载中…' : `${logs.length} 条`}
          </span>
        </div>
        <div className="border border-[var(--rule)] bg-[var(--surface)] rounded overflow-hidden">
          {logs.length === 0 && !logsLoading ? (
            <div className="p-6 text-center text-[var(--ink-3)] text-[12px]">该时间段没有数据。</div>
          ) : (
            <div className="w-full overflow-x-auto">
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr className="border-b border-[var(--rule)] text-left font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">
                    <th className="px-3 py-2 w-8"></th>
                    <th className="px-3 py-2 whitespace-nowrap">时间</th>
                    <th className="px-3 py-2 whitespace-nowrap">客户端</th>
                    <th className="px-3 py-2 whitespace-nowrap">模型</th>
                    <th className="px-3 py-2 whitespace-nowrap">状态</th>
                    <th className="px-3 py-2 text-right whitespace-nowrap">Input</th>
                    <th className="px-3 py-2 text-right whitespace-nowrap">Output</th>
                    <th className="px-3 py-2 text-right whitespace-nowrap">缓存写</th>
                    <th className="px-3 py-2 text-right whitespace-nowrap">缓存读</th>
                    <th className="px-3 py-2 text-right whitespace-nowrap">消费</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((r) => {
                    const key = r.id || r.trace_id
                    const open = expanded.has(key)
                    const pill = statusPill(r)
                    const toneColor = pill.tone === 'ok' ? 'var(--ok)' : pill.tone === 'warn' ? 'var(--warn)' : pill.tone === 'err' ? 'var(--err)' : 'var(--ink-3)'
                    const bd = breakdownCost(r)
                    return (
                      <Fragment key={key}>
                        <tr
                          onClick={() => toggleRow(key)}
                          className="border-b border-[var(--rule)] cursor-pointer hover:bg-[var(--rule-2)]"
                        >
                          <td className="px-3 py-2 text-[var(--ink-3)] font-mono">
                            {open ? '▾' : '▸'}
                          </td>
                          <td className="px-3 py-2 font-mono tabular-nums whitespace-nowrap">{formatRowTime(r.created_at)}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{r.client_name}</td>
                          <td className="px-3 py-2 font-mono whitespace-nowrap">{r.request_model ?? '—'}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <span
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-mono"
                              style={{
                                color: toneColor,
                                background: `color-mix(in srgb, ${toneColor} 12%, transparent)`,
                              }}
                            >
                              {pill.text}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{toNum(r.input_tokens).toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{toNum(r.output_tokens).toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{toNum(r.cache_write).toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{toNum(r.cache_read).toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtUsd(toNum(r.cost))}</td>
                        </tr>
                        {open && (
                          <tr className="border-b border-[var(--rule)] bg-[var(--mute-bg)]">
                            <td></td>
                            <td colSpan={9} className="px-3 py-3">
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[12px]">
                                <div>
                                  <div className="text-[10px] text-[var(--ink-3)] uppercase tracking-wider font-mono">首 Token 延迟</div>
                                  <div className="mt-0.5 tabular-nums font-medium">{formatFirstTokenMs(r)}</div>
                                </div>
                                <div>
                                  <div className="text-[10px] text-[var(--ink-3)] uppercase tracking-wider font-mono">总请求时间</div>
                                  <div className="mt-0.5 tabular-nums font-medium">{formatMs(r.latency_ms)}</div>
                                </div>
                                <div>
                                  <div className="text-[10px] text-[var(--ink-3)] uppercase tracking-wider font-mono">流式</div>
                                  <div className="mt-0.5 font-medium">{r.streaming ? '是' : '否'}</div>
                                </div>
                                <div>
                                  <div className="text-[10px] text-[var(--ink-3)] uppercase tracking-wider font-mono">重试</div>
                                  <div className="mt-0.5 tabular-nums font-medium">{r.retry_count ?? 0}</div>
                                </div>
                              </div>

                              <div className="mt-4 border-t border-[var(--rule)] pt-3">
                                <div className="text-[10px] text-[var(--ink-3)] uppercase tracking-wider font-mono mb-2">
                                  计费明细{bd.hasPricing ? ` · ${r.model_pattern ?? r.request_model ?? ''}` : ''}
                                </div>
                                {!bd.hasPricing ? (
                                  <div className="text-[11px] text-[var(--ink-3)]">
                                    该模型暂无定价信息,无法展开公式。
                                  </div>
                                ) : (
                                  <div className="font-mono text-[11px] text-[var(--ink-2)] space-y-1">
                                    <div className="grid grid-cols-[120px_1fr_auto] gap-2">
                                      <span className="text-[var(--ink-3)]">Input</span>
                                      <span>
                                        {toNum(r.input_tokens).toLocaleString()} × ${bd.inputMtok.toFixed(2)}/MTok
                                      </span>
                                      <span className="tabular-nums text-right">{fmtUsd(bd.inputUsd)}</span>
                                    </div>
                                    <div className="grid grid-cols-[120px_1fr_auto] gap-2">
                                      <span className="text-[var(--ink-3)]">Output</span>
                                      <span>
                                        {toNum(r.output_tokens).toLocaleString()} × ${bd.outputMtok.toFixed(2)}/MTok
                                      </span>
                                      <span className="tabular-nums text-right">{fmtUsd(bd.outputUsd)}</span>
                                    </div>
                                    <div className="grid grid-cols-[120px_1fr_auto] gap-2">
                                      <span className="text-[var(--ink-3)]">缓存写</span>
                                      <span>
                                        {toNum(r.cache_write).toLocaleString()} × ${bd.cacheWriteMtok.toFixed(2)}/MTok
                                      </span>
                                      <span className="tabular-nums text-right">{fmtUsd(bd.cacheWriteUsd)}</span>
                                    </div>
                                    <div className="grid grid-cols-[120px_1fr_auto] gap-2">
                                      <span className="text-[var(--ink-3)]">缓存读</span>
                                      <span>
                                        {toNum(r.cache_read).toLocaleString()} × ${bd.cacheReadMtok.toFixed(2)}/MTok
                                      </span>
                                      <span className="tabular-nums text-right">{fmtUsd(bd.cacheReadUsd)}</span>
                                    </div>
                                    <div className="grid grid-cols-[120px_1fr_auto] gap-2 border-t border-[var(--rule)] pt-1">
                                      <span className="text-[var(--ink-3)]">基准小计</span>
                                      <span></span>
                                      <span className="tabular-nums text-right">{fmtUsd(bd.baseUsd)}</span>
                                    </div>
                                    <div className="grid grid-cols-[120px_1fr_auto] gap-2">
                                      <span className="text-[var(--ink-3)]">分组倍率</span>
                                      <span>×{bd.multiplier.toFixed(3).replace(/\.?0+$/, '')}</span>
                                      <span></span>
                                    </div>
                                    <div className="grid grid-cols-[120px_1fr_auto] gap-2 border-t border-[var(--rule)] pt-1 text-[var(--ink)] font-medium">
                                      <span>合计</span>
                                      <span></span>
                                      <span className="tabular-nums text-right">{fmtUsd(bd.totalUsd)}</span>
                                    </div>
                                  </div>
                                )}
                              </div>

                              <div className="mt-3 border-t border-[var(--rule)] pt-3">
                                <div className="text-[10px] text-[var(--ink-3)] uppercase tracking-wider font-mono mb-2">
                                  消费来源
                                </div>
                                {r.consumed_subscription_id ? (
                                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[12px]">
                                    <div>
                                      <div className="text-[10px] text-[var(--ink-3)] uppercase tracking-wider font-mono">来源</div>
                                      <div className="mt-0.5 font-medium">
                                        {r.consumed_plan_type === 'pool' ? '订阅' : r.consumed_plan_type === 'quota' ? '余额' : r.consumed_plan_type ?? '—'}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[10px] text-[var(--ink-3)] uppercase tracking-wider font-mono">套餐</div>
                                      <div className="mt-0.5 font-medium">{r.consumed_plan_name ?? '—'}</div>
                                    </div>
                                    <div>
                                      <div className="text-[10px] text-[var(--ink-3)] uppercase tracking-wider font-mono">本次消费</div>
                                      <div className="mt-0.5 tabular-nums font-medium">{fmtUsd(toNum(r.cost))}</div>
                                    </div>
                                    <div>
                                      <div className="text-[10px] text-[var(--ink-3)] uppercase tracking-wider font-mono">扣款后余额</div>
                                      <div className="mt-0.5 tabular-nums font-medium">{fmtUsd(toNum(r.consumed_balance_after))}</div>
                                      <div className="mt-0.5 text-[10px] text-[var(--ink-3)] font-mono">当前 {fmtUsd(toNum(r.current_balance))}</div>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="grid grid-cols-2 md:grid-cols-2 gap-3 text-[12px]">
                                    <div>
                                      <div className="text-[10px] text-[var(--ink-3)] uppercase tracking-wider font-mono">来源</div>
                                      <div className="mt-0.5 font-medium">按量计费</div>
                                    </div>
                                    <div>
                                      <div className="text-[10px] text-[var(--ink-3)] uppercase tracking-wider font-mono">本次消费</div>
                                      <div className="mt-0.5 tabular-nums font-medium">{fmtUsd(toNum(r.cost))}</div>
                                    </div>
                                  </div>
                                )}
                              </div>

                              <div className="mt-3 border-t border-[var(--rule)] pt-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-[12px]">
                                <div>
                                  <div className="text-[10px] text-[var(--ink-3)] uppercase tracking-wider font-mono">Trace</div>
                                  <div className="mt-0.5 font-mono text-[11px] text-[var(--ink-2)] break-all">{r.trace_id}</div>
                                </div>
                                {r.error_message && (
                                  <div>
                                    <div className="text-[10px] text-[var(--err)] uppercase tracking-wider font-mono">错误</div>
                                    <div className="mt-0.5 text-[11px] text-[var(--ink)] break-all">{r.error_message}</div>
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {logsCursor && (
            <div className="flex justify-center p-3 border-t border-[var(--rule)]">
              <Button
                variant="ghost"
                onClick={() => loadLogs(logsCursor)}
                disabled={logsLoading}
              >
                {logsLoading ? '加载中…' : '加载更多'}
              </Button>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
