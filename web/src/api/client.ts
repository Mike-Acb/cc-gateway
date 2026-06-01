const BASE_URL = '/api'

let accessToken: string | null = localStorage.getItem('access_token')

export function setAccessToken(token: string | null) {
  accessToken = token
  if (token) {
    localStorage.setItem('access_token', token)
  } else {
    localStorage.removeItem('access_token')
  }
}

export function getAccessToken(): string | null {
  return accessToken
}

async function tryRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/auth/refresh`, { method: 'POST', credentials: 'include' })
    if (res.ok) {
      const data = await res.json()
      setAccessToken(data.accessToken)
      return true
    }
  } catch {}
  return false
}

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers as Record<string, string>,
  }
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`
  }

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers, credentials: 'include' })

  if (res.status === 401) {
    // Try refresh token
    const refreshed = await tryRefresh()
    if (refreshed) {
      headers['Authorization'] = `Bearer ${accessToken}`
      const retryRes = await fetch(`${BASE_URL}${path}`, { ...options, headers, credentials: 'include' })
      if (!retryRes.ok) {
        const error = await retryRes.json().catch(() => ({ error: `HTTP ${retryRes.status}` }))
        throw new Error(error.error || `HTTP ${retryRes.status}`)
      }
      return retryRes.json()
    }
    // Refresh failed
    setAccessToken(null)
    if (!path.includes('/auth/')) {
      window.location.href = '/login'
    }
    throw new Error('Session expired')
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(error.error || `HTTP ${res.status}`)
  }

  return res.json()
}
