import Redis from 'ioredis'

let redis: Redis | null = null

export function initRedis(): Redis | null {
  const host = process.env.REDIS_HOST
  if (!host) {
    console.log('Redis not configured (REDIS_HOST not set)')
    return null
  }
  redis = new Redis({
    host,
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      return Math.min(times * 200, 5000)
    },
  })
  redis.on('connect', () => console.log(`Redis connected: ${host}`))
  redis.on('error', (err) => console.error('Redis error:', err.message))
  return redis
}

export function getRedis(): Redis | null {
  if (!redis) {
    initRedis()
  }
  return redis
}

// Lazy init
initRedis()
