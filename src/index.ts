import { loadConfig, getUpstreamAuthMode, setConfig } from './config.js'
import { setLogLevel, log } from './logger.js'

// Prevent uncaught errors in async callbacks (event emitter, logging)
// from crashing the entire gateway process.
process.on('uncaughtException', (err) => {
  log('error', `Uncaught exception (non-fatal): ${err.stack || err}`)
})
process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection (non-fatal): ${reason}`)
})

// PM2 reload/restart 时 SIGTERM/SIGINT 抵达 → flush 所有 inflight 的请求日志
// (response_status 仍是 NULL 的行) 后再退出。否则正在 stream 的请求 row 永远卡
// NULL,UI 表现为"日志丢失"。PM2 默认 kill_timeout=1600ms,保证 1s 内 flush 完。
let shuttingDown = false
async function gracefulShutdown(sig: string) {
  if (shuttingDown) return
  shuttingDown = true
  try {
    const flushed = await flushInflightLogs(sig)
    log('info', `Graceful shutdown (${sig}): flushed ${flushed} inflight request logs`)
  } catch (err) {
    log('error', `Graceful shutdown flush failed: ${err}`)
  }
  process.exit(0)
}
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM') })
process.on('SIGINT', () => { void gracefulShutdown('SIGINT') })
import { initDB } from './db.js'
import { startSync, ensureConfigClients } from './sync.js'
import { ensurePartitions } from './partition-manager.js'
import { initOAuth } from './oauth.js'
import { startProxy } from './proxy.js'
import { initRedis } from './redis.js'
import { startAccountPool, isPoolConfigured, reloadAccountPool } from './account-pool.js'
import { startOutboundProxyPool } from './proxy-agent.js'
import { flushInflightLogs } from './request-logger.js'
import { resolve } from 'path'

const configPath = process.argv[2]
const resolvedConfigPath = configPath || resolve(process.cwd(), 'config.yaml')

try {
  const config = loadConfig(configPath)
  setConfig(config)
  setLogLevel(config.logging.level)

  log('info', 'CC Gateway starting...')

  // Initialize database pool if configured
  if (config.database) {
    initDB(config.database)
    await ensurePartitions()
    await ensureConfigClients(config.auth.tokens)
    startSync()
    await startOutboundProxyPool()
  }

  // Listen for reload signals from admin panel.
  // Channel is namespaced per deployment so a NOTIFY from the prod admin
  // panel never wakes the gwbk gateway (and vice versa).
  if (config.database) {
    try {
      const { getPool, DEPLOYMENT } = await import('./db.js')
      const channel = reloadChannelForDeployment(DEPLOYMENT)
      const listenClient = await getPool().connect()
      await listenClient.query(`LISTEN ${channel}`)
      listenClient.on('notification', async (msg) => {
        log('info', `Received PG NOTIFY: ${msg.channel} → reloading account pool`)
        try {
          await reloadAccountPool()
          log('info', 'Account pool reloaded via NOTIFY')
        } catch (err) {
          log('error', `Reload failed: ${err}`)
        }
      })
      log('info', `Listening for ${channel} notifications`)
    } catch (err) {
      log('warn', `Failed to set up PG LISTEN: ${err}`)
    }
  }

  // Initialize Redis (await ready) + account pool (if configured)
  if (config.redis) {
    await initRedis(config.redis)
  }

  let poolStarted = false
  if (config.database) {
    await startAccountPool()
    poolStarted = isPoolConfigured()
  }

  const upstreamAuthMode = getUpstreamAuthMode(config)

  // Only initialize single-token OAuth as fallback if no account pool is configured
  if (!poolStarted && upstreamAuthMode === 'oauth_refresh') {
    await initOAuth(config.oauth!, resolvedConfigPath)
  } else if (!poolStarted) {
    log('info', 'upstream_auth.mode=static_bearer — skipping single-token OAuth init')
  } else {
    log('info', 'account-pool configured — skipping single-token OAuth init')
  }

  startProxy(config)
} catch (err) {
  log('error', `Fatal: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}

// Whitelist-guarded mapping from deployment tag to NOTIFY channel name.
// Must stay in sync with the identical helper in server/src/routes/admin.ts.
function reloadChannelForDeployment(deployment: string): string {
  switch (deployment) {
    case 'gw':
      return 'gateway_reload_gw'
    case 'gwbk':
      return 'gateway_reload_gwbk'
    default:
      throw new Error(`Unsupported deployment tag for LISTEN: ${deployment}`)
  }
}
