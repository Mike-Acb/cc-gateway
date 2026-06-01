// PM2 ecosystem for gwbk.example.com (preview/backup deployment)
// Deployed via scripts/deploy-gwbk.sh; copied on the remote to
// /home/ubuntu/gwbk/ecosystem.config.cjs and loaded with `pm2 startOrReload`.
//
// Ports:
//   gateway-bk    :8444 (gw prod uses :8443)
//   api-server-bk :3001 (gw prod uses :3000)
//
// Both processes set DEPLOYMENT=gwbk so the shared PostgreSQL rows on
// users / clients / oauth_accounts stay isolated from the gw deployment.

module.exports = {
  apps: [
    {
      name: 'gateway-bk',
      cwd: '/home/ubuntu/gwbk',
      script: 'node_modules/.bin/tsx',
      args: 'src/index.ts',
      env: {
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        NODE_ENV: 'production',
        PORT: '8444',
        DEPLOYMENT: 'gwbk',
        DB_HOST: '127.0.0.1',
        DB_PORT: '5432',
        DB_NAME: 'cc_gateway_bk',
        DB_USER: 'cc_gateway',
        DB_PASSWORD: 'change-me-password',
      },
      watch: false,
      max_memory_restart: '500M',
      // SIGTERM 后给 5s 让 flushInflightLogs 把 NULL response_status 的 trace
      // 写完。默认 1.6s 在并发流量高时不够用 → request_logs 卡 NULL = UI 日志丢失。
      kill_timeout: 5000,
      error_file: '/home/ubuntu/gwbk/logs/gateway-bk-error.log',
      out_file: '/home/ubuntu/gwbk/logs/gateway-bk-out.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'api-server-bk',
      cwd: '/home/ubuntu/gwbk/server',
      script: 'node_modules/.bin/tsx',
      args: 'src/index.ts',
      env: {
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        NODE_ENV: 'production',
        PORT: '3001',
        DEPLOYMENT: 'gwbk',
        CORS_ORIGIN: 'https://gwbk.example.com',
        APP_URL: 'https://gwbk.example.com',
        DB_HOST: '127.0.0.1',
        DB_PORT: '5432',
        DB_NAME: 'cc_gateway_bk',
        DB_USER: 'cc_gateway',
        DB_PASSWORD: 'change-me-password',
        JWT_SECRET: 'cc-gw-77a2608061a4ee2e1692532618aa034a',
        JWT_REFRESH_SECRET: 'cc-gw-ref-86349d0f7ea81b9adf1e514957d81cc0',
        REDIS_HOST: '127.0.0.1',
        REDIS_PORT: '6379',
        REDIS_PASSWORD: 'redis_mBbBaT',
        GATEWAY_HEALTH_URL: 'https://127.0.0.1:8444/_health',
        GATEWAY_RELOAD_URL: 'https://127.0.0.1:8444/_reload',
      },
      watch: false,
      max_memory_restart: '300M',
      error_file: '/home/ubuntu/gwbk/logs/api-server-bk-error.log',
      out_file: '/home/ubuntu/gwbk/logs/api-server-bk-out.log',
      merge_logs: true,
      time: true,
    },
  ],
}
