import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Button, Field, Input, Pill, StatGrid } from '../../ui'
import ProxyTable from './_system/ProxyTable'
import WebhooksTable from './_system/WebhooksTable'

interface SystemInfo {
  version: string
  commit: string
  deployedAt: string | null
  deployment: string
  nodeVersion: string
  uptimeSec: number
}

interface GatewayHealth {
  status?: string
  oauth?: string
  pool?: string
  detail?: string
  default_profile?: string | null
  upstream?: string
  clients?: string[]
  error?: string
}

interface ReloadReport {
  ok?: boolean
  mode?: string
  message?: string
  elapsed_ms?: number
  error?: string | null
  pool_transition?: string
  accounts_before?: number
  accounts_after?: number
  accounts_added?: string[]
  accounts_removed?: string[]
  tokens_refreshed?: string[]
  default_profile_before?: string | null
  default_profile_after?: string | null
  actions?: string[]
}

type Toast = { message: string; tone: 'ok' | 'err' } | null

function fmtDateTime(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function fmtUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function ToastView({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(onClose, 3500)
    return () => clearTimeout(t)
  }, [toast, onClose])
  if (!toast) return null
  const color = toast.tone === 'err' ? 'var(--err)' : 'var(--ok)'
  return (
    <div className="fixed top-6 right-6 z-[60]">
      <div
        className="flex items-center gap-3 bg-[var(--surface)] border px-4 py-2.5 rounded text-[12px]"
        style={{ borderColor: color, color }}
      >
        <span>{toast.message}</span>
        <button onClick={onClose} className="text-[var(--ink-3)] hover:text-[var(--ink)]">×</button>
      </div>
    </div>
  )
}

interface SettingRow {
  key: string
  value: string
  updated_at: string | null
}

