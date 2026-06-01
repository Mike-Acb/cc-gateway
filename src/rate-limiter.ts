import { log } from './logger.js'
import { getRateLimits } from './sync.js'

class SlidingWindowCounter {
  private windows = new Map<string, number[]>()

  check(key: string, maxRequests: number, windowMs: number): boolean {
    const now = Date.now()
    const cutoff = now - windowMs
    let timestamps = this.windows.get(key) ?? []
    timestamps = timestamps.filter(t => t > cutoff)
    if (timestamps.length >= maxRequests) {
      this.windows.set(key, timestamps)
      return false
    }
    timestamps.push(now)
    this.windows.set(key, timestamps)
    return true
  }

  cleanup(): void {
    const now = Date.now()
    for (const [key, timestamps] of this.windows) {
      const filtered = timestamps.filter(t => t > now - 3600_000)
      if (filtered.length === 0) {
        this.windows.delete(key)
      } else {
        this.windows.set(key, filtered)
      }
    }
  }
}

const rpmCounter = new SlidingWindowCounter()
const rphCounter = new SlidingWindowCounter()

setInterval(() => {
  rpmCounter.cleanup()
  rphCounter.cleanup()
}, 300_000)

export function checkRateLimit(clientId: string, userId?: string): string | null {
  const limits = getRateLimits()

  for (const limit of limits) {
    const matches =
      (limit.targetType === 'client' && limit.targetId === clientId) ||
      (limit.targetType === 'user' && userId && limit.targetId === userId)

    if (!matches) continue

    const key = `${limit.targetType}:${limit.targetId}`

    if (!rpmCounter.check(`${key}:rpm`, limit.maxRpm, 60_000)) {
      log('warn', `Rate limited (RPM): ${key}, max=${limit.maxRpm}`)
      return `Rate limit exceeded: ${limit.maxRpm} requests per minute`
    }

    if (limit.maxRph && !rphCounter.check(`${key}:rph`, limit.maxRph, 3600_000)) {
      log('warn', `Rate limited (RPH): ${key}, max=${limit.maxRph}`)
      return `Rate limit exceeded: ${limit.maxRph} requests per hour`
    }
  }

  return null
}
