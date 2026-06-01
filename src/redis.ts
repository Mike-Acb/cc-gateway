import Redis from 'ioredis'
import { log } from './logger.js'

let redis: Redis | null = null

export function initRedis(config: { host: string; port: number; password?: string }): Promise<void> {
  return new Promise((resolve) => {
    redis = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        return Math.min(times * 200, 5000)
      },
    })
    redis.on('ready', () => {
      log('info', `Redis connected and ready: ${config.host}:${config.port}`)
      resolve()
    })
    redis.on('error', (err) => {
      log('error', `Redis error: ${err.message}`)
      // Resolve anyway after timeout so startup isn't blocked forever
    })
    // Safety timeout: don't block startup more than 5s
    setTimeout(() => {
      if (redis && redis.status !== 'ready') {
        log('warn', 'Redis not ready after 5s, proceeding without Redis')
      }
      resolve()
    }, 5000)
  })
}

export function getRedis(): Redis {
  if (!redis) throw new Error('Redis not initialized')
  return redis
}

export function isRedisAvailable(): boolean {
  return redis !== null && redis.status === 'ready'
}
