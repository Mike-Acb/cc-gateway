import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api/client'
import { Segmented, StatGrid, Pill, Table } from '../../ui'
import type { Column } from '../../ui/Table'
import { StackedBars } from '../../ui/chart/StackedBars'

type WindowKey = '1h' | '24h' | '7d'

interface PercentileByModel {
  model: string
  p50: number | null
  p95: number | null
  n: number
}

interface PercentileBlock {
  p50: number | null
  p95: number | null
  n: number
  note?: string
  byModel: PercentileByModel[]
}

interface ErrorReason {
  reason: string
  source: string | null
  n: number
}

interface VolumeEntry {
  label: string
  n: number
}

interface MetricsDto {
  window: WindowKey
  since: string
  until: string
  latency: PercentileBlock
  firstToken: PercentileBlock
  errorRate: {
    total: number
    ok: number
    gw: number
    up: number
    gwRate: number
    upRate: number
    byReason: ErrorReason[]
  }
  volume: {
    byModel: VolumeEntry[]
    byAccount: VolumeEntry[]
  }
}

const WINDOW_OPTIONS: { value: WindowKey; label: string }[] = [
  { value: '1h', label: '近 1h' },
  { value: '24h', label: '近 24h' },
  { value: '7d', label: '近 7d' },
]

function fmtMs(v: number | null): string {
  if (v == null) return '样本不足'
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`
  return `${v} ms`
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(2)}%`
}

function fmtInt(v: number): string {
  return v.toLocaleString()
}

function TopBarTable<T extends { label: string; n: number }>({
  rows,
  labelHeader,
  emptyLabel,
}: {
  rows: T[]
  labelHeader: string
  emptyLabel: string
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.n), 0) || 1
  const columns: Column<T & { id: string }>[] = [
    {
      key: 'label',
      header: labelHeader,
      render: (row) => <span className="font-mono text-[11px] truncate inline-block max-w-[240px] align-middle">{row.label}</span>,
    },
    {
      key: 'bar',
      header: '',
      render: (row) => (
        <div className="w-full bg-[var(--rule-2)] h-2 rounded-[2px] overflow-hidden">
          <div
            className="h-full bg-[var(--ink)]"
            style={{ width: `${Math.max(2, (row.n / max) * 100)}%` }}
          />
        </div>
      ),
      style: { width: '60%' },
    },
    {
      key: 'n',
      header: '次数',
      render: (row) => <span className="font-mono text-[11px] tabular-nums">{fmtInt(row.n)}</span>,
      style: { width: '80px' },
      className: 'text-right',
    },
  ]
  const keyed = rows.map((r, i) => ({ ...r, id: `${r.label}-${i}` }))
  return <Table rows={keyed} columns={columns} emptyLabel={emptyLabel} />
}

