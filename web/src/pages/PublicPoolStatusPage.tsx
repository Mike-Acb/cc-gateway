import { useEffect, useState } from 'react'

interface Account {
  email_masked: string
  subscription: string
  status_category: 'normal' | 'cooldown' | 'invalid' | 'banned' | 'error_misc' | 'unknown'
  util_5h_pct: number | null
  rpm: number
  req_24h: number
}

interface Summary {
  normal: number
  cooldown: number
  invalid: number
  banned: number
  total_rpm: number
  total: number
}

interface PoolStatusResp {
  summary: Summary
  accounts: Account[]
  updated_at: string
}

const CATEGORY_LABEL: Record<Account['status_category'], string> = {
  normal: '正常',
  cooldown: '限流',
  invalid: '失效',
  banned: '封禁',
  error_misc: '异常',
  unknown: '-',
}

const CATEGORY_CLASS: Record<Account['status_category'], string> = {
  normal: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  cooldown: 'bg-amber-100 text-amber-700 border-amber-200',
  invalid: 'bg-red-100 text-red-700 border-red-200',
  banned: 'bg-zinc-800 text-zinc-100 border-zinc-700',
  error_misc: 'bg-orange-100 text-orange-700 border-orange-200',
  unknown: 'bg-stone-100 text-stone-600 border-stone-200',
}

function util5hColor(pct: number | null): string {
  if (pct == null) return 'text-stone-500'
  if (pct >= 95) return 'text-red-700 font-bold'
  if (pct >= 80) return 'text-orange-700 font-medium'
  if (pct >= 50) return 'text-amber-700'
  return 'text-emerald-700'
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', { hour12: false })
}

export default function PublicPoolStatusPage() {
  const [data, setData] = useState<PoolStatusResp | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchOnce = async () => {
      try {
        const resp = await fetch('/api/public/pool-status', {
          headers: { Accept: 'application/json' },
        })
        if (!resp.ok) {
          setError(`HTTP ${resp.status}`)
          return
        }
        const json = (await resp.json()) as PoolStatusResp
        setData(json)
        setError(null)
      } catch (e: any) {
        setError(e?.message ?? 'fetch failed')
      }
    }
    fetchOnce()
    const t = window.setInterval(fetchOnce, 5000)
    return () => window.clearInterval(t)
  }, [])

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--ink)] p-4 sm:p-8">
      <div className="max-w-[1200px] mx-auto space-y-6">
        {/* Header */}
        <header className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="font-serif text-[24px] sm:text-[28px] text-[var(--ink)]">号池实时状态</h1>
            <p className="text-[12px] text-[var(--ink-3)] mt-1">
              公开数据 · 每 5 秒自动刷新 · 最后更新: {data ? fmtTime(data.updated_at) : '加载中…'}
            </p>
          </div>
        </header>

        {error && (
          <div className="border border-[var(--err)] text-[var(--err)] p-3 text-sm rounded">
            加载失败: {error} (5 秒后重试)
          </div>
        )}

        {/* Summary cards */}
        {data && (
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
            <SummaryCard label="正常" value={data.summary.normal} colorClass="text-emerald-700" />
            <SummaryCard label="限流" value={data.summary.cooldown} colorClass="text-amber-700" />
            <SummaryCard label="失效" value={data.summary.invalid} colorClass="text-red-700" />
            <SummaryCard label="封禁" value={data.summary.banned} colorClass="text-zinc-900" />
            <SummaryCard label="共计" value={data.summary.total} colorClass="text-[var(--ink)]" />
            <SummaryCard label="全局 RPM" value={data.summary.total_rpm} colorClass="text-blue-700" />
          </div>
        )}

        {/* Accounts table */}
        {data && (
          <div className="border border-[var(--rule)] rounded overflow-hidden">
            <table className="w-full text-[12px]">
              <thead className="bg-[var(--mute-bg)] text-[10px] uppercase tracking-wider font-mono text-[var(--ink-3)]">
                <tr>
                  <th className="px-3 py-2 text-left">账号</th>
                  <th className="px-3 py-2 text-left">订阅</th>
                  <th className="px-3 py-2 text-left">状态</th>
                  <th className="px-3 py-2 text-right">5H 用量</th>
                  <th className="px-3 py-2 text-right">RPM</th>
                  <th className="px-3 py-2 text-right">24H 请求</th>
                </tr>
              </thead>
              <tbody>
                {data.accounts.map((acc, idx) => (
                  <tr
                    key={idx}
                    className="border-t border-[var(--rule)] hover:bg-[var(--mute-bg)]"
                  >
                    <td className="px-3 py-2 font-mono text-[var(--ink)]">{acc.email_masked}</td>
                    <td className="px-3 py-2">{acc.subscription}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border ${
                          CATEGORY_CLASS[acc.status_category]
                        }`}
                      >
                        {CATEGORY_LABEL[acc.status_category]}
                      </span>
                    </td>
                    <td className={`px-3 py-2 text-right font-mono tabular-nums ${util5hColor(acc.util_5h_pct)}`}>
                      {acc.util_5h_pct != null ? `${acc.util_5h_pct}%` : '-'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{acc.rpm}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {acc.req_24h.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.accounts.length === 0 && (
              <div className="p-6 text-center text-[var(--ink-3)] text-[12px]">
                没有正常运行的账号
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <p className="text-[10px] text-[var(--ink-3)] text-center mt-8">
          此页面仅展示当前号池实时状态,数据来自实际请求日志。
        </p>
      </div>
    </div>
  )
}

function SummaryCard({
  label,
  value,
  colorClass,
}: {
  label: string
  value: number
  colorClass: string
}) {
  return (
    <div className="border border-[var(--rule)] bg-[var(--surface)] rounded p-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)]">
        {label}
      </div>
      <div className={`mt-1 text-[24px] font-bold tabular-nums ${colorClass}`}>{value}</div>
    </div>
  )
}
