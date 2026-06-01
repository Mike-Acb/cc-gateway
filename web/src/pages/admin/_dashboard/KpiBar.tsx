import { StatGrid } from '../../../ui'

export type Kpis = {
  total: number
  successRate: number
  blocked: number
  activeAccounts: number
  activeUsers: number
  totalTokens: number
}

function fmt(n: number): string {
  return Number(n ?? 0).toLocaleString()
}

export default function KpiBar({ kpis }: { kpis: Kpis }) {
  return (
    <div className="space-y-2.5">
      <StatGrid
        cols={3}
        items={[
          { label: '总请求', value: fmt(kpis.total) },
          { label: '成功率', value: (kpis.successRate * 100).toFixed(1) + '%' },
          { label: '被拦截', value: fmt(kpis.blocked), tone: kpis.blocked > 0 ? 'warn' : '' },
        ]}
      />
      <StatGrid
        cols={3}
        items={[
          { label: '活跃账号', value: fmt(kpis.activeAccounts) },
          { label: '活跃用户', value: fmt(kpis.activeUsers) },
          { label: '总 Token', value: fmt(kpis.totalTokens) },
        ]}
      />
    </div>
  )
}
