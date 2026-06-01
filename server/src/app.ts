import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import authRoutes from './routes/auth.js'
import { clientRouter, adminClientRouter } from './routes/clients.js'
import { usageRouter, adminUsageRouter } from './routes/usage.js'
import { quotaRouter, adminQuotaRouter, adminRateLimitRouter } from './routes/quotas.js'
import { invoiceRouter, adminInvoiceRouter } from './routes/invoices.js'
import { paymentRouter } from './routes/payments.js'
import { notificationRouter, adminNotificationRouter } from './routes/notifications.js'
import { webhookRouter } from './routes/webhooks.js'
import { adminCampaignRouter } from './routes/campaigns.js'
import { inviteRouter, inviteActionRouter, rewardRouter, couponRouter } from './routes/invites.js'
import { adminRouter } from './routes/admin.js'
import { groupsRouter, userGroupsRouter } from './routes/groups.js'
import { oauthAccountsRouter } from './routes/oauth-accounts.js'
import { ccDisguiseTemplatesRouter } from './routes/cc-disguise-templates.js'
import { outboundProxiesRouter } from './routes/outbound-proxies.js'
import { identityProfilesRouter } from './routes/identity-profiles.js'
import { requestLogsRouter } from './routes/request-logs.js'
import { plansPublicRouter, subscriptionPublicRouter, subscriptionRouter, adminPlansRouter } from './routes/plans.js'
import { auditRouter } from './routes/audit.js'
import dashboardRouter from './routes/dashboard.js'
import adminOverviewRouter from './routes/admin-overview.js'
import adminMetricsRouter from './routes/admin-metrics.js'
import usageMeRouter from './routes/usage-me.js'
import logsMeRouter from './routes/logs-me.js'
import billingMeRouter from './routes/billing-me.js'
import publicPoolRouter from './routes/public-pool.js'

const app = express()

app.use(cors({
  origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  credentials: true,
}))
app.use(express.json({ limit: '10mb' }))
app.use(cookieParser())
// Public routes (no auth required) ↓
app.use('/api/public', publicPoolRouter)

app.use('/api/auth', authRoutes)
app.use('/api/clients', clientRouter)
app.use('/api/admin/clients', adminClientRouter)
app.use('/api/usage', usageRouter)
app.use('/api/admin/usage', adminUsageRouter)
app.use('/api/quotas', quotaRouter)
app.use('/api/admin/quotas', adminQuotaRouter)
app.use('/api/admin/rate-limits', adminRateLimitRouter)
app.use('/api/invoices', invoiceRouter)
app.use('/api/admin/invoices', adminInvoiceRouter)
app.use('/api/payments', paymentRouter)
app.use('/api/notifications', notificationRouter)
app.use('/api/admin/notifications', adminNotificationRouter)
app.use('/api/webhooks', webhookRouter)
app.use('/api/admin/campaigns', adminCampaignRouter)
app.use('/api/invite-codes', inviteRouter)
app.use('/api/invite', inviteActionRouter)
app.use('/api/rewards', rewardRouter)
app.use('/api/coupons', couponRouter)
app.use('/api/admin/groups', groupsRouter)
app.use('/api/groups', userGroupsRouter)
app.use('/api/admin/audit', auditRouter)
app.use('/api/admin/oauth-accounts', oauthAccountsRouter)
app.use('/api/admin/cc-disguise-templates', ccDisguiseTemplatesRouter)
app.use('/api/admin/outbound-proxies', outboundProxiesRouter)
app.use('/api/admin/identity-profiles', identityProfilesRouter)
app.use('/api/admin/request-logs', requestLogsRouter)
app.use('/api/admin', adminOverviewRouter)
app.use('/api/admin', adminMetricsRouter)
app.use('/api/admin', adminRouter)
app.use('/api/plans', plansPublicRouter)
app.use('/api/subscription', subscriptionPublicRouter)   // notify + return (no auth)
app.use('/api/subscription', subscriptionRouter)         // user routes (auth required)
app.use('/api/admin/plans', adminPlansRouter)
app.use('/api/me', dashboardRouter)
app.use('/api/me', usageMeRouter)
app.use('/api/me', logsMeRouter)
app.use('/api/me', billingMeRouter)

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: '2coding-gateway-api', timestamp: new Date().toISOString() })
})

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err)
  res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' })
})

export default app
