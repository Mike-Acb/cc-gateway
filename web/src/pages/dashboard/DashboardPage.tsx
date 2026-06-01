import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api/client'
import { StatGrid, Pill, Table, Segmented, MultiLine, HBarList } from '../../ui'
import WaterLevelBar from '../../ui/WaterLevelBar'

type WindowKey = '24h' | '7d' | '30d'
type MetricKey = 'count' | 'tokens'

const WINDOW_LABELS: Record<WindowKey, string> = {
  '24h': '近 24 小时',
  '7d': '近 7 天',
  '30d': '近 30 天',
}

type TrendPoint = { bucket: string; success: number; blocked: number; total: number }
type ModelTrendPoint = { bucket: string; model: string; count: number; tokens: number }

type Dto = {
  window: WindowKey
  bucket: 'hour' | 'day'
  since: string
  until: string
  kpis: {
    requestCount: number
    successRate: number
    blockedCount: number
    tokenCount: number
  }
  trend: TrendPoint[]
  modelTrend: ModelTrendPoint[]
  topClients: Array<{ name: string; count: number; tokens: number }>
  topModels: Array<{ model: string; count: number; tokens: number }>
  recentBlocks: Array<{
    id: string
    created_at: string
    client_name: string
    request_model: string | null
    block_reason: string | null
    block_source: string | null
    response_status: number | null
  }>
  wallet: {
    pool: {
      subscription_id: string
      plan_name: string
      balance: number
      expires_at: string | null
      starts_at?: string | null
    } | null
    quota: {
      subscription_id: string
      plan_name: string
      balance: number
    } | null
    consumption_order: 'pool_first'
  }
}

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

function buildModelSeries(
  points: ModelTrendPoint[],
  metric: MetricKey,
): { xAxis: string[]; series: { label: string; color: string; points: number[] }[] } {
  const tSet = new Set<string>()
  const modelSet = new Set<string>()
  for (const p of points) {
    tSet.add(p.bucket)
    modelSet.add(p.model)
  }
  const xAxis = [...tSet].sort()
  // Pick top N models by total metric within window, to keep chart readable.
  const totals = new Map<string, number>()
  for (const p of points) {
    const v = metric === 'count' ? p.count : p.tokens
    totals.set(p.model, (totals.get(p.model) ?? 0) + v)
  }
  const ranked = [...modelSet].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0))
  const top = ranked.slice(0, 6)
  const key = (t: string, m: string) => `${t}\u0000${m}`
  const agg = new Map<string, number>()
  for (const p of points) {
    agg.set(key(p.bucket, p.model), (agg.get(key(p.bucket, p.model)) ?? 0) + (metric === 'count' ? p.count : p.tokens))
  }
  const series = top.map((m, i) => ({
    label: m,
    color: colorForIdx(i),
    points: xAxis.map((t) => agg.get(key(t, m)) ?? 0),
  }))
  return { xAxis, series }
}