export default function AdminSystemPage() {
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [infoLoading, setInfoLoading] = useState(true)
  const [infoError, setInfoError] = useState<string | null>(null)
  const [gateway, setGateway] = useState<GatewayHealth | null>(null)
  const [gatewayLoading, setGatewayLoading] = useState(true)
  const [gatewayError, setGatewayError] = useState<string | null>(null)
  const [reloading, setReloading] = useState(false)
  const [refreshingGateway, setRefreshingGateway] = useState(false)
  const [lastReload, setLastReload] = useState<{ at: string; report: ReloadReport } | null>(null)
  const [toast, setToast] = useState<Toast>(null)

  const [rate, setRate] = useState<string>('')
  const [rateLoaded, setRateLoaded] = useState<string>('')
  const [rateUpdatedAt, setRateUpdatedAt] = useState<string | null>(null)
  const [rateSaving, setRateSaving] = useState(false)

  const [prebill, setPrebill] = useState<string>('')
  const [prebillLoaded, setPrebillLoaded] = useState<string>('')
  const [prebillUpdatedAt, setPrebillUpdatedAt] = useState<string | null>(null)
  const [prebillSaving, setPrebillSaving] = useState(false)

  const loadSettings = useCallback(async () => {
    try {
      const rows = await api<SettingRow[]>('/admin/settings')
      const r = rows.find((x) => x.key === 'cny_to_usd_rate')
      const val = r?.value ?? '1.0'
      setRate(val)
      setRateLoaded(val)
      setRateUpdatedAt(r?.updated_at ?? null)
      const p = rows.find((x) => x.key === 'prebill_usd')
      const pval = p?.value ?? '0.025'
      setPrebill(pval)
      setPrebillLoaded(pval)
      setPrebillUpdatedAt(p?.updated_at ?? null)
    } catch {
      // non-fatal; keep defaults
    }
  }, [])

  useEffect(() => { loadSettings() }, [loadSettings])

  const saveRate = async () => {
    const n = Number(rate)
    if (!Number.isFinite(n) || n <= 0) {
      setToast({ message: '汇率必须是大于 0 的数字', tone: 'err' })
      return
    }
    setRateSaving(true)
    try {
      const row = await api<SettingRow>('/admin/settings/cny_to_usd_rate', {
        method: 'PUT',
        body: JSON.stringify({ value: String(n) }),
      })
      setRateLoaded(row.value)
      setRate(row.value)
      setRateUpdatedAt(row.updated_at ?? null)
      setToast({ message: `汇率已更新为 1 CNY = ${n} USD`, tone: 'ok' })
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : '保存失败', tone: 'err' })
    } finally {
      setRateSaving(false)
    }
  }

  const savePrebill = async () => {
    const n = Number(prebill)
    if (!Number.isFinite(n) || n < 0) {
      setToast({ message: '预扣金额必须是 ≥ 0 的数字', tone: 'err' })
      return
    }
    setPrebillSaving(true)
    try {
      const row = await api<SettingRow>('/admin/settings/prebill_usd', {
        method: 'PUT',
        body: JSON.stringify({ value: String(n) }),
      })
      setPrebillLoaded(row.value)
      setPrebill(row.value)
      setPrebillUpdatedAt(row.updated_at ?? null)
      setToast({ message: `预扣金额已更新为 $${n}`, tone: 'ok' })
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : '保存失败', tone: 'err' })
    } finally {
      setPrebillSaving(false)
    }
  }

  const loadInfo = useCallback(async () => {
    try {
      const data = await api<SystemInfo>('/admin/system/info')
      setInfo(data)
      setInfoError(null)
    } catch (err) {
      setInfoError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setInfoLoading(false)
    }
  }, [])

  useEffect(() => { loadInfo() }, [loadInfo])

  const loadGateway = useCallback(async () => {
    try {
      const data = await api<GatewayHealth>('/admin/system/gateway')
      setGateway(data)
      setGatewayError(null)
    } catch (err) {
      setGateway(null)
      setGatewayError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setGatewayLoading(false)
    }
  }, [])

  useEffect(() => { loadGateway() }, [loadGateway])

  const refreshGateway = async () => {
    setRefreshingGateway(true)
    try {
      await loadGateway()
    } finally {
      setRefreshingGateway(false)
    }
  }

  const reload = async () => {
    setReloading(true)
    try {
      const result = await api<ReloadReport>(
        '/admin/system/reload', { method: 'POST' },
      )
      setLastReload({ at: new Date().toISOString(), report: result })
      const ms = result?.elapsed_ms ? ` (${result.elapsed_ms}ms)` : ''
      setToast({ message: (result?.message ?? '已重载') + ms, tone: 'ok' })
      await loadGateway()
    } catch (err) {
      setLastReload({
        at: new Date().toISOString(),
        report: { ok: false, error: err instanceof Error ? err.message : '重载失败' },
      })
      setToast({ message: err instanceof Error ? err.message : '重载失败', tone: 'err' })
    } finally {
      setReloading(false)
    }
  }

  return (
    <div className="max-w-[1200px] mx-auto space-y-10">
      <ToastView toast={toast} onClose={() => setToast(null)} />

      <header>
        <h1 className="font-serif text-[26px] text-[var(--ink)]">系统</h1>
        <p className="text-[12px] text-[var(--ink-3)] mt-1">
          运行信息 · 出站代理 · Webhooks
        </p>
      </header>

      {/* System info */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="font-serif text-[18px] text-[var(--ink)]">运行信息</h2>
            {info && <Pill tone={info.deployment === 'gwbk' ? 'warn' : 'info'}>{info.deployment}</Pill>}
          </div>
          <Button variant="primary" disabled={reloading} onClick={reload}>
            {reloading ? '重载中…' : '重载配置'}
          </Button>
        </div>

        {infoLoading && <div className="text-[12px] text-[var(--ink-3)]">加载中…</div>}

        {infoError && (
          <div className="border border-[var(--err)] bg-[#fbe4e4] p-3 text-[12px] text-[var(--err)]">
            {infoError}
          </div>
        )}

        {info && (
          <StatGrid
            cols={5}
            items={[
              { label: 'Version', value: <span className="text-[20px]">{info.version}</span> },
              {
                label: 'Commit',
                value: <span className="font-mono text-[20px]">{info.commit?.slice(0, 8) || '—'}</span>,
              },
              {
                label: 'Deployed',
                value: <span className="text-[16px]">{fmtDateTime(info.deployedAt)}</span>,
              },
              {
                label: 'Node',
                value: <span className="font-mono text-[18px]">{info.nodeVersion}</span>,
              },
              {
                label: 'Uptime',
                value: <span className="text-[20px]">{fmtUptime(info.uptimeSec)}</span>,
              },
            ]}
          />
        )}
      </section>

      {/* Gateway health */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-serif text-[18px] text-[var(--ink)]">网关状态</h2>
            <p className="text-[11px] text-[var(--ink-3)] mt-0.5">
              读取 gateway 的 <span className="font-mono">/_health</span> 返回，显示账号池和上游可用性。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="default" disabled={refreshingGateway} onClick={refreshGateway}>
              {refreshingGateway ? '刷新中…' : '刷新状态'}
            </Button>
            <Button variant="primary" disabled={reloading} onClick={reload}>
              {reloading ? '重载中…' : '重载 Gateway'}
            </Button>
          </div>
        </div>

        {gatewayLoading && <div className="text-[12px] text-[var(--ink-3)]">加载中…</div>}

        {gatewayError && (
          <div className="border border-[var(--err)] bg-[var(--accent-weak)] rounded p-3 text-[12px] text-[var(--err)]">
            {gatewayError}
          </div>
        )}

        {gateway && (
          <>
            <StatGrid
              cols={5}
              items={[
                {
                  label: 'Gateway',
                  value: (
                    <div className="flex items-center gap-2">
                      <span className={`inline-block h-2.5 w-2.5 rounded-full ${
                        gateway.status === 'ok' ? 'bg-[var(--ok)]' : 'bg-[var(--warn)]'
                      }`} />
                      <span className="text-[18px]">
                        {gateway.status === 'ok' ? '正常' : gateway.status || '—'}
                      </span>
                    </div>
                  ),
                },
                { label: 'OAuth', value: <span className="text-[18px]">{gateway.oauth || '—'}</span> },
                { label: 'Pool', value: <span className="text-[18px]">{gateway.pool || '—'}</span> },
                { label: 'Default Profile', value: <span className="text-[14px]">{gateway.default_profile || '—'}</span> },
                { label: 'Clients', value: <span className="text-[18px]">{gateway.clients?.length ?? 0}</span> },
              ]}
            />

            <div className="border border-[var(--rule)] rounded p-4 bg-[var(--surface)] space-y-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.14em] font-mono text-[var(--ink-3)] mb-1">
                  Detail
                </div>
                <div className="text-[13px] text-[var(--ink)]">
                  {gateway.detail || gateway.error || '—'}
                </div>
              </div>

              {gateway.upstream && (
                <div>
                  <div className="text-[10px] uppercase tracking-[0.14em] font-mono text-[var(--ink-3)] mb-1">
                    Upstream
                  </div>
                  <div className="font-mono text-[12px] text-[var(--ink)] break-all">{gateway.upstream}</div>
                </div>
              )}

              {gateway.clients && gateway.clients.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-[0.14em] font-mono text-[var(--ink-3)] mb-1">
                    Authorized Clients
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {gateway.clients.map((client) => (
                      <Pill key={client} tone="info">{client}</Pill>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {lastReload && (
          <div className="border border-[var(--rule)] rounded p-4 bg-[var(--surface)] space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-[13px] font-medium text-[var(--ink)]">最近一次重载</h3>
              <div className="text-[11px] text-[var(--ink-3)]">{fmtDateTime(lastReload.at)}</div>
            </div>
            {lastReload.report.ok === false ? (
              <div className="text-[13px] text-[var(--err)]">{lastReload.report.error || '重载失败'}</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[12px]">
                <div className="rounded bg-[var(--surface-2)] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-[0.14em] font-mono text-[var(--ink-3)]">Mode</div>
                  <div className="mt-1 text-[var(--ink)]">{lastReload.report.mode || '—'}</div>
                </div>
                <div className="rounded bg-[var(--surface-2)] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-[0.14em] font-mono text-[var(--ink-3)]">Elapsed</div>
                  <div className="mt-1 text-[var(--ink)]">{lastReload.report.elapsed_ms ? `${lastReload.report.elapsed_ms}ms` : '—'}</div>
                </div>
                <div className="rounded bg-[var(--surface-2)] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-[0.14em] font-mono text-[var(--ink-3)]">Pool</div>
                  <div className="mt-1 text-[var(--ink)]">{lastReload.report.pool_transition || '—'}</div>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Billing settings */}
      <section className="space-y-3">
        <div>
          <h2 className="font-serif text-[18px] text-[var(--ink)]">计费设置</h2>
          <p className="text-[11px] text-[var(--ink-3)] mt-0.5">
            人民币与美元的换算比例，用于套餐入账、降级差价退款等场景。
          </p>
        </div>
        <div className="border border-[var(--rule)] rounded p-4 flex flex-wrap items-end gap-4">
          <Field label="1 CNY 兑 USD" className="w-[200px]">
            <Input
              type="number"
              step="0.0001"
              min="0"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              disabled={rateSaving}
            />
          </Field>
          <div className="flex-1 min-w-[140px]">
            <div className="text-[10px] uppercase tracking-[0.14em] font-mono text-[var(--ink-3)] mb-1">
              当前生效
            </div>
            <div className="text-[13px] font-mono tabular-nums text-[var(--ink)]">
              1 CNY = {rateLoaded || '—'} USD
            </div>
            {rateUpdatedAt && (
              <div className="text-[11px] text-[var(--ink-3)] mt-0.5">
                上次更新 {fmtDateTime(rateUpdatedAt)}
              </div>
            )}
          </div>
          <Button
            variant="primary"
            disabled={rateSaving || rate === rateLoaded}
            onClick={saveRate}
          >
            {rateSaving ? '保存中…' : '保存'}
          </Button>
        </div>

        {/* Prebill amount — 扣费预扣设置 */}
        <div>
          <h3 className="text-[13px] text-[var(--ink)] font-medium">扣费设置</h3>
          <p className="text-[11px] text-[var(--ink-3)] mt-0.5">
            每次请求的默认预扣金额（USD），待真实账单回写后按差额结算。
          </p>
        </div>
        <div className="border border-[var(--rule)] rounded p-4 flex flex-wrap items-end gap-4">
          <Field label="预扣金额 (USD)" className="w-[200px]">
            <Input
              type="number"
              step="0.001"
              min="0"
              value={prebill}
              onChange={(e) => setPrebill(e.target.value)}
              disabled={prebillSaving}
              placeholder="0.025"
            />
          </Field>
          <div className="flex-1 min-w-[140px]">
            <div className="text-[10px] uppercase tracking-[0.14em] font-mono text-[var(--ink-3)] mb-1">
              当前生效
            </div>
            <div className="text-[13px] font-mono tabular-nums text-[var(--ink)]">
              ${prebillLoaded || '—'} / 请求
            </div>
            {prebillUpdatedAt && (
              <div className="text-[11px] text-[var(--ink-3)] mt-0.5">
                上次更新 {fmtDateTime(prebillUpdatedAt)}
              </div>
            )}
          </div>
          <Button
            variant="primary"
            disabled={prebillSaving || prebill === prebillLoaded}
            onClick={savePrebill}
          >
            {prebillSaving ? '保存中…' : '保存'}
          </Button>
        </div>
      </section>

      {/* Outbound proxies */}
      <section className="space-y-3">
        <div>
          <h2 className="font-serif text-[18px] text-[var(--ink)]">出站代理</h2>
          <p className="text-[11px] text-[var(--ink-3)] mt-0.5">
            共享代理池；账号通过 outbound_proxy_id 绑定。
          </p>
        </div>
        <ProxyTable onToast={setToast} />
      </section>

      {/* Webhooks */}
      <section className="space-y-3">
        <div>
          <h2 className="font-serif text-[18px] text-[var(--ink)]">Webhooks</h2>
          <p className="text-[11px] text-[var(--ink-3)] mt-0.5">
            跨用户查看配置；创建 / 编辑在用户自己的设置页。
          </p>
        </div>
        <WebhooksTable />
      </section>
    </div>
  )
}
