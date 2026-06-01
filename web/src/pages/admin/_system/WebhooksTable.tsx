import { useEffect, useState } from 'react'
import { api } from '../../../api/client'
import { Pill, Table } from '../../../ui'
import type { Column } from '../../../ui/Table'

interface WebhookRow {
  id: string
  user_id: string
  username: string | null
  email: string | null
  url: string
  events: string[] | null
  enabled: boolean
  last_error: string | null
  created_at: string
}

function fmtDateTime(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

export default function WebhooksTable() {
  const [rows, setRows] = useState<WebhookRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<{ webhooks: WebhookRow[] }>('/admin/webhooks')
      .then((r) => setRows(r.webhooks ?? []))
      .catch((err) => setError(err instanceof Error ? err.message : '加载失败'))
      .finally(() => setLoading(false))
  }, [])

  const columns: Column<WebhookRow>[] = [
    {
      key: 'user', header: '所属用户',
      render: (r) => (
        <div>
          <div className="text-[12px] text-[var(--ink)]">{r.username ?? '—'}</div>
          <div className="text-[10px] text-[var(--ink-3)]">{r.email ?? r.user_id}</div>
        </div>
      ),
    },
    {
      key: 'url', header: 'URL',
      render: (r) => <span className="font-mono text-[11px] text-[var(--ink-2)] break-all">{r.url}</span>,
    },
    {
      key: 'events', header: '事件',
      render: (r) => (
        <div className="flex flex-wrap gap-1">
          {(r.events ?? []).map((ev) => <Pill key={ev} tone="info">{ev}</Pill>)}
        </div>
      ),
    },
    {
      key: 'enabled', header: '状态',
      render: (r) => <Pill tone={r.enabled ? 'ok' : 'mute'}>{r.enabled ? '启用' : '禁用'}</Pill>,
    },
    {
      key: 'last_error', header: '最近错误',
      render: (r) => r.last_error
        ? <span className="text-[11px] text-[var(--err)]" title={r.last_error}>{r.last_error.slice(0, 40)}</span>
        : <span className="text-[11px] text-[var(--ink-3)]">—</span>,
    },
    {
      key: 'created_at', header: '创建时间',
      render: (r) => <span className="text-[11px] text-[var(--ink-3)]">{fmtDateTime(r.created_at)}</span>,
    },
  ]

  if (error) {
    return <div className="border border-[var(--err)] bg-[#fbe4e4] p-3 text-[12px] text-[var(--err)]">{error}</div>
  }

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-[var(--ink-3)]">
        {loading ? '加载中…' : `共 ${rows.length} 个 webhook`}
      </div>
      <div className="border border-[var(--rule)] bg-[var(--surface)]">
        <Table rows={rows} columns={columns} emptyLabel="暂无 webhook。" />
      </div>
    </div>
  )
}
