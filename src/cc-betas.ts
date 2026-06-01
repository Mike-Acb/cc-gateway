/**
 * Compute the two anthropic-beta value sets a real Claude Code client
 * produces, which are NOT the same:
 *
 *   - EVENT set  — base only (claude-code + oauth + (context-1m?) +
 *                  interleaved-thinking + redact-thinking +
 *                  context-management + prompt-caching-scope)
 *   - HEADER set — base + runtime (advisor-tool / advanced-tool-use /
 *                  effort / tool-search / structured-outputs as applicable)
 *
 * Cross-validated against HAR 2026-04-17 + 2026-04-19. Per-event rule
 * (HAR-derived, not inferable from source alone):
 *
 *   event_data.betas (top-level envelope):
 *     ├─ tengu_api_query, tengu_api_success                     → HEADER set
 *     └─ tengu_api_cache_breakpoints, tengu_sysprompt_block,
 *        tengu_api_before_normalize, tengu_api_after_normalize,
 *        tengu_tool_search_mode_decision, session-init events    → EVENT set
 *
 *   additional_metadata.betas (nested blob, only api_query/api_success carry it):
 *     → HEADER set (same as the top-level for those events)
 *
 *   HTTP anthropic-beta header on /v1/messages                    → HEADER set
 *   HTTP anthropic-beta header on /api/event_logging/v2/batch     → 'oauth-2025-04-20'
 *
 * Flag ORDER is significant. Anthropic's anti-abuse layer inspects list
 * order, not just set membership: if sonnet sends context-1m-2025-08-07
 * without entitlement the server returns
 * "Extra usage is required for long context requests." regardless of
 * whether other flags are present.
 *
 * Callers (Phase B will wire these):
 *   rewriter.buildCCHeaders              → getHeaderBetas(hints).join(',')
 *   event-emitter.emitApiQuery/Success   → getHeaderBetas(hints).join(',')
 *   event-emitter.other events           → getEventBetas(hints).join(',')
 *
 * Phase A introduces this module; rewriter/event-emitter are migrated in
 * Phase B (fix #5 + #1).
 */

export type BetaHints = {
  /** Model string, case-insensitive. Can be raw (`claude-opus-4-7`) or
   * client-marked (`claude-opus-4-7[1m]`). */
  model: string
  /** body.output_config?.format?.type === 'json_schema' */
  hasStructuredOutput?: boolean
  /** body.messages has any block with cache_control set. Used to decide
   * whether the context-1m flag should be included for opus-4-7 sessions
   * (real CC sends `[1m]` marker in model string when caching context). */
  hasCacheControl?: boolean
  /** Whether the current call is agentic (CC REPL) vs a one-shot
   * (session-title generation, side-query). Controls `claude-code-*`,
   * `advanced-tool-use-*` and `effort-*` inclusion. True for main-thread
   * /v1/messages with tools; false for haiku `generate_session_title`
   * side-queries. */
  isAgenticQuery?: boolean
  /** Gateway observes `tools` array with server-side tool-search signature.
   * When true, add `tool-search-2025-12-02` to header only (never event). */
  hasToolSearch?: boolean
  /** Admin-surface toggle for advisor-tool beta. Defaults true per HAR. */
  advisorEnabled?: boolean
}

const CONTEXT_1M = 'context-1m-2025-08-07'

/**
 * Base beta set — what ends up in event_data.betas.
 *
 * This is the `getMergedBetas(model, { isAgenticQuery })` output in real
 * CC (`src/utils/betas.ts:375-406`). It does NOT include advisor-tool,
 * effort, structured-outputs, or tool-search — those are appended ONLY to
 * the HTTP header (see `getHeaderBetas` below).
 *
 * Order is significant.
 */
export function getEventBetas(hints: BetaHints): string[] {
  const modelLower = (hints.model ?? '').toLowerCase()
  const isHaiku = modelLower.includes('haiku')
  const isOpus = modelLower.includes('opus')
  const isAgentic = hints.isAgenticQuery ?? !isHaiku

  const out: string[] = []

  // claude-code family flag — only for agentic queries (REPL main thread),
  // never for haiku session-title / side-query paths.
  if (isAgentic) {
    out.push('claude-code-20250219')
  }

  out.push('oauth-2025-04-20')

  // context-1m:
  //   - opus-4.6 always has it (entitlement flag, model does not embed 1M)
  //   - opus-4.7+ has it ONLY when session is using 1M-context mode, which
  //     real CC signals via `[1m]` marker in model string AND via
  //     has1mContext(model) returning true. Gateway-side proxy: we see
  //     `[1m]` in event_data.model, but the API body strips it. Fall back
  //     to `hasCacheControl` as a proxy signal when `[1m]` marker absent.
  //   - sonnet never has it (400 if sent)
  //   - haiku never has it
  if (isOpus) {
    // Explicit per-version dispatch:
    //   opus-4.6 / opus-3 → always (have 1M entitlement on Max subscriptions)
    //   opus-4.7+         → only when session signals 1M ([1m] marker OR cache_control)
    //   opus-4.0-4.5      → NEVER auto-add (Anthropic 400 if subscription lacks entitlement)
    const isOpus46 = /opus-4-6\b/i.test(modelLower) || /opus-4-6-/i.test(modelLower)
    const isOpus3 = /opus-3/i.test(modelLower)
    const isOpus47Plus = /opus-4-([7-9]|\d{2,})\b/i.test(modelLower) || /opus-4-([7-9]|\d{2,})-/i.test(modelLower)
    const hasOneMMarker = /\[1m\]/i.test(hints.model ?? '')
    if (isOpus46 || isOpus3) {
      out.push(CONTEXT_1M)
    } else if (isOpus47Plus && (hasOneMMarker || hints.hasCacheControl)) {
      out.push(CONTEXT_1M)
    }
    // opus-4-0 through opus-4-5: intentionally NO auto-add — no entitlement, no session signal path
  }

  out.push(
    'interleaved-thinking-2025-05-14',
    'redact-thinking-2026-02-12',
    'context-management-2025-06-27',
    'prompt-caching-scope-2026-01-05',
  )

  return out
}