export default function DashboardPage() {
  const navigate = useNavigate()
  const [windowKey, setWindowKey] = useState<WindowKey>('24h')
  const [data, setData] = useState<Dto | null>(null)
  const [loading, setLoading] = useState(false)
  const [clientsMetric, setClientsMetric] = useState<MetricKey>('count')
  const [modelsMetric, setModelsMetric] = useState<MetricKey>('count')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api<Dto>(`/me/dashboard?window=${windowKey}`)
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setData(null))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [windowKey])

  const reqSeries = useMemo(
    () => (data ? buildModelSeries(data.modelTrend, 'count') : null),
    [data],
  )
  const tokenSeries = useMemo(
    () => (data ? buildModelSeries(data.modelTrend, 'tokens') : null),
    [data],
  )

  if (!data) {
    return <div className="text-[13px] text-[var(--mute)]">Loading…</div>
  }

  const label = WINDOW_LABELS[data.window]

  return (
    <div className="max-w-[1280px] mx-auto space-y-7">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-serif">总览</h1>
          <p className="text-[13px] text-[var(--mute)] mt-1">{label}使用情况</p>
        </div>
        <Segmented<WindowKey>
          value={windowKey}
          onChange={setWindowKey}
          options={[
            { value: '24h', label: '24h' },
            { value: '7d', label: '7d' },
            { value: '30d', label: '30d' },
          ]}
        />
      </header>

      <WaterLevelBar
        wallet={data.wallet}
        compact
        onSubscribe={() => navigate('/plans')}
        onRecharge={() => navigate('/plans')}
      />

      <StatGrid
        items={[
          { label: '请求数', value: data.kpis.requestCount.toLocaleString() },
          { label: '成功率', value: (data.kpis.successRate * 100).toFixed(1) + '%' },
          { label: '被拦截', value: data.kpis.blockedCount.toLocaleString() },
          { label: 'Token 消耗', value: formatCompact(data.kpis.tokenCount) },
        ]}
      />

      <section className="border border-[var(--rule)] bg-[var(--surface)] rounded p-4">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-[14px] font-medium">模型请求趋势</h2>
          <span className="text-[11px] text-[var(--ink-3)] font-mono">
            {data.bucket === 'hour' ? '每小时' : '每天'} · 按请求数
          </span>
        </div>
        {reqSeries && reqSeries.series.length > 0 ? (
          <MultiLine
            series={reqSeries.series}
            xLabels={reqSeries.xAxis}
            height={220}
            formatX={(raw) => formatBucketLabel(raw, data.bucket)}
            formatValue={(v) => formatCompact(v)}
          />
        ) : (
          <div className="h-[220px] flex items-center justify-center text-[12px] text-[var(--ink-3)]">
            暂无数据
          </div>
        )}
      </section>

      <section className="border border-[var(--rule)] bg-[var(--surface)] rounded p-4">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-[14px] font-medium">模型消耗趋势</h2>
          <span className="text-[11px] text-[var(--ink-3)] font-mono">
            {data.bucket === 'hour' ? '每小时' : '每天'} · 按 Token
          </span>
        </div>
        {tokenSeries && tokenSeries.series.length > 0 ? (
          <MultiLine
            series={tokenSeries.series}
            xLabels={tokenSeries.xAxis}
            height={220}
            formatX={(raw) => formatBucketLabel(raw, data.bucket)}
            formatValue={(v) => formatCompact(v)}
          />
        ) : (
          <div className="h-[220px] flex items-center justify-center text-[12px] text-[var(--ink-3)]">
            暂无数据
          </div>
        )}
      </section>

      <div className="grid md:grid-cols-2 gap-6">
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[14px] font-medium">Top 客户端</h2>
            <Segmented<MetricKey>
              value={clientsMetric}
              onChange={setClientsMetric}
              options={[
                { value: 'count', label: '请求数' },
                { value: 'tokens', label: 'Token' },
              ]}
            />
          </div>
          <HBarList
            items={data.topClients.map((c) => ({
              label: c.name,
              value: clientsMetric === 'count' ? c.count : c.tokens,
            }))}
            formatValue={(v) => (clientsMetric === 'tokens' ? formatCompact(v) : v.toLocaleString())}
            emptyLabel={`${label}没有请求。`}
          />
        </section>
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[14px] font-medium">Top 模型</h2>
            <Segmented<MetricKey>
              value={modelsMetric}
              onChange={setModelsMetric}
              options={[
                { value: 'count', label: '请求数' },
                { value: 'tokens', label: 'Token' },
              ]}
            />
          </div>
          <HBarList
            items={data.topModels.map((m) => ({
              label: m.model,
              value: modelsMetric === 'count' ? m.count : m.tokens,
            }))}
            formatValue={(v) => (modelsMetric === 'tokens' ? formatCompact(v) : v.toLocaleString())}
            emptyLabel={`${label}没有识别到模型。`}
          />
        </section>
      </div>

      <section>
        <h2 className="text-[14px] font-medium mb-2">最近被拦截</h2>
        <Table
          columns={[
            { key: 'created_at', header: '时间', render: (r) => new Date(r.created_at).toLocaleString() },
            { key: 'client_name', header: '客户端', render: (r) => r.client_name },
            { key: 'request_model', header: '模型', render: (r) => r.request_model ?? '-' },
            {
              key: 'block_reason',
              header: '原因',
              render: (r) => (r.block_reason ? <Pill tone="warn">{r.block_reason}</Pill> : '-'),
            },
            {
              key: 'block_source',
              header: '来源',
              render: (r) => (r.block_source === 'gw' ? '网关' : r.block_source ? '上游' : '-'),
            },
          ]}
          rows={data.recentBlocks}
          emptyLabel={`${label}没有被拦截的请求。`}
        />
      </section>

      {loading && <div className="text-[11px] text-[var(--ink-3)]">刷新中…</div>}
    </div>
  )
}
