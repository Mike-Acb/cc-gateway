import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Segmented } from '../../ui'
import KpiBar, { type Kpis } from './_dashboard/KpiBar'
import SliceChart, { type SeriesPoint } from './_dashboard/SliceChart'
import TopLists, { type TopData } from './_dashboard/TopLists'

type Slice = 'time' | 'group' | 'account' | 'user' | 'model'
type Granularity = 'day' | 'hour'

type Dto = {
  kpis: Kpis
  series: SeriesPoint[]
  top: TopData
  groupKey: string
}

const SLICE_OPTIONS: { value: Slice; label: string }[] = [
  { value: 'time', label: '时间' },
  { value: 'group', label: '账号组' },
  { value: 'account', label: 'OAuth 账号' },
  { value: 'user', label: '用户' },
  { value: 'model', label: '模型' },
]

const GRANULARITY_OPTIONS: { value: Granularity; label: string }[] = [
  { value: 'day', label: '按天' },
  { value: 'hour', label: '按小时' },
]

export default function AdminDashboardPage() {
  const [slice, setSlice] = useState<Slice>('time')
  const [granularity, setGranularity] = useState<Granularity>('day')
  const [data, setData] = useState<Dto | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    const qs = new URLSearchParams({ slice, granularity })
    api<Dto>(`/admin/overview?${qs.toString()}`)
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
  }, [slice, granularity])

  return (
    <div className="max-w-[1200px] mx-auto space-y-7">
      <header>
        <h1 className="text-[26px] font-serif">总览</h1>
        <p className="text-[13px] text-[var(--mute)] mt-1">系统整体健康 · 近 7 天</p>
      </header>

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
          <KpiBar kpis={data.kpis} />

          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">切片</span>
                <Segmented<Slice>
                  value={slice}
                  options={SLICE_OPTIONS}
                  onChange={setSlice}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">粒度</span>
                <Segmented<Granularity>
                  value={granularity}
                  options={GRANULARITY_OPTIONS}
                  onChange={setGranularity}
                />
              </div>
            </div>
            <SliceChart series={data.series} granularity={granularity} />
          </section>

          <section className="space-y-3">
            <h2 className="text-[14px] font-medium">榜单</h2>
            <TopLists top={data.top} />
          </section>
        </>
      )}
    </div>
  )
}
