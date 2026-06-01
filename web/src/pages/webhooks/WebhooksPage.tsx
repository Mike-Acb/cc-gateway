import { useEffect, useState, useCallback } from 'react'
import { api } from '../../api/client'
import { dialog } from '../../ui'

const CARD_CLS = 'bg-white rounded-[14px] shadow-[0_1px_2px_rgba(0,0,0,0.04)] p-5'
const INPUT_CLS = 'w-full px-3 py-2 border border-[#d2d2d7] rounded-lg text-[14px] text-[#1d1d1f] placeholder:text-[#aeaeb2] focus:outline-none focus:ring-2 focus:ring-[#007aff]/30 focus:border-[#007aff] transition-colors'

interface Webhook {
  id: string
  url: string
  secret: string | null
  events: string[]
  enabled: boolean
  last_error: string | null
  created_at: string
}

const EVENT_OPTIONS = ['quota_warn', 'invoice', 'payment', 'system', 'suspend']

export default function WebhooksPage() {
  const [webhooks, setWebhooks] = useState<Webhook[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [events, setEvents] = useState<string[]>([])
  const [testing, setTesting] = useState<string | null>(null)

  const fetchWebhooks = useCallback(async () => {
    try {
      const data = await api<Webhook[]>('/webhooks')
      setWebhooks(Array.isArray(data) ? data : [])
    } catch { setWebhooks([]) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchWebhooks() }, [fetchWebhooks])

  const resetForm = () => { setUrl(''); setSecret(''); setEvents([]); setEditId(null); setShowCreate(false) }

  const handleEdit = (w: Webhook) => {
    setUrl(w.url); setSecret(w.secret ?? ''); setEvents(w.events); setEditId(w.id); setShowCreate(true)
  }

  const handleSave = async () => {
    if (!url.trim() || events.length === 0) return
    try {
      const body = { url: url.trim(), secret: secret || null, events }
      if (editId) {
        await api(`/webhooks/${editId}`, { method: 'PATCH', body: JSON.stringify(body) })
      } else {
        await api('/webhooks', { method: 'POST', body: JSON.stringify(body) })
      }
      resetForm()
      await fetchWebhooks()
    } catch (e: any) { await dialog.alert(e.message) }
  }

  const handleDelete = async (id: string) => {
    if (!(await dialog.confirm('确定删除此 Webhook？', { danger: true }))) return
    await api(`/webhooks/${id}`, { method: 'DELETE' }).catch(() => {})
    await fetchWebhooks()
  }

  const handleTest = async (id: string) => {
    setTesting(id)
    try {
      await api(`/webhooks/${id}/test`, { method: 'POST' })
      await dialog.alert('测试事件已发送')
    } catch (e: any) { await dialog.alert('发送失败: ' + e.message) }
    finally { setTesting(null) }
  }

  if (loading) return <div className="flex items-center justify-center h-64 text-[#86868b] text-[13px]">加载中...</div>

  return (
    <div className="space-y-6 max-w-[700px] mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-[#1d1d1f]">Webhook</h1>
          <p className="text-[13px] text-[#86868b] mt-0.5">接收额度告警、账单、支付等事件通知</p>
        </div>
        <button onClick={() => { resetForm(); setShowCreate(true) }}
          className="px-4 py-2 bg-[#007aff] text-white text-[13px] font-medium rounded-lg hover:bg-[#0066d6] transition-colors">
          添加 Webhook
        </button>
      </div>

      {webhooks.length === 0 ? (
        <div className={`${CARD_CLS} text-center text-[#86868b] text-[13px] py-12`}>
          暂无 Webhook，点击上方按钮添加
        </div>
      ) : (
        <div className="space-y-3">
          {webhooks.map(w => (
            <div key={w.id} className={`${CARD_CLS} ${!w.enabled ? 'opacity-50' : ''}`}>
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-medium text-[#1d1d1f] truncate">{w.url}</div>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {w.events.map(e => (
                      <span key={e} className="px-2 py-0.5 bg-[#007aff]/10 text-[#007aff] rounded text-[11px] font-medium">{e}</span>
                    ))}
                  </div>
                  {w.last_error && (
                    <div className="mt-2 text-[11px] text-[#ff3b30] bg-[#ff3b30]/5 rounded px-2 py-1 truncate">
                      最近错误: {w.last_error}
                    </div>
                  )}
                </div>
                <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${w.enabled ? 'bg-[#34c759]' : 'bg-[#c7c7cc]'}`} />
              </div>
              <div className="flex gap-3 mt-3 pt-3 border-t border-[#f0f0f0]">
                <button onClick={() => handleEdit(w)} className="text-[12px] text-[#007aff] hover:underline">编辑</button>
                <button onClick={() => handleTest(w.id)} disabled={testing === w.id} className="text-[12px] text-[#ff9500] hover:underline">
                  {testing === w.id ? '发送中...' : '测试'}
                </button>
                <button onClick={() => handleDelete(w.id)} className="text-[12px] text-[#ff3b30] hover:underline">删除</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create/Edit modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/25 backdrop-blur-[2px]" onClick={resetForm} />
          <div className="relative bg-white rounded-2xl shadow-[0_8px_40px_rgba(0,0,0,0.12)] w-full max-w-[440px] mx-4">
            <div className="px-6 pt-6 pb-2">
              <h2 className="text-[18px] font-semibold text-[#1d1d1f]">{editId ? '编辑' : '添加'} Webhook</h2>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div>
                <label className="block text-[13px] font-medium mb-1.5">URL</label>
                <input className={INPUT_CLS} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/webhook" />
              </div>
              <div>
                <label className="block text-[13px] font-medium mb-1.5">Secret <span className="text-[11px] text-[#86868b] font-normal">（可选，用于 HMAC 签名验证）</span></label>
                <input className={INPUT_CLS} value={secret} onChange={e => setSecret(e.target.value)} placeholder="your-webhook-secret" />
              </div>
              <div>
                <label className="block text-[13px] font-medium mb-2">订阅事件</label>
                <div className="flex flex-wrap gap-2">
                  {EVENT_OPTIONS.map(ev => (
                    <button key={ev} onClick={() => setEvents(prev => prev.includes(ev) ? prev.filter(e => e !== ev) : [...prev, ev])}
                      className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${
                        events.includes(ev)
                          ? 'bg-[#007aff] text-white'
                          : 'bg-[#f5f5f7] text-[#6e6e73] hover:bg-[#e8e8ed]'
                      }`}>
                      {ev}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex gap-3 px-6 pb-6">
              <button onClick={resetForm} className="flex-1 py-2.5 text-[14px] font-medium text-[#1d1d1f] bg-[#f5f5f7] rounded-xl hover:bg-[#e8e8ed] transition-colors">取消</button>
              <button onClick={handleSave} disabled={!url.trim() || events.length === 0}
                className="flex-1 py-2.5 bg-[#007aff] text-white text-[14px] font-medium rounded-xl hover:bg-[#0066d6] disabled:opacity-40 transition-colors">
                {editId ? '保存' : '添加'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
