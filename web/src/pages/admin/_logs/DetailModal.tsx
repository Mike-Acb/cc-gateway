import { useEffect, useState } from 'react'
import { api } from '../../../api/client'
import { Modal, Pill } from '../../../ui'
import { formatLogTime, statusBadge, sourceLabel, type LogListItem } from './LogRow'

const REDACT_HEADER_KEYS = new Set([
  'authorization',
  'cookie',
  'x-api-key',
  'proxy-authorization',
  'x-anthropic-auth',
])

function redactValue(input: unknown): unknown {
  if (input === null || input === undefined) return input
  if (Array.isArray(input)) return input.map(redactValue)
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const lk = k.toLowerCase()
      if (REDACT_HEADER_KEYS.has(lk) || /api[_-]?key/i.test(k)) {
        out[k] = '***'
      } else {
        out[k] = redactValue(v)
      }
    }
    return out
  }
  return input
}

function redactBody(raw: unknown): unknown {
  if (raw === null || raw === undefined) return raw
  if (typeof raw === 'string') {
    try {
      return redactValue(JSON.parse(raw))
    } catch {
      return raw
    }
  }
  return redactValue(raw)
}

interface DetailPayload extends LogListItem {
  client_id: string | null
  oauth_account_id: string | null
  method: string | null
  path: string | null
  client_ip: string | null
  request_body: unknown
  response_body: unknown
  retry_count: number | null
  request_headers_in: unknown
  request_headers_out: unknown
  request_body_out: unknown
  response_headers: unknown
}

export interface DetailModalProps {
  open: boolean
  logId: string | null
  onClose: () => void
}

export default function DetailModal({ open, logId, onClose }: DetailModalProps) {
  const [data, setData] = useState<DetailPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !logId) {
      setData(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    api<DetailPayload>(`/admin/request-logs/${encodeURIComponent(logId)}`)
      .then((r) => { if (!cancelled) setData(r) })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, logId])

  const badge = data ? statusBadge(data) : null

  return (
    <Modal open={open} onClose={onClose} title={data?.trace_id ? `trace ${data.trace_id}` : '详情'}>
      {loading && <div className="text-[12px] text-[var(--ink-3)]">加载中…</div>}
      {error && !loading && <div className="text-[12px] text-[var(--err)]">{error}</div>}
      {data && !loading && (
        <div className="space-y-3 text-[12px]">
          <div className="flex flex-wrap gap-2 items-center">
            {badge && <Pill tone={badge.tone}>{badge.label}</Pill>}
            <Pill tone="mute">{sourceLabel(data)}</Pill>
            {data.streaming && <Pill tone="info">流式</Pill>}
            {data.first_token_ms !== null && data.first_token_ms !== undefined && (
              <Pill tone="mute">首 token {data.first_token_ms} ms</Pill>
            )}
            {data.latency_ms !== null && data.latency_ms !== undefined && (
              <Pill tone="mute">延迟 {data.latency_ms} ms</Pill>
            )}
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[var(--ink-2)]">
            <div><span className="text-[var(--ink-3)]">时间：</span>{formatLogTime(data.created_at)}</div>
            <div><span className="text-[var(--ink-3)]">客户端：</span>{data.client_name ?? '-'}</div>
            <div><span className="text-[var(--ink-3)]">账号：</span>{data.oauth_account_name ?? '-'}</div>
            <div><span className="text-[var(--ink-3)]">模型：</span>{data.request_model ?? '-'}</div>
            <div><span className="text-[var(--ink-3)]">方法：</span>{data.method ?? '-'}</div>
            <div className="truncate"><span className="text-[var(--ink-3)]">路径：</span>{data.path ?? '-'}</div>
            <div><span className="text-[var(--ink-3)]">IP：</span>{data.client_ip ?? '-'}</div>
            <div><span className="text-[var(--ink-3)]">状态：</span>{data.response_status ?? '-'}</div>
          </div>

          <pre className="text-[11px] bg-[var(--rule-2)] p-3 max-h-[60vh] overflow-auto rounded whitespace-pre-wrap break-all">
{JSON.stringify({
  request_headers_in:  redactValue(data.request_headers_in),
  request_headers_out: redactValue(data.request_headers_out),
  request_body:        redactBody(data.request_body),
  request_body_out:    redactBody(data.request_body_out),
  response_headers:    redactValue(data.response_headers),
  response_body:       data.response_body,
  error_message:       data.error_message,
}, null, 2)}
          </pre>
        </div>
      )}
    </Modal>
  )
}
