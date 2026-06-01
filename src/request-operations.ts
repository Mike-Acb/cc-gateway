import { query } from './db.js'
import { log } from './logger.js'
import type { RequestFamily } from './request-shapes.js'

export type CreateRequestOperationInput = {
  id: string
  rootTraceId: string
  clientName: string
  oauthAccountId: string | null
  oauthAccountName: string | null
  sessionKey: string | null
  rootFamily: RequestFamily
  rootProfile: string
  summary?: Record<string, any>
}

export type ResolvedRequestOperation = {
  operationId: string
  rootTraceId: string
  parentTraceId: string | null
  isRoot: boolean
}

export async function createRequestOperation(input: CreateRequestOperationInput): Promise<void> {
  try {
    await query(
      `INSERT INTO request_operations
         (id, root_trace_id, client_name, oauth_account_id, oauth_account_name,
          session_key, root_family, root_profile, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.id,
        input.rootTraceId,
        input.clientName,
        input.oauthAccountId,
        input.oauthAccountName,
        input.sessionKey,
        input.rootFamily,
        input.rootProfile,
        input.summary ?? {},
      ],
    )
  } catch (err) {
    log('error', `Failed to create request operation: ${err}`)
  }
}

export async function closeRequestOperation(
  rootTraceId: string,
  status: 'completed' | 'failed' | 'blocked',
  summaryPatch?: Record<string, any>,
): Promise<void> {
  try {
    await query(
      `UPDATE request_operations
       SET status = $2,
           ended_at = COALESCE(ended_at, now()),
           summary = summary || $3::jsonb
       WHERE root_trace_id = $1`,
      [rootTraceId, status, JSON.stringify(summaryPatch ?? {})],
    )
  } catch (err) {
    log('error', `Failed to close request operation: ${err}`)
  }
}

export async function updateRequestOperationContext(
  rootTraceId: string,
  patch: {
    oauthAccountId?: string | null
    oauthAccountName?: string | null
    sessionKey?: string | null
    summaryPatch?: Record<string, any>
  },
): Promise<void> {
  try {
    await query(
      `UPDATE request_operations
       SET oauth_account_id = COALESCE($2, oauth_account_id),
           oauth_account_name = COALESCE($3, oauth_account_name),
           session_key = COALESCE($4, session_key),
           summary = summary || $5::jsonb
       WHERE root_trace_id = $1`,
      [
        rootTraceId,
        patch.oauthAccountId ?? null,
        patch.oauthAccountName ?? null,
        patch.sessionKey ?? null,
        JSON.stringify(patch.summaryPatch ?? {}),
      ],
    )
  } catch (err) {
    log('error', `Failed to update request operation context: ${err}`)
  }
}

export async function resolveRequestOperation(params: {
  operationId: string
  traceId: string
  clientName: string
  oauthAccountId: string | null
  oauthAccountName: string | null
  sessionKey: string | null
  family: RequestFamily
  profile: string
  summary?: Record<string, any>
}): Promise<ResolvedRequestOperation> {
  const childFamily = params.family === 'side_query' || params.family === 'count_tokens'

  if (childFamily && params.sessionKey) {
    try {
      const result = await query<{
        id: string
        root_trace_id: string
      }>(
        `SELECT id, root_trace_id
           FROM request_operations
          WHERE session_key = $1
            AND client_name = $2
            AND status = 'open'
            AND root_family IN ('repl_main_thread', 'compact')
            AND started_at >= now() - INTERVAL '15 minutes'
            AND ($3::uuid IS NULL OR oauth_account_id = $3 OR oauth_account_id IS NULL)
          ORDER BY started_at DESC
          LIMIT 1`,
        [params.sessionKey, params.clientName, params.oauthAccountId],
      )
      const row = result.rows[0]
      if (row) {
        return {
          operationId: row.id,
          rootTraceId: row.root_trace_id,
          parentTraceId: row.root_trace_id,
          isRoot: false,
        }
      }
    } catch (err) {
      log('error', `Failed to resolve request operation parent: ${err}`)
    }
  }

  await createRequestOperation({
    id: params.operationId,
    rootTraceId: params.traceId,
    clientName: params.clientName,
    oauthAccountId: params.oauthAccountId,
    oauthAccountName: params.oauthAccountName,
    sessionKey: params.sessionKey,
    rootFamily: params.family,
    rootProfile: params.profile,
    summary: params.summary,
  })
  return {
    operationId: params.operationId,
    rootTraceId: params.traceId,
    parentTraceId: null,
    isRoot: true,
  }
}