/**
 * HTTP anthropic-beta header — event base + runtime additions.
 *
 * Additions (always appended in this order, after base):
 *   advisor-tool-2026-03-01       (if advisorEnabled)
 *   advanced-tool-use-2025-11-20  (if agentic)
 *   effort-2025-11-24             (if agentic)
 *   tool-search-2025-12-02        (if hasToolSearch)
 *   structured-outputs-2025-12-15 (if hasStructuredOutput)
 *
 * Real CC flow: `getMergedBetas` (base) → `claude.ts:1058` assigns to
 * `betas`, then `claude.ts:1064` pushes advisor, `configureEffortParams`
 * pushes effort, `claude.ts:1164` pushes tool-search, etc.
 *
 * For Haiku the base has no `claude-code`/agentic flags. HAR confirms
 * Haiku session-title calls carry exactly:
 *   oauth-2025-04-20, interleaved-thinking, redact-thinking,
 *   context-management, prompt-caching-scope, advisor-tool,
 *   structured-outputs
 */
export function getHeaderBetas(hints: BetaHints): string[] {
  const base = getEventBetas(hints)
  const modelLower = (hints.model ?? '').toLowerCase()
  const isHaiku = modelLower.includes('haiku')
  const isAgentic = hints.isAgenticQuery ?? !isHaiku

  const out = [...base]

  if (hints.advisorEnabled !== false) {
    out.push('advisor-tool-2026-03-01')
  }

  if (isAgentic) {
    out.push('advanced-tool-use-2025-11-20', 'effort-2025-11-24')
  }

  // extended-cache-ttl: HAR 验证仅 agentic + hasCacheControl 时发(典型 opus-4-7
  // + cache_control 块);EVENT 集不含,所以加在 getHeaderBetas 而非 getEventBetas。
  if (isAgentic && hints.hasCacheControl) {
    out.push('extended-cache-ttl-2025-04-11')
  }

  if (hints.hasToolSearch) {
    out.push('tool-search-2025-12-02')
  }

  if (hints.hasStructuredOutput) {
    out.push('structured-outputs-2025-12-15')
  }

  return out
}

/**
 * Decide whether a body is an agentic main-thread call (tools-driven REPL)
 * vs a side-query (session title, structured output, hooks, …).
 *
 * Default rule when the caller leaves `isAgenticQuery` undefined:
 *   `!isHaiku` — i.e. assume non-Haiku is always agentic and Haiku is always
 *   side-query.
 *
 * That default is wrong when Haiku is the user-selected main-thread model:
 * the request has tools≥3 + thinking-enabled, but cc-betas would still strip
 * `claude-code-20250219` / `advanced-tool-use` / `effort` and emit the side-
 * query beta set instead. Anthropic's risk system flags that mismatch.
 *
 * This helper centralizes the override so rewriter (HTTP header) and
 * event-emitter (event_data.betas) use the SAME signal — preventing a Haiku
 * main-thread call from shipping mismatched header vs. event betas.
 */
export function inferIsAgenticQuery(body: any): boolean | undefined {
  if (!body || typeof body !== 'object') return undefined
  const modelLower = String(body.model ?? '').toLowerCase()
  const isHaiku = modelLower.includes('haiku')
  if (!isHaiku) {
    // Non-Haiku: leave undefined → cc-betas defaults to `!isHaiku=true`
    // (agentic). Required for opus/sonnet to keep claude-code-20250219.
    return undefined
  }
  const toolCount = Array.isArray(body.tools) ? body.tools.length : 0
  const thinkingType = body.thinking?.type
  const hasSystem = body.system !== undefined && body.system !== null
  // Haiku-as-main-thread override: tools≥3 + system + thinking-enabled means
  // the user picked Haiku for the REPL, not a session-title side-query. cc-
  // betas would otherwise strip claude-code-20250219 / advanced-tool-use /
  // effort and mismatch real CC main-thread Haiku traffic.
  if (
    toolCount >= 3
    && hasSystem
    && (thinkingType === 'enabled' || thinkingType === 'adaptive')
  ) {
    return true
  }
  // Otherwise leave undefined → cc-betas defaults to `!isHaiku=false` (side).
  return undefined
}

/**
 * Does the request body carry any cache_control block? Used as the
 * `cachingEnabled` signal for tengu_api_cache_breakpoints and as the
 * fallback opus-4-7 `[1m]` detector inside getEventBetas.
 *
 * Walks messages/system/tools and returns true if any block has
 * cache_control set. Null-safe for malformed payloads.
 */
export function bodyHasCacheControl(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, any>

  const scanBlocks = (blocks: unknown): boolean => {
    if (!Array.isArray(blocks)) return false
    for (const blk of blocks) {
      if (blk && typeof blk === 'object' && (blk as any).cache_control) return true
    }
    return false
  }

  if (Array.isArray(b.messages)) {
    for (const m of b.messages) {
      if (!m || typeof m !== 'object') continue
      if ((m as any).cache_control) return true
      if (scanBlocks((m as any).content)) return true
    }
  }

  if (scanBlocks(b.system)) return true
  if (scanBlocks(b.tools)) return true

  return false
}