export default function AdminMetricsPage() {
  const [windowKey, setWindowKey] = useState<WindowKey>('24h')
  const [data, setData] = useState<MetricsDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    api<MetricsDto>(`/admin/metrics?window=${windowKey}`)
      .then((r) => {
        if (cancelled) return
        setData(r)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setErr(e?.message ?? '加载失败')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [windowKey])

  const errorBars = useMemo(() => {
    if (!data) return null
    const total = data.errorRate.total
    if (total === 0) return null
    const ok = data.errorRate.ok
    const gw = data.errorRate.gw
    const up = data.errorRate.up
    const other = Math.max(0, total - ok - gw - up)
    return {
      labels: [data.window],
      series: [
        { label: '成功', color: 'var(--ok)', values: [ok] },
        { label: '网关拦截', color: 'var(--warn)', values: [gw] },
        { label: '上游错误', color: 'var(--err)', values: [up] },
        { label: '其他', color: 'var(--ink-3)', values: [other] },
      ],
    }
  }, [data])

  const latencyByModelRows = useMemo(() => {
    if (!data) return []
    return data.latency.byModel.map((m, i) => ({ ...m, id: `lat-${m.model}-${i}` }))
  }, [data])

  const firstTokenByModelRows = useMemo(() => {
    if (!data) return []
    return data.firstToken.byModel.map((m, i) => ({ ...m, id: `ft-${m.model}-${i}` }))
  }, [data])

  const modelPercentileColumns: Column<PercentileByModel & { id: string }>[] = [
    {
      key: 'model',
      header: '模型',
      render: (row) => <span className="font-mono text-[11px]">{row.model}</span>,
    },
    {
      key: 'p50',
      header: 'P50',
      render: (row) => <span className="font-mono text-[11px] tabular-nums">{fmtMs(row.p50)}</span>,
      className: 'text-right',
    },
    {
      key: 'p95',
      header: 'P95',
      render: (row) => <span className="font-mono text-[11px] tabular-nums">{fmtMs(row.p95)}</span>,
      className: 'text-right',
    },
    {
      key: 'n',
      header: '样本',
      render: (row) => <span className="font-mono text-[11px] tabular-nums">{fmtInt(row.n)}</span>,
      className: 'text-right',
    },
  ]

  return (
    <div className="max-w-[1200px] mx-auto space-y-7">
      <header>
        <h1 className="text-[26px] font-serif">指标</h1>
        <p className="text-[13px] text-[var(--mute)] mt-1">延迟 · 首 token · 错误分布</p>
      </header>

      <div className="flex items-center gap-3">
        <Segmented<WindowKey>
          value={windowKey}
          onChange={setWindowKey}
          options={WINDOW_OPTIONS}
        />
        {data && (
          <span className="font-mono text-[10px] text-[var(--ink-3)]">
            {new Date(data.since).toLocaleString()} → {new Date(data.until).toLocaleString()}
          </span>
        )}
      </div>

      {err && (
        <div className="border border-[var(--err)] bg-[var(--surface)] px-3 py-2 text-[12px] text-[var(--err)]">
          {err}
        </div>
      )}

      {loading && !data && (
        <div className="text-[13px] text-[var(--mute)]">Loading…</div>
      )}

      {data && (
        <>
          <StatGrid
            cols={5}
            items={[
              {
                label: `总请求`,
                value: fmtInt(data.errorRate.total),
                sub: `成功 ${fmtInt(data.errorRate.ok)}`,
              },
              {
                label: `延迟 P50`,
                value: fmtMs(data.latency.p50),
                sub: `样本 ${fmtInt(data.latency.n)}`,
              },
              {
                label: `延迟 P95`,
                value: fmtMs(data.latency.p95),
                sub: data.latency.note ?? ' ',
                tone: data.latency.p95 != null && data.latency.p95 > 10_000 ? 'warn' : '',
              },
              {
                label: `首 token P50`,
                value: fmtMs(data.firstToken.p50),
                sub: `流式样本 ${fmtInt(data.firstToken.n)}`,
              },
              {
                label: `首 token P95`,
                value: fmtMs(data.firstToken.p95),
                sub: data.firstToken.note ?? ' ',
                tone: data.firstToken.p95 != null && data.firstToken.p95 > 5_000 ? 'warn' : '',
              },
            ]}
          />

          <StatGrid
            cols={3}
            items={[
              {
                label: `错误率 (网关)`,
                value: fmtPct(data.errorRate.gwRate),
                sub: `${fmtInt(data.errorRate.gw)} / ${fmtInt(data.errorRate.total)}`,
                tone: data.errorRate.gwRate > 0.05 ? 'warn' : '',
              },
              {
                label: `错误率 (上游)`,
                value: fmtPct(data.errorRate.upRate),
                sub: `${fmtInt(data.errorRate.up)} / ${fmtInt(data.errorRate.total)}`,
                tone: data.errorRate.upRate > 0.05 ? 'err' : '',
              },
              {
                label: `成功率`,
                value:
                  data.errorRate.total === 0
                    ? '—'
                    : fmtPct(data.errorRate.ok / data.errorRate.total),
                sub: `窗口 ${data.window}`,
                tone: 'ok',
              },
            ]}
          />

          <section className="space-y-3">
            <h3 className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">
              请求结果构成
            </h3>
            <div className="bg-[var(--surface)] border border-[var(--rule)] p-4">
              {errorBars ? (
                <StackedBars
                  labels={errorBars.labels}
                  series={errorBars.series}
                  width={600}
                  height={140}
                />
              ) : (
                <div className="text-[12px] text-[var(--ink-3)] py-8 text-center">
                  窗口内无请求
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Pill tone="ok">成功 {fmtInt(data.errorRate.ok)}</Pill>
                <Pill tone="warn">网关拦截 {fmtInt(data.errorRate.gw)}</Pill>
                <Pill tone="err">上游错误 {fmtInt(data.errorRate.up)}</Pill>
              </div>
            </div>
          </section>

          <section className="grid md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <h3 className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">
                按模型 · 延迟 (2xx)
              </h3>
              <div className="bg-[var(--surface)] border border-[var(--rule)]">
                <Table
                  rows={latencyByModelRows}
                  columns={modelPercentileColumns}
                  emptyLabel="窗口内无成功样本"
                />
              </div>
            </div>
            <div className="space-y-2">
              <h3 className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">
                按模型 · 首 token (流式)
              </h3>
              <div className="bg-[var(--surface)] border border-[var(--rule)]">
                <Table
                  rows={firstTokenByModelRows}
                  columns={modelPercentileColumns}
                  emptyLabel="窗口内无流式样本"
                />
              </div>
            </div>
          </section>

          <section className="grid md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <h3 className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">
                请求量 · 按模型
              </h3>
              <div className="bg-[var(--surface)] border border-[var(--rule)] p-2">
                <TopBarTable
                  rows={data.volume.byModel}
                  labelHeader="模型"
                  emptyLabel="窗口内无请求"
                />
              </div>
            </div>
            <div className="space-y-2">
              <h3 className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">
                请求量 · 按 OAuth 账号
              </h3>
              <div className="bg-[var(--surface)] border border-[var(--rule)] p-2">
                <TopBarTable
                  rows={data.volume.byAccount}
                  labelHeader="账号"
                  emptyLabel="窗口内无请求"
                />
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">
              拦截原因 Top 12
            </h3>
            <div className="bg-[var(--surface)] border border-[var(--rule)]">
              <Table
                rows={data.errorRate.byReason.map((r, i) => ({
                  ...r,
                  id: `${r.reason}-${r.source ?? 'na'}-${i}`,
                }))}
                columns={[
                  {
                    key: 'reason',
                    header: '原因',
                    render: (row) => (
                      <span className="font-mono text-[11px]">{row.reason}</span>
                    ),
                  },
                  {
                    key: 'source',
                    header: '来源',
                    render: (row) => {
                      if (!row.source)
                        return <Pill tone="mute">—</Pill>
                      const tone = row.source === 'gw' ? 'warn' : row.source === 'up' ? 'err' : 'info'
                      return <Pill tone={tone}>{row.source}</Pill>
                    },
                    style: { width: '100px' },
                  },
                  {
                    key: 'n',
                    header: '次数',
                    render: (row) => (
                      <span className="font-mono text-[11px] tabular-nums">{fmtInt(row.n)}</span>
                    ),
                    className: 'text-right',
                    style: { width: '120px' },
                  },
                ]}
                emptyLabel="窗口内无拦截"
              />
            </div>
          </section>
        </>
      )}
    </div>
  )
}
