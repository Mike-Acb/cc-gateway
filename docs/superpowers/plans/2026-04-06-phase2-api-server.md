# Phase 2: API Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the REST API server (Port 3000) that provides Dashboard backend, billing, payments, client management, and notification services.

**Architecture:** Standalone Express server sharing the same PostgreSQL database with the Gateway. JWT-based auth (access 15min + refresh 7d). All routes under `/api/`.

**Tech Stack:** Node.js 22+, TypeScript, Express, `pg` (reuse from Gateway), `bcryptjs`, `jsonwebtoken`, `node-cron`

---

### Task 1: API Server project scaffold

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/src/index.ts`
- Create: `server/src/app.ts`
- Create: `server/src/db.ts`

- [ ] Install dependencies in server/:
```bash
cd server && npm init -y
npm install express pg bcryptjs jsonwebtoken node-cron cors
npm install -D @types/express @types/bcryptjs @types/jsonwebtoken @types/cors @types/node tsx typescript
```

- [ ] Create `server/tsconfig.json` (ES module, strict, outDir dist)

- [ ] Create `server/src/db.ts` — PG pool (reuse same config pattern as gateway)

- [ ] Create `server/src/app.ts` — Express app with JSON body parser, CORS, error handler

- [ ] Create `server/src/index.ts` — Entry point: load config, init DB, start server on port 3000

- [ ] Add to root `package.json` scripts:
```json
"server:dev": "cd server && npx tsx watch src/index.ts",
"server:build": "cd server && npx tsc"
```

- [ ] Commit

---

### Task 2: JWT auth middleware + auth routes

**Files:**
- Create: `server/src/middleware/auth.ts`
- Create: `server/src/middleware/admin.ts`
- Create: `server/src/routes/auth.ts`

- [ ] Create JWT middleware — verify Bearer token, attach user to req
- [ ] Create admin middleware — check req.user.role === 'admin'
- [ ] Create auth routes:
  - `POST /api/auth/register` — hash password with bcrypt, create user, handle invite_code binding, return JWT
  - `POST /api/auth/login` — verify password, return JWT (access + refresh)
  - `POST /api/auth/refresh` — verify refresh token from httpOnly cookie, issue new access
  - `POST /api/auth/logout` — clear refresh cookie
  - `GET /api/auth/me` — return current user info
  - `PATCH /api/auth/me` — update email/password
- [ ] Commit

---

### Task 3: Client management routes

**Files:**
- Create: `server/src/routes/clients.ts`
- Create: `server/src/services/launcher.ts`

- [ ] Create client routes:
  - `GET /api/clients` — list (user sees own, admin sees all)
  - `POST /api/clients` — create client, generate 64-char hex token, status=pending
  - `GET /api/clients/:id` — detail
  - `PATCH /api/clients/:id` — update name
  - `DELETE /api/clients/:id` — delete
  - `POST /api/clients/:id/suspend` — set status=suspended
  - `POST /api/clients/:id/activate` — set status=active
  - `GET /api/clients/:id/launcher` — generate and download launcher script
- [ ] Create admin client routes:
  - `GET /api/admin/clients/pending` — pending clients
  - `POST /api/admin/clients/:id/approve` — approve
  - `POST /api/admin/clients/:id/reject` — reject (delete)
- [ ] Create launcher service — dynamically generate cc-{name} shell script with embedded token/URL
- [ ] Commit

---

### Task 4: Usage statistics routes

**Files:**
- Create: `server/src/routes/usage.ts`

- [ ] Create usage routes:
  - `GET /api/usage/summary` — aggregated stats with ?range=today|7d|30d|custom&from=&to=
  - `GET /api/usage/timeline` — time series data with ?range=7d&granularity=hour|day
  - `GET /api/usage/records` — paginated detail records with ?client_id=&page=1&limit=50
  - `GET /api/admin/usage/overview` — global overview (all users)
  - `GET /api/admin/usage/ranking` — user ranking by usage
- [ ] Commit

---

### Task 5: Quota & rate limit management routes

**Files:**
- Create: `server/src/routes/quotas.ts`

- [ ] Create quota routes:
  - `GET /api/quotas` — my quota rules
  - `GET /api/quotas/status` — current consumption vs limits
  - `GET /api/admin/quotas` — all rules
  - `POST /api/admin/quotas` — create rule
  - `PATCH /api/admin/quotas/:id` — update
  - `DELETE /api/admin/quotas/:id` — delete
  - `GET /api/admin/rate-limits` — all rate limits
  - `POST /api/admin/rate-limits` — create
  - `PATCH /api/admin/rate-limits/:id` — update
  - `DELETE /api/admin/rate-limits/:id` — delete
- [ ] Commit

---

### Task 6: Billing — invoices, daily costs, model pricing

**Files:**
- Create: `server/src/routes/invoices.ts`
- Create: `server/src/services/billing.ts`

- [ ] Create billing service:
  - `generateMonthlyInvoices(periodStart, periodEnd)` — query usage_records, aggregate by model, calculate token costs, calculate cost shares from daily_costs, apply discounts/credits, create invoices + invoice_items
- [ ] Create invoice routes:
  - `GET /api/invoices` — my invoices
  - `GET /api/invoices/:id` — detail with items
  - `POST /api/admin/invoices/generate` — trigger manual generation
  - `GET /api/admin/daily-costs` — list
  - `POST /api/admin/daily-costs` — set
  - `PATCH /api/admin/daily-costs/:id` — update
  - `GET /api/admin/model-pricing` — list
  - `POST /api/admin/model-pricing` — add
  - `PATCH /api/admin/model-pricing/:id` — update
- [ ] Commit

---

### Task 7: Payment integration (易支付)

**Files:**
- Create: `server/src/routes/payments.ts`
- Create: `server/src/services/payment.ts`

- [ ] Create payment service:
  - `createPayment(invoiceId, userId, couponId?)` — generate out_trade_no, call 易支付 API, return pay_url
  - `handleNotify(params)` — verify signature, update payment/invoice status, restore suspended clients
- [ ] Create payment routes:
  - `POST /api/payments/create` — initiate payment
  - `POST /api/payments/notify` — 易支付 async callback (no auth)
  - `GET /api/payments/return` — redirect back to dashboard
  - `GET /api/payments` — my payment history
- [ ] Commit

---

### Task 8: Notifications & Webhooks

**Files:**
- Create: `server/src/routes/notifications.ts`
- Create: `server/src/routes/webhooks.ts`
- Create: `server/src/services/notification.ts`

- [ ] Create notification service:
  - `createNotification(userId, type, title, content)` — insert + trigger webhooks
  - `sendWebhook(config, event)` — POST to webhook URL with HMAC signature
- [ ] Create notification routes:
  - `GET /api/notifications` — list (?unread=true)
  - `PATCH /api/notifications/:id/read` — mark read
  - `POST /api/notifications/read-all` — mark all read
  - `GET /api/notifications/count` — unread count
  - `POST /api/admin/notifications/broadcast` — send to all
- [ ] Create webhook routes:
  - `GET /api/webhooks` — my webhooks
  - `POST /api/webhooks` — create
  - `PATCH /api/webhooks/:id` — update
  - `DELETE /api/webhooks/:id` — delete
  - `POST /api/webhooks/:id/test` — send test event
- [ ] Commit

---

### Task 9: Campaigns, invites, rewards

**Files:**
- Create: `server/src/routes/campaigns.ts`
- Create: `server/src/routes/invites.ts`
- Create: `server/src/services/reward.ts`

- [ ] Create reward service:
  - `processInviteBinding(inviteeId, inviteCode)` — validate, create binding, issue rewards to both parties
  - `issueReward(userId, campaignId, rewardConfig)` — create reward + coupon records
- [ ] Create campaign routes (admin):
  - `GET /api/admin/campaigns` — list
  - `POST /api/admin/campaigns` — create with JSONB rewards config
  - `PATCH /api/admin/campaigns/:id` — update
  - `GET /api/admin/campaigns/:id/stats` — stats
- [ ] Create invite routes:
  - `GET /api/invite-codes` — my codes
  - `POST /api/invite-codes` — generate new code
  - `GET /api/invite-codes/:code/info` — public lookup
  - `POST /api/invite/bind` — bind invite code (5-day window)
  - `GET /api/invite/records` — my invite records
- [ ] Create reward/coupon routes:
  - `GET /api/rewards` — my rewards
  - `GET /api/coupons` — my coupons
  - `POST /api/coupons/:id/apply` — apply to invoice
- [ ] Commit

---

### Task 10: Admin routes + scheduled jobs

**Files:**
- Create: `server/src/routes/admin.ts`
- Create: `server/src/jobs/invoice-generator.ts`
- Create: `server/src/jobs/overdue-checker.ts`

- [ ] Create admin routes:
  - `GET /api/admin/users` — user list
  - `PATCH /api/admin/users/:id` — update role/status
  - `GET /api/admin/system/stats` — system stats
  - `GET /api/admin/system/gateway` — gateway health proxy
  - `POST /api/admin/system/reload` — trigger PG NOTIFY for gateway
- [ ] Create invoice generator job — run on 1st of each month via node-cron
- [ ] Create overdue checker job — run daily, check due_date, suspend clients after grace period
- [ ] Wire all routes into app.ts
- [ ] Commit

---

### Task 11: Integration test + final verification

- [ ] Start API server and test key endpoints with curl
- [ ] Verify register → login → create client → list flow
- [ ] Run `npm test` in server/
- [ ] Final commit
