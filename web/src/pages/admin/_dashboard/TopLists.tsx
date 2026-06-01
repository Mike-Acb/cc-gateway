import { Table } from '../../../ui'

export type TopEntry = { label: string; v: number }

export type TopData = {
  users: TopEntry[]
  models: TopEntry[]
  clients: TopEntry[]
  blocks: TopEntry[]
}

function TopCard({ title, rows, emptyLabel }: { title: string; rows: TopEntry[]; emptyLabel: string }) {
  const max = rows.reduce((acc, r) => Math.max(acc, Number(r.v) || 0), 0) || 1
  const withId = rows.map((r, i) => ({ ...r, id: `${r.label}-${i}` }))

  return (
    <section className="border border-[var(--rule)] bg-[var(--surface)] p-4">
      <h3 className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)] mb-3">{title}</h3>
      <Table
        rows={withId}
        emptyLabel={emptyLabel}
        columns={[
          {
            key: 'label',
            header: '名称',
            render: (r) => (
              <div className="flex items-center gap-2">
                <span className="truncate max-w-[240px]" title={r.label}>
                  {r.label || '(空)'}
                </span>
                <span
                  className="inline-block h-[6px] bg-[var(--ink-2)] opacity-40"
                  style={{ width: `${Math.max(4, (Number(r.v) / max) * 80)}px` }}
                />
              </div>
            ),
          },
          {
            key: 'v',
            header: '次数',
            className: 'text-right tabular-nums text-[var(--ink-2)]',
            render: (r) => Number(r.v).toLocaleString(),
          },
        ]}
      />
    </section>
  )
}

export default function TopLists({ top }: { top: TopData }) {
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <TopCard title="Top 用户" rows={top.users ?? []} emptyLabel="无用户数据" />
      <TopCard title="Top 模型" rows={top.models ?? []} emptyLabel="无模型数据" />
      <TopCard title="Top 客户端" rows={top.clients ?? []} emptyLabel="无客户端数据" />
      <TopCard title="Top 拦截原因" rows={top.blocks ?? []} emptyLabel="没有被拦截的请求" />
    </div>
  )
}
