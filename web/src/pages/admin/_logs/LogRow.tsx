export interface LogListItem {
  id: string
  trace_id: string | null
  created_at: string
  client_name: string | null
  oauth_account_name: string | null
  request_model: string | null
  response_status: number | null
  latency_ms: number | null
  first_token_ms: number | null
  streaming: boolean | null
  block_reason: string | null
  block_source: string | null
  error_message: string | null
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function fmtTime(value: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

interface Badge {
  tone: 'ok' | 'warn' | 'err' | 'info' | 'mute'
  label: string
}

export function statusBadge(log: LogListItem): Badge {
  // Gateway-blocked: always warn (user-facing / policy level).
  if (log.block_source === 'gw' && log.block_reason) {
    return { tone: 'warn', label: log.block_reason }
  }
  // Upstream error (block_source='up' OR any 4xx/5xx response).
  if (log.block_source === 'up' || (log.response_status !== null && log.response_status >= 400)) {
    const label = log.block_reason ?? (log.response_status !== null ? String(log.response_status) : 'error')
    return { tone: 'err', label }
  }
  // Unclassified block with no source — fall back to warn.
  if (log.block_reason) {
    return { tone: 'warn', label: log.block_reason }
  }
  if (log.response_status !== null && log.response_status >= 200 && log.response_status < 300) {
    return { tone: 'ok', label: String(log.response_status) }
  }
  return { tone: 'mute', label: log.response_status !== null ? String(log.response_status) : '-' }
}

export function sourceLabel(log: LogListItem): string {
  if (log.block_source === 'gw') return '网关'
  if (log.block_source === 'up') return '上游'
  return '-'
}

export function formatLogTime(value: string): string {
  return fmtTime(value)
}
