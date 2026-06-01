import { useCallback, useEffect, useState } from 'react'
import { api } from '../../../api/client'
import { Button, Field, Modal, Pill, Table, dialog } from '../../../ui'
import type { Column } from '../../../ui/Table'

interface ProxyRow {
  id: string
  name: string
  scheme: string
  host: string
  port: number
  username: string | null
  status: string
  weight: number
  display_url: string
  has_password: boolean
  bound_count: number
  bound_active: number
  last_used_at: string | null
  last_error: string | null
  success_count: number
  fail_count: number
  failure_streak: number
  cooldown_until: string | null
  created_at: string
  updated_at: string
}

type Toast = { message: string; tone: 'ok' | 'err' } | null

function fmtDateTime(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

export default function ProxyTable({ onToast }: { onToast?: (t: Toast) => void }) {
  const [rows, setRows] = useState<ProxyRow[]>([])
  const [loading, setLoading] = useState(true)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importing, setImporting] = useState(false)
  const [importErrors, setImportErrors] = useState<Array<{ line: number; input: string; error: string }>>([])

  const load = useCallback(async () => {
    try {
      const data = await api<{ proxies: ProxyRow[] }>('/admin/outbound-proxies')
      setRows(data.proxies ?? [])
    } catch (err) {
      onToast?.({ message: err instanceof Error ? err.message : '加载失败', tone: 'err' })
      setRows([])
    }
  }, [onToast])

  useEffect(() => { load().finally(() => setLoading(false)) }, [load])

  const toggleStatus = async (proxy: ProxyRow) => {
    const next = proxy.status === 'active' ? 'disabled' : 'active'
    try {
      await api(`/admin/outbound-proxies/${proxy.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      })
      onToast?.({ message: next === 'active' ? '已启用' : '已停用', tone: 'ok' })
      await load()
    } catch (err) {
      onToast?.({ message: err instanceof Error ? err.message : '更新失败', tone: 'err' })
    }
  }

  const remove = async (proxy: ProxyRow) => {
    if (!(await dialog.confirm(`删除代理「${proxy.name}」？`, { danger: true }))) return
    try {
      await api(`/admin/outbound-proxies/${proxy.id}`, { method: 'DELETE' })
      onToast?.({ message: '已删除', tone: 'ok' })
      await load()
    } catch (err) {
      onToast?.({ message: err instanceof Error ? err.message : '删除失败', tone: 'err' })
    }
  }

  const submitImport = async () => {
    const text = importText.trim()
    if (!text) return
    setImporting(true)
    setImportErrors([])
    try {
      const result = await api<{ imported: number; failed: number; errors: typeof importErrors }>(
        '/admin/outbound-proxies/import',
        { method: 'POST', body: JSON.stringify({ text }) },
      )
      setImportErrors(result.errors ?? [])
      onToast?.({ message: `导入 ${result.imported} 条，失败 ${result.failed} 条`, tone: result.failed ? 'err' : 'ok' })
      if (!result.failed) {
        setImportOpen(false)
        setImportText('')
      }
      await load()
    } catch (err) {
      onToast?.({ message: err instanceof Error ? err.message : '导入失败', tone: 'err' })
    } finally {
      setImporting(false)
    }
  }

  const columns: Column<ProxyRow>[] = [
    { key: 'name', header: '名称', render: (r) => <span className="font-medium text-[var(--ink)]">{r.name}</span> },
    { key: 'scheme', header: '协议', render: (r) => <Pill tone="info">{r.scheme}</Pill> },
    {
      key: 'endpoint', header: '出口',
      render: (r) => <span className="font-mono text-[11px] text-[var(--ink-2)]">{r.host}:{r.port}</span>,
    },
    {
      key: 'status', header: '状态',
      render: (r) => {
        const active = r.status === 'active'
        const cooling = r.cooldown_until && new Date(r.cooldown_until).getTime() > Date.now()
        if (cooling) return <Pill tone="warn">冷却中</Pill>
        return <Pill tone={active ? 'ok' : 'mute'}>{active ? '启用' : '停用'}</Pill>
      },
    },
    {
      key: 'counts', header: '成功 / 失败',
      render: (r) => <span className="font-mono text-[11px] tabular-nums text-[var(--ink-2)]">{r.success_count} / {r.fail_count}</span>,
    },
    {
      key: 'bound', header: '绑定账号',
      render: (r) => r.bound_count > 0
        ? <Pill tone={r.bound_active > 0 ? 'info' : 'mute'}>{r.bound_count}{r.bound_active < r.bound_count ? ` (${r.bound_active} active)` : ''}</Pill>
        : <span className="text-[11px] text-[var(--ink-3)]">未绑定</span>,
    },
    { key: 'last_used', header: '最近使用', render: (r) => <span className="text-[11px] text-[var(--ink-3)]">{fmtDateTime(r.last_used_at)}</span> },
    {
      key: 'actions', header: '',
      render: (r) => (
        <div className="flex gap-1 justify-end">
          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); toggleStatus(r) }}>
            {r.status === 'active' ? '停用' : '启用'}
          </Button>
          <Button size="sm" variant="danger" onClick={(e) => { e.stopPropagation(); remove(r) }}>删除</Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-[var(--ink-3)]">
          {loading ? '加载中…' : (() => {
            const unbound = rows.filter(r => r.bound_count === 0).length
            return `共 ${rows.length} 个出站代理 · ${unbound} 个未绑定`
          })()}
        </div>
        <Button variant="primary" onClick={() => { setImportText(''); setImportErrors([]); setImportOpen(true) }}>
          导入代理
        </Button>
      </div>

      <div className="border border-[var(--rule)] bg-[var(--surface)]">
        <Table rows={rows} columns={columns} emptyLabel="暂无出站代理。" />
      </div>

      <Modal
        open={importOpen}
        title="导入出站代理"
        onClose={() => setImportOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setImportOpen(false)}>取消</Button>
            <Button variant="primary" disabled={importing || !importText.trim()} onClick={submitImport}>
              {importing ? '导入中…' : '导入'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="代理列表" hint="每行一个。支持 ip:port、ip:port:username:password、或带协议的 URL。">
            <textarea
              rows={10}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              className="w-full border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-1.5 font-mono text-[12px] text-[var(--ink)] rounded focus:outline-none focus:border-[var(--ink)]"
              placeholder={'66.17.66.129:443:user:pass\nsocks5://user:pass@1.2.3.4:1080\nhttp://user:pass@4.5.6.7:8080'}
            />
          </Field>
          {importErrors.length > 0 && (
            <div className="border border-[var(--warn)] bg-[#fbefd7] p-3 text-[11px] text-[var(--warn)] space-y-1">
              <div className="font-medium">导入错误：</div>
              {importErrors.map((e) => (
                <div key={`${e.line}-${e.input}`} className="font-mono">第 {e.line} 行：{e.error}（{e.input}）</div>
              ))}
            </div>
          )}
        </div>
      </Modal>
    </div>
  )
}
