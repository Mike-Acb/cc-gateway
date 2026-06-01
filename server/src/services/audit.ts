// Audit log service. Records structured mutation events from admin handlers.
//
// Usage:
//   import { audit } from '../services/audit.js'
//   await audit(req, { action: 'plan.update', resource_type: 'plan',
//                      resource_id: id, before, after, summary: '…' })
//
// Failures are swallowed (logged to console.error) — audit recording must
// never break a business response.

import type { Request } from 'express'
import { query } from '../db.js'

// Field names whose values must be scrubbed before persisting to audit_logs.
// Applies recursively to nested objects and arrays.
const REDACT_KEYS = new Set<string>([
  'access_token',
  'refresh_token',
  'api_key',
  'api_key_hash',
  'password_hash',
  'secret',
  'verified_token',
  'token', // clients.token is a bearer secret; log name/status instead.
])

export function sanitize<T>(value: T): T {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) {
    return value.map((v) => sanitize(v)) as unknown as T
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEYS.has(k)) {
        out[k] = v === null || v === undefined ? v : '***'
      } else {
        out[k] = sanitize(v)
      }
    }
    return out as unknown as T
  }
  return value
}

export type AuditActor = {
  actor_id: string | null
  actor_email: string | null
  ip: string | null
  user_agent: string | null
}

export function actorFromRequest(req: Request): AuditActor {
  const user = req.user
  const forwarded = req.headers['x-forwarded-for']
  const forwardedStr = Array.isArray(forwarded) ? forwarded[0] : forwarded
  const ip = (forwardedStr?.split(',')[0].trim()) || req.ip || null
  const ua = req.headers['user-agent']
  return {
    actor_id: user?.userId ?? null,
    // JWT carries username; we store that as the human-readable actor label.
    actor_email: user?.username ?? null,
    ip,
    user_agent: typeof ua === 'string' ? ua : null,
  }
}

export type AuditEntry = {
  action: string
  resource_type: string
  resource_id?: string | number | null
  before?: unknown
  after?: unknown
  summary?: string | null
}

export async function recordAudit(actor: AuditActor, entry: AuditEntry): Promise<void> {
  try {
    const beforeVal = entry.before === undefined ? null : sanitize(entry.before)
    const afterVal = entry.after === undefined ? null : sanitize(entry.after)
    await query(
      `INSERT INTO audit_logs
        (actor_id, actor_email, action, resource_type, resource_id,
         before, after, summary, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        actor.actor_id,
        actor.actor_email,
        entry.action,
        entry.resource_type,
        entry.resource_id == null ? null : String(entry.resource_id),
        beforeVal === null ? null : JSON.stringify(beforeVal),
        afterVal === null ? null : JSON.stringify(afterVal),
        entry.summary ?? null,
        actor.ip,
        actor.user_agent,
      ],
    )
  } catch (err) {
    console.error('[audit] insert failed:', (err as Error).message)
  }
}

export async function audit(req: Request, entry: AuditEntry): Promise<void> {
  return recordAudit(actorFromRequest(req), entry)
}
