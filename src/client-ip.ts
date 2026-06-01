type HeaderValue = string | string[] | undefined

function firstHeaderValue(value: HeaderValue): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length > 0) return value[0]
  return null
}

function normalizeSocketAddress(address: string): string {
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
}

function isTrustedProxyAddress(address: string): boolean {
  const normalized = normalizeSocketAddress(address)
  if (normalized === '127.0.0.1' || normalized === '::1') return true
  if (normalized.startsWith('10.')) return true
  if (normalized.startsWith('192.168.')) return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true

  const parts = normalized.split('.').map(part => Number.parseInt(part, 10))
  if (parts.length === 4 && parts.every(part => Number.isInteger(part))) {
    return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
  }

  return false
}

function firstForwardedFor(value: string | null): string | null {
  if (!value) return null
  return value.split(',').map(part => part.trim()).find(Boolean) ?? null
}

function cleanHeaderIp(value: string | null): string | null {
  const cleaned = value?.trim()
  return cleaned || null
}

export function resolveClientIp(
  socketRemoteAddress: string | undefined,
  headers: Record<string, HeaderValue>,
): string {
  const socketAddress = socketRemoteAddress || 'unknown'
  if (!isTrustedProxyAddress(socketAddress)) return socketAddress

  return firstForwardedFor(firstHeaderValue(headers['x-forwarded-for']))
    ?? cleanHeaderIp(firstHeaderValue(headers['x-real-ip']))
    ?? socketAddress
}
