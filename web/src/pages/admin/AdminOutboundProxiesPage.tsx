import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import { dialog } from '../../ui'

const CARD_CLS = 'bg-white rounded-[14px] shadow-[0_1px_2px_rgba(0,0,0,0.04)] p-5'
const INPUT_CLS = 'w-full px-3 py-2 border border-[#d2d2d7] rounded-lg text-[14px] text-[#1d1d1f] placeholder:text-[#aeaeb2] focus:outline-none focus:ring-2 focus:ring-[#007aff]/30 focus:border-[#007aff] transition-colors'
const BTN_PRIMARY = 'px-4 py-2 bg-[#007aff] text-white text-[13px] font-medium rounded-lg hover:bg-[#0066d6] disabled:opacity-40 disabled:cursor-not-allowed transition-colors'
const BTN_SECONDARY = 'px-3 py-1.5 text-[12px] font-medium text-[#007aff] bg-[#007aff]/5 rounded-lg hover:bg-[#007aff]/10 transition-colors'
const BTN_DANGER = 'px-3 py-1.5 text-[12px] font-medium text-[#ff3b30] bg-[#ff3b30]/5 rounded-lg hover:bg-[#ff3b30]/10 transition-colors'

type ProxyRow = {
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

type ImportResult = {
  imported: number
  failed: number
  errors: Array<{ line: number; input: string; error: string }>
}

function fmtDateTime(date: string | null): string {
  if (!date) return '—'
  return new Date(date).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function fmtCooldown(date: string | null): string {
  if (!date) return '—'
  const diff = new Date(date).getTime() - Date.now()
  if (diff <= 0) return '已结束'
  const mins = Math.floor(diff / 60_000)
  const secs = Math.floor((diff % 60_000) / 1000)
  if (mins <= 0) return `${secs}秒`
  return `${mins}分${secs}秒`
}

export default function AdminOutboundProxiesPage() {
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [proxies, setProxies] = useState<ProxyRow[]>([])
  const [bulkInput, setBulkInput] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [toastTone, setToastTone] = useState<'ok' | 'err'>('ok')
  const [importResult, setImportResult] = useState<ImportResult | null>(null)

  // toast 3 秒自动消失
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(t)
  }, [toast])

  function showToast(msg: string, tone: 'ok' | 'err' = 'ok') {
    setToastTone(tone)
    setToast(msg)
  }

  const load = useCallback(async () => {
    try {
      const data = await api<{ proxies: ProxyRow[] }>('/admin/outbound-proxies')
      setProxies(data.proxies ?? [])
    } catch {
      setProxies([])
    }
  }, [])

  useEffect(() => {
    load().finally(() => setLoading(false))
  }, [load])

  const handleImport = async () => {
    if (!bulkInput.trim()) return
    setImporting(true)
    setImportResult(null)
    try {
      const result = await api<ImportResult>('/admin/outbound-proxies/import', {
        method: 'POST',
        body: JSON.stringify({ text: bulkInput }),
      })
      setImportResult(result)
      setBulkInput('')
      setToast(`导入完成: ${result.imported} 成功, ${result.failed} 失败`)
      await load()
    } catch (e) {
      setToast(e instanceof Error ? e.message : '导入失败')
    } finally {
      setImporting(false)
    }
  }

  const handleToggleStatus = async (proxy: ProxyRow) => {
    try {
      const next = proxy.status === 'active' ? 'disabled' : 'active'
      await api(`/admin/outbound-proxies/${proxy.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      })
      setToast(next === 'active' ? '代理已启用' : '代理已停用')
      await load()
    } catch (e) {
      setToast(e instanceof Error ? e.message : '更新失败')
    }
  }

  const handleDelete = async (proxy: ProxyRow) => {
    if (!(await dialog.confirm(`删除代理「${proxy.name}」？`, { danger: true }))) return
    try {
      await api(`/admin/outbound-proxies/${proxy.id}`, { method: 'DELETE' })
      setToast('代理已删除')
      await load()
    } catch (e) {
      setToast(e instanceof Error ? e.message : '删除失败')
    }
  }

  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const handleTest = async (proxy: ProxyRow) => {
    setTesting(s => ({ ...s, [proxy.id]: true }))
    try {
      const r = await api(`/admin/outbound-proxies/${proxy.id}/test`, { method: 'POST' })
      if (r.ok) {
        const parts: string[] = []
        if (r.ip) parts.push(r.ip)
        if (r.country) parts.push(r.country)
        parts.push(`${r.elapsed_ms}ms`)
        showToast(`✓ ${proxy.name}  ${parts.join(' · ')}`, 'ok')
      } else {
        showToast(`✗ ${proxy.name}  ${r.detail || '失败'}`, 'err')
      }
    } catch (e) {
      showToast(`✗ ${proxy.name}: ${e instanceof Error ? e.message : '测试失败'}`, 'err')
    } finally {
      setTesting(s => ({ ...s, [proxy.id]: false }))
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-[#86868b] text-[13px]">加载中...</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-[#1d1d1f]">代理池</h1>
          <p className="text-[13px] text-[#86868b] mt-0.5">
            这里维护可复用代理。具体是否走代理，由 OAuth 账号单独绑定；未绑定账号将直接出站。
          </p>
        </div>
        <div className="flex items-center gap-3">
          {toast && (
            <span className={`text-[12px] font-medium ${toastTone === 'err' ? 'text-[#ff3b30]' : 'text-[#34c759]'}`}>
              {toast}
            </span>
          )}
        </div>
      </div>

      <div className={CARD_CLS}>
        <div className="text-[14px] font-semibold text-[#1d1d1f] mb-3">一键导入</div>
        <textarea
          rows={8}
          value={bulkInput}
          onChange={(e) => setBulkInput(e.target.value)}
          className={INPUT_CLS + ' font-mono text-[12px]'}
          placeholder={[
            '1.2.3.4:443:USERNAME:PASSWORD',
            'socks5://USERNAME:PASSWORD@1.2.3.4:443',
            'http://user:pass@1.2.3.4:8080',
          ].join('\n')}
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="text-[12px] text-[#86868b] leading-5">
            支持换行分割。支持 `ip:port`、`ip:port:username:password`、以及带协议的 URL 格式。
          </div>
          <button onClick={handleImport} disabled={importing || !bulkInput.trim()} className={BTN_PRIMARY}>
            {importing ? '导入中...' : '导入代理'}
          </button>
        </div>
        {importResult && importResult.errors.length > 0 && (
          <div className="mt-4 rounded-xl border border-[#ff9500]/20 bg-[#ff9500]/6 p-4">
            <div className="text-[12px] font-medium text-[#b45f00] mb-2">导入错误</div>
            <div className="space-y-1.5 text-[12px] text-[#8a4d00]">
              {importResult.errors.map((item) => (
                <div key={`${item.line}-${item.input}`}>
                  第 {item.line} 行: {item.error} ({item.input})
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className={CARD_CLS}>
        <div className="flex items-center justify-between mb-4">
          <div className="text-[15px] font-semibold text-[#1d1d1f]">代理列表</div>
          <div className="text-[12px] text-[#86868b]">{proxies.length} 个代理</div>
        </div>

        {proxies.length === 0 ? (
          <div className="text-center text-[#86868b] text-[13px] py-10">暂无代理</div>
        ) : (
          <div className="space-y-3">
            {proxies.map((proxy) => {
              const active = proxy.status === 'active'
              return (
                <div key={proxy.id} className="rounded-xl border border-[#ececf1] p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="text-[14px] font-semibold text-[#1d1d1f]">{proxy.name}</div>
                        <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${active ? 'bg-[#34c759]/10 text-[#34c759]' : 'bg-[#8e8e93]/10 text-[#8e8e93]'}`}>
                          {active ? '启用' : '停用'}
                        </span>
                        {proxy.cooldown_until && new Date(proxy.cooldown_until).getTime() > Date.now() && (
                          <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#ff9500]/10 text-[#ff9500]">
                            冷却 {fmtCooldown(proxy.cooldown_until)}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-[12px] text-[#6e6e73] font-mono break-all">{proxy.display_url}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => handleTest(proxy)}
                        className={BTN_SECONDARY}
                        disabled={!!testing[proxy.id]}
                      >
                        {testing[proxy.id] ? '测试中…' : '测试'}
                      </button>
                      <button onClick={() => handleToggleStatus(proxy)} className={BTN_SECONDARY}>
                        {active ? '停用' : '启用'}
                      </button>
                      <button onClick={() => handleDelete(proxy)} className={BTN_DANGER}>
                        删除
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-2 md:grid-cols-5 gap-3 text-[12px]">
                    <div className="rounded-lg bg-[#f7f7f9] px-3 py-2">
                      <div className="text-[#86868b]">绑定账号</div>
                      <div className={`mt-1 font-semibold ${proxy.bound_count > 0 ? 'text-[#1d1d1f]' : 'text-[#86868b]'}`}>
                        {proxy.bound_count > 0
                          ? `${proxy.bound_count}${proxy.bound_active < proxy.bound_count ? ` (active ${proxy.bound_active})` : ''}`
                          : '未绑定'}
                      </div>
                    </div>
                    <div className="rounded-lg bg-[#f7f7f9] px-3 py-2">
                      <div className="text-[#86868b]">成功次数</div>
                      <div className="mt-1 text-[#1d1d1f] font-semibold">{proxy.success_count}</div>
                    </div>
                    <div className="rounded-lg bg-[#f7f7f9] px-3 py-2">
                      <div className="text-[#86868b]">失败次数</div>
                      <div className="mt-1 text-[#1d1d1f] font-semibold">{proxy.fail_count}</div>
                    </div>
                    <div className="rounded-lg bg-[#f7f7f9] px-3 py-2">
                      <div className="text-[#86868b]">最近使用</div>
                      <div className="mt-1 text-[#1d1d1f] font-medium">{fmtDateTime(proxy.last_used_at)}</div>
                    </div>
                    <div className="rounded-lg bg-[#f7f7f9] px-3 py-2">
                      <div className="text-[#86868b]">失败连击</div>
                      <div className="mt-1 text-[#1d1d1f] font-semibold">{proxy.failure_streak}</div>
                    </div>
                  </div>

                  {proxy.last_error && (
                    <div className="mt-3 rounded-lg bg-[#ff3b30]/6 border border-[#ff3b30]/15 px-3 py-2 text-[12px] text-[#c1271d]">
                      {proxy.last_error}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
