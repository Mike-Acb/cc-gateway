# Full CC Body Disguise Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make non-CC client requests (NewAPI, API wrappers) indistinguishable from real Claude Code requests at the body level — tools, thinking, system prompt, and max_tokens.

**Architecture:** New `src/cc-disguise.ts` module handles template learning from real CC requests and body补全 for non-CC requests. Called from `rewriteMessagesBody` in `src/rewriter.ts` after identity rewrite. Templates cached in memory + Redis, with static JSON fallback files.

**Tech Stack:** TypeScript, Redis (ioredis), JSON static files

**Spec:** `docs/superpowers/specs/2026-04-16-full-cc-disguise-design.md`

---

### Task 1: Static default template files

**Files:**
- Create: `src/cc-tools-default.json` (already extracted to this path)
- Create: `src/cc-system-default.json` (already extracted to this path)

- [ ] **Step 1: Verify template files exist and are valid**

Run:
```bash
python3 -c "import json; t=json.load(open('src/cc-tools-default.json')); print(f'Tools: {len(t)} items, first={t[0][\"name\"]}')"
python3 -c "import json; s=json.load(open('src/cc-system-default.json')); print(f'System: {len(s)} blocks, first={s[0][\"text\"][:60]}')"
```

Expected:
```
Tools: 20 items, first=Task
System: 2 blocks, first=You are Claude Code, Anthropic's official CLI for Claude.
```

- [ ] **Step 2: Commit**

```bash
git add src/cc-tools-default.json src/cc-system-default.json
git commit -m "feat: add static CC tools and system prompt templates for body disguise"
```

---

### Task 2: cc-disguise module + tests

**Files:**
- Create: `src/cc-disguise.ts`
- Create: `tests/cc-disguise.test.ts`

- [ ] **Step 1: Write tests**

Create `tests/cc-disguise.test.ts`:

```typescript
import { strict as assert } from 'assert'
import {
  disguiseBody,
  learnFromCCRequest,
  resetTemplateCache,
  getTemplateCache,
} from '../src/cc-disguise.js'

// ── Test 1: tools injection ──
{
  resetTemplateCache()
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [],
    messages: [{ role: 'user', content: 'hello' }],
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.90.abc; cc_entrypoint=cli; cch=00000;' }],
    max_tokens: 1024,
    stream: true,
  }
  disguiseBody(body, '_test')
  assert.ok(body.tools.length > 3, 'should inject default tools when empty')
  assert.equal(body.tools[0].name, 'Task', 'first tool should be Task')
  console.log(`✓ tools injection (${body.tools.length} tools)`)
}

// ── Test 2: tools NOT injected when present ──
{
  resetTemplateCache()
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [{ name: 'MyTool', description: 'custom', input_schema: { type: 'object', properties: {} } }],
    messages: [{ role: 'user', content: 'hello' }],
    system: [],
    max_tokens: 4096,
    stream: true,
  }
  disguiseBody(body, '_test')
  assert.equal(body.tools.length, 1, 'should not replace non-empty tools')
  assert.equal(body.tools[0].name, 'MyTool', 'should keep original tool')
  console.log('✓ tools preserved when non-empty')
}

// ── Test 3: thinking injection ──
{
  resetTemplateCache()
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [],
    messages: [{ role: 'user', content: 'hello' }],
    system: [],
    max_tokens: 4096,
    stream: true,
  }
  disguiseBody(body, '_test')
  assert.deepEqual(body.thinking, { type: 'adaptive' }, 'sonnet 4.6 should get adaptive thinking')
  console.log('✓ thinking injection (adaptive for sonnet 4.6)')
}

// ── Test 4: thinking injection for haiku ──
{
  resetTemplateCache()
  const body: any = {
    model: 'claude-haiku-4-5-20251001',
    tools: [],
    messages: [{ role: 'user', content: 'hello' }],
    system: [],
    max_tokens: 32000,
    stream: true,
  }
  disguiseBody(body, '_test')
  assert.equal(body.thinking.type, 'enabled', 'haiku should get enabled thinking')
  assert.equal(body.thinking.budget_tokens, 31999, 'budget should be max_tokens - 1')
  console.log('✓ thinking injection (enabled for haiku)')
}

// ── Test 5: thinking NOT injected when present ──
{
  resetTemplateCache()
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [],
    messages: [{ role: 'user', content: 'hello' }],
    system: [],
    max_tokens: 4096,
    thinking: { type: 'enabled', budget_tokens: 2048 },
    stream: true,
  }
  disguiseBody(body, '_test')
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 2048 }, 'should not override existing thinking')
  console.log('✓ thinking preserved when present')
}

// ── Test 6: system prompt injection ──
{
  resetTemplateCache()
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [],
    messages: [{ role: 'user', content: 'hello' }],
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.90.abc; cc_entrypoint=cli; cch=00000;' }],
    max_tokens: 4096,
    stream: true,
  }
  disguiseBody(body, '_test')
  const hasCC = body.system.some((b: any) => b.text?.includes('You are Claude Code'))
  assert.ok(hasCC, 'should inject CC system prompt')
  console.log(`✓ system prompt injection (${body.system.length} blocks)`)
}

// ── Test 7: system prompt NOT injected when CC already present ──
{
  resetTemplateCache()
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [],
    messages: [{ role: 'user', content: 'hello' }],
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: ...' },
      { type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' },
      { type: 'text', text: 'Full system prompt here...' },
    ],
    max_tokens: 4096,
    stream: true,
  }
  disguiseBody(body, '_test')
  assert.equal(body.system.length, 3, 'should not add more blocks when CC prompt present')
  console.log('✓ system prompt preserved when CC structure present')
}

// ── Test 8: max_tokens floor ──
{
  resetTemplateCache()
  const body: any = {
    model: 'claude-opus-4-6',
    tools: [],
    messages: [{ role: 'user', content: 'hello' }],
    system: [],
    max_tokens: 1,
    stream: true,
  }
  disguiseBody(body, '_test')
  assert.equal(body.max_tokens, 64000, 'opus with max_tokens=1 should be raised to 64000')
  console.log('✓ max_tokens floor (opus: 1 → 64000)')
}

// ── Test 9: max_tokens not changed when >= 1024 ──
{
  resetTemplateCache()
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [],
    messages: [{ role: 'user', content: 'hello' }],
    system: [],
    max_tokens: 4096,
    stream: true,
  }
  disguiseBody(body, '_test')
  assert.equal(body.max_tokens, 4096, 'max_tokens >= 1024 should not change')
  console.log('✓ max_tokens preserved when >= 1024')
}

// ── Test 10: template learning ──
{
  resetTemplateCache()
  const ccTools = [
    { name: 'Bash', description: 'runs bash', input_schema: {} },
    { name: 'Edit', description: 'edits', input_schema: {} },
    { name: 'Read', description: 'reads', input_schema: {} },
    { name: 'Write', description: 'writes', input_schema: {} },
  ]
  const ccSystem = [
    { type: 'text', text: 'billing header' },
    { type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' },
    { type: 'text', text: 'Full CC system prompt...' },
  ]
  learnFromCCRequest(ccTools, ccSystem, 'test-acct', 'claude-cli/2.1.90')

  const cache = getTemplateCache('test-acct')
  assert.ok(cache, 'should have cached template')
  assert.equal(cache!.tools.length, 4, 'should cache all tools')
  assert.equal(cache!.systemBlocks.length, 2, 'should cache system blocks without billing')

  // Now disguise should use learned template
  const body: any = {
    model: 'claude-sonnet-4-6',
    tools: [],
    messages: [{ role: 'user', content: 'hello' }],
    system: [{ type: 'text', text: 'billing' }],
    max_tokens: 4096,
    stream: true,
  }
  disguiseBody(body, 'test-acct')
  assert.equal(body.tools.length, 4, 'should use learned tools')
  assert.equal(body.tools[0].name, 'Bash', 'should use learned tool names')
  console.log('✓ template learning and reuse')
}

console.log('\nAll cc-disguise tests passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx tests/cc-disguise.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement cc-disguise module**

Create `src/cc-disguise.ts`:

```typescript
import { log } from './logger.js'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

// ── Types ──

export type CCTemplateCache = {
  tools: any[]
  systemBlocks: any[]
  learnedAt: number
  learnedFromUA: string
}

// ── State ──

const templateCache = new Map<string, CCTemplateCache>()
let defaultTools: any[] | null = null
let defaultSystem: any[] | null = null

// ── Static defaults (loaded lazily) ──

function getDefaultTools(): any[] {
  if (!defaultTools) {
    try {
      const dir = dirname(fileURLToPath(import.meta.url))
      defaultTools = JSON.parse(readFileSync(resolve(dir, 'cc-tools-default.json'), 'utf-8'))
    } catch (err) {
      log('warn', `cc-disguise: failed to load default tools: ${err}`)
      defaultTools = []
    }
  }
  return defaultTools!
}

function getDefaultSystem(): any[] {
  if (!defaultSystem) {
    try {
      const dir = dirname(fileURLToPath(import.meta.url))
      defaultSystem = JSON.parse(readFileSync(resolve(dir, 'cc-system-default.json'), 'utf-8'))
    } catch (err) {
      log('warn', `cc-disguise: failed to load default system: ${err}`)
      defaultSystem = []
    }
  }
  return defaultSystem!
}

// ── Model classification ──

function supportsAdaptiveThinking(model: string): boolean {
  return /opus-4-[6-9]|opus-4-\d{2}|sonnet-4-[6-9]|sonnet-4-\d{2}/i.test(model)
}

function supportsThinking(model: string): boolean {
  return supportsAdaptiveThinking(model)
    || /haiku-4-[5-9]|haiku-4-\d{2}|opus-4-[5-9]|sonnet-4-[5-9]/i.test(model)
}

function getDefaultMaxTokens(model: string): number {
  if (/opus/i.test(model)) return 64000
  if (/sonnet/i.test(model)) return 32000
  if (/haiku/i.test(model)) return 32000
  return 32000
}

// ── Template learning ──

export function learnFromCCRequest(
  tools: any[],
  systemBlocks: any[],
  accountId: string,
  userAgent: string,
): void {
  if (templateCache.has(accountId)) return

  // Strip billing header and cache_control from system blocks
  const filtered = systemBlocks
    .filter((b: any) => {
      const text = typeof b === 'string' ? b : b?.text
      return typeof text === 'string' && !text.startsWith('x-anthropic-billing-header')
    })
    .map((b: any) => {
      const copy = { ...b }
      delete copy.cache_control
      return copy
    })

  const entry: CCTemplateCache = {
    tools: JSON.parse(JSON.stringify(tools)),
    systemBlocks: filtered,
    learnedAt: Date.now(),
    learnedFromUA: userAgent,
  }

  templateCache.set(accountId, entry)
  log('info', `cc-disguise: learned template from CC request (${tools.length} tools, ${filtered.length} system blocks) for account ${accountId}`)

  // Persist to Redis async
  persistToRedis(accountId, entry).catch(() => {})
}

// ── Body disguise ──

export function disguiseBody(body: any, accountId: string): void {
  if (!body || typeof body !== 'object') return

  const model = body.model ?? ''
  const template = templateCache.get(accountId)

  // 1. Tools: inject when empty
  if (!body.tools || (Array.isArray(body.tools) && body.tools.length === 0)) {
    body.tools = template?.tools ?? getDefaultTools()
    log('debug', `cc-disguise: injected ${body.tools.length} tools`)
  }

  // 2. Thinking: inject when missing
  if (body.thinking === undefined || body.thinking === null) {
    if (supportsAdaptiveThinking(model)) {
      body.thinking = { type: 'adaptive' }
    } else if (supportsThinking(model)) {
      const maxTokens = body.max_tokens ?? getDefaultMaxTokens(model)
      body.thinking = { type: 'enabled', budget_tokens: maxTokens - 1 }
    }
    if (body.thinking) {
      log('debug', `cc-disguise: injected thinking=${JSON.stringify(body.thinking)}`)
    }
  }

  // 3. max_tokens: floor check
  if (typeof body.max_tokens === 'number' && body.max_tokens < 1024) {
    const defaultMax = getDefaultMaxTokens(model)
    log('debug', `cc-disguise: raised max_tokens from ${body.max_tokens} to ${defaultMax}`)
    body.max_tokens = defaultMax
    // If thinking was already set with budget_tokens, update it too
    if (body.thinking?.type === 'enabled' && body.thinking?.budget_tokens) {
      body.thinking.budget_tokens = defaultMax - 1
    }
  }

  // 4. System prompt: inject CC blocks if not present
  if (Array.isArray(body.system)) {
    const hasCC = body.system.some((b: any) => {
      const text = typeof b === 'string' ? b : b?.text
      return typeof text === 'string' && text.includes('You are Claude Code')
    })
    if (!hasCC) {
      const blocks = template?.systemBlocks ?? getDefaultSystem()
      // Insert after billing header (index 0), before any user system blocks
      const billingIdx = body.system.findIndex((b: any) => {
        const text = typeof b === 'string' ? b : b?.text
        return typeof text === 'string' && text.includes('x-anthropic-billing-header')
      })
      const insertAt = billingIdx >= 0 ? billingIdx + 1 : 0
      body.system.splice(insertAt, 0, ...blocks)
      log('debug', `cc-disguise: injected ${blocks.length} system prompt blocks`)
    }
  } else if (!body.system) {
    body.system = [...(template?.systemBlocks ?? getDefaultSystem())]
  }
}

// ── Cache management ──

export function getTemplateCache(accountId: string): CCTemplateCache | undefined {
  return templateCache.get(accountId)
}

export function resetTemplateCache(): void {
  templateCache.clear()
}

// ── Redis persistence ──

async function persistToRedis(accountId: string, entry: CCTemplateCache): Promise<void> {
  try {
    const { isRedisAvailable, getRedis } = await import('./redis.js')
    if (!isRedisAvailable()) return
    const redis = getRedis()
    await redis.set(
      `cc-template:${accountId}`,
      JSON.stringify(entry),
      'EX',
      604800, // 7 days
    )
  } catch {}
}

export async function hydrateTemplatesFromRedis(accountIds: string[]): Promise<void> {
  try {
    const { isRedisAvailable, getRedis } = await import('./redis.js')
    if (!isRedisAvailable()) return
    const redis = getRedis()
    for (const id of accountIds) {
      if (templateCache.has(id)) continue
      const raw = await redis.get(`cc-template:${id}`)
      if (raw) {
        try {
          const entry = JSON.parse(raw) as CCTemplateCache
          templateCache.set(id, entry)
        } catch {}
      }
    }
    const count = accountIds.filter(id => templateCache.has(id)).length
    if (count > 0) log('info', `cc-disguise: hydrated ${count} templates from Redis`)
  } catch {}
}
```

- [ ] **Step 4: Run tests**

Run: `npx tsx tests/cc-disguise.test.ts`
Expected: All 10 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/cc-disguise.ts tests/cc-disguise.test.ts
git commit -m "feat: add cc-disguise module with template learning and body补全"
```

---

### Task 3: Wire disguise into rewriter + template learning

**Files:**
- Modify: `src/rewriter.ts` (rewriteMessagesBody, around line 343)
- Modify: `src/account-pool.ts` (hydrate templates on startup)

- [ ] **Step 1: Add disguise call in rewriteMessagesBody**

In `src/rewriter.ts`, add import at top:
```typescript
import { disguiseBody, learnFromCCRequest } from './cc-disguise.js'
```

At the **end** of `rewriteMessagesBody` (after the billing header block, right before the closing `}`), add:

```typescript
  // ── CC body disguise ──
  // Learn from real CC requests (tools.length > 3 = real CC client)
  if (Array.isArray(body.tools) && body.tools.length > 3) {
    const ua = view.fingerprint?.user_agent ?? ''
    learnFromCCRequest(body.tools, body.system ?? [], acctId, ua)
  }

  // Disguise non-CC bodies to match CC structure
  disguiseBody(body, acctId)
```

- [ ] **Step 2: Add template hydrate on startup**

In `src/account-pool.ts`, add import:
```typescript
import { hydrateTemplatesFromRedis } from './cc-disguise.js'
```

In `startAccountPool()`, after the session slots hydration block, add:
```typescript
  // Hydrate CC disguise templates from Redis
  const templateIds = accounts
    .map(a => a.canonicalIdentity?.account_uuid)
    .filter((u): u is string => !!u)
  if (templateIds.length > 0) {
    await hydrateTemplatesFromRedis(templateIds)
  }
```

- [ ] **Step 3: Verify all tests pass**

Run:
```bash
npx tsx tests/cc-disguise.test.ts && npx tsx tests/rewriter.test.ts && npx tsx tests/session-slots.test.ts
```
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/rewriter.ts src/account-pool.ts
git commit -m "feat: wire CC body disguise into rewriter with template learning on startup"
```

---

### Task 4: Add test to package.json + deploy

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add cc-disguise test to test script**

In `package.json`, append ` && tsx tests/cc-disguise.test.ts` to the test script.

- [ ] **Step 2: Run all tests**

```bash
npm test
```
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add cc-disguise test to test suite"
```

---

### Task 5: API endpoint for disguise status

**Files:**
- Modify: `server/src/routes/oauth-accounts.ts`

- [ ] **Step 1: Add GET /:id/disguise-status endpoint**

In `server/src/routes/oauth-accounts.ts`, add after the session-slots route:

```typescript
// GET /api/admin/oauth-accounts/:id/disguise-status
router.get('/:id/disguise-status', async (req, res) => {
  const { id } = req.params
  try {
    const acctResult = await query('SELECT canonical_identity FROM oauth_accounts WHERE id = $1', [id])
    if (acctResult.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }
    const identity = acctResult.rows[0].canonical_identity
    const acctUuid = typeof identity === 'string' ? JSON.parse(identity).account_uuid : identity?.account_uuid
    if (!acctUuid) return res.json({ status: 'no_identity' })

    const redis = (await import('../redis.js')).getRedisIfAvailable?.()
    if (!redis) return res.json({ status: 'redis_unavailable' })

    const raw = await redis.get(`cc-template:${acctUuid}`)
    if (!raw) return res.json({ status: 'not_learned', using_defaults: true })

    const entry = JSON.parse(raw)
    res.json({
      status: 'learned',
      source_ua: entry.learnedFromUA,
      learned_at: entry.learnedAt,
      tools_count: entry.tools?.length ?? 0,
      tool_names: (entry.tools ?? []).map((t: any) => t.name),
      system_blocks_count: entry.systemBlocks?.length ?? 0,
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/admin/oauth-accounts/:id/disguise-template
router.delete('/:id/disguise-template', async (req, res) => {
  const { id } = req.params
  try {
    const acctResult = await query('SELECT canonical_identity FROM oauth_accounts WHERE id = $1', [id])
    if (acctResult.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }
    const identity = acctResult.rows[0].canonical_identity
    const acctUuid = typeof identity === 'string' ? JSON.parse(identity).account_uuid : identity?.account_uuid
    if (!acctUuid) return res.json({ cleared: false })

    const redis = (await import('../redis.js')).getRedisIfAvailable?.()
    if (redis) await redis.del(`cc-template:${acctUuid}`)
    res.json({ cleared: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
```

Note: Adjust imports (`query`, `getRedisIfAvailable`) to match existing file patterns.

- [ ] **Step 2: Commit**

```bash
git add server/src/routes/oauth-accounts.ts
git commit -m "feat: add CC disguise status API endpoints"
```

---

### Task 6: Frontend redesign with tabs

**Files:**
- Modify: `web/src/pages/admin/AdminAccountsPage.tsx`

- [ ] **Step 1: Redesign AccountDetailCard with tabs**

The current detail card has all sections stacked vertically. Redesign to use horizontal layout + tabs:

Reference mockup: `mockups/account-detail-v2.html` (wide-width version with tabs)

Layout (wider, min-width 720px):
```
┌────────────────────────────────────────────────────────────────────┐
│ [avatar] name  [MAX] [运行中]                              [⋯]    │
├──────────────────────────────────────────┬─────────────────────────┤
│  [5h ring] [7d ring] [Opus ring] [Sonnet]│  实时状态               │
│                                           │  并发    2/5            │
│                                           │  RPM     14/50          │
│                                           │  TPM     33,144/8M      │
├───────────────────────┬───────────────────┴─────────────────────────┤
│  今日请求 347 │ 今日 Token 1.2M │ 今日费用 $4.82                   │
├────────────────────────────────────────────────────────────────────┤
│ [Session Slots 2/3] [CC 伪装 20]                                   │
├────────────────────────────────────────────────────────────────────┤
│  (tab content here)                                                │
└────────────────────────────────────────────────────────────────────┘
```

Implementation outline:
1. Replace existing `AccountDetailCard` component with new grid layout using Tailwind
2. Move `SessionSlotsSection` into a tab panel (keep existing implementation)
3. Add `CCDisguiseSection` tab panel (new)
4. Use local state `const [activeTab, setActiveTab] = useState<'slots' | 'disguise'>('slots')`

Add the `CCDisguiseSection` component (fetches `/disguise-status`, renders status + tools list + rules + clear button):

```tsx
function CCDisguiseSection({ account }: { account: any }) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch(`/api/admin/oauth-accounts/${account.id}/disguise-status`, {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('access_token')}` }
    }).then(r => r.json()).then(setData).catch(() => {})
  }, [account.id])

  const clearCache = async () => {
    if (!confirm('确定清除伪装模板缓存？下一个 CC 客户端连接时会重新学习。')) return
    setLoading(true)
    await fetch(`/api/admin/oauth-accounts/${account.id}/disguise-template`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${localStorage.getItem('access_token')}` }
    })
    const r = await fetch(`/api/admin/oauth-accounts/${account.id}/disguise-status`, {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('access_token')}` }
    })
    setData(await r.json())
    setLoading(false)
  }

  const isLearned = data?.status === 'learned'
  const sourceUA = data?.source_ua ?? ''
  const version = sourceUA.match(/claude-(?:cli|code)\/([^\s]+)/)?.[1] ?? '2.1.90'

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className={`inline-block px-2 py-0.5 rounded-md text-[11px] font-semibold ${isLearned ? 'bg-[#f0fdf4] text-[#16a34a] border border-[#bbf7d0]' : 'bg-[#eff6ff] text-[#2563eb] border border-[#bfdbfe]'}`}>
          {isLearned ? '已学习' : '使用默认模板'}
        </span>
        <span className="text-[12px] text-[#6b6b80]">
          {isLearned ? '从真实 CC 客户端学习的伪装模板' : '未检测到 CC 客户端，使用内置静态模板'}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <div className="bg-[#f8f8fa] rounded-md p-3">
          <div className="text-[10px] text-[#9b9bae] uppercase tracking-wide">来源版本</div>
          <div className="font-mono text-[14px] font-semibold mt-1">{version}</div>
        </div>
        <div className="bg-[#f8f8fa] rounded-md p-3">
          <div className="text-[10px] text-[#9b9bae] uppercase tracking-wide">学习时间</div>
          <div className="font-mono text-[12px] font-medium text-[#6b6b80] mt-1">
            {data?.learned_at ? fmtRelative(new Date(data.learned_at).toISOString()) : '—'}
          </div>
        </div>
        <div className="bg-[#f8f8fa] rounded-md p-3">
          <div className="text-[10px] text-[#9b9bae] uppercase tracking-wide">Tools</div>
          <div className="font-mono text-[14px] font-semibold mt-1">{data?.tools_count ?? 20}</div>
        </div>
        <div className="bg-[#f8f8fa] rounded-md p-3">
          <div className="text-[10px] text-[#9b9bae] uppercase tracking-wide">System</div>
          <div className="font-mono text-[14px] font-semibold mt-1">{data?.system_blocks_count ?? 2} blocks</div>
        </div>
      </div>

      {data?.tool_names && (
        <div>
          <div className="text-[10px] font-semibold text-[#9b9bae] uppercase tracking-wide mb-1.5">已学习的 Tools</div>
          <div className="flex flex-wrap gap-1">
            {data.tool_names.map((name: string) => (
              <span key={name} className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#f8f8fa] border border-[#e2e2ea] text-[#57534e]">{name}</span>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="text-[10px] font-semibold text-[#9b9bae] uppercase tracking-wide mb-1.5">伪装规则 (非 CC 请求自动应用)</div>
        <div className="divide-y divide-[#f0f0f5]">
          <DisguiseRule field="tools" desc="为空时注入 20 个已学习的 tool 定义" tag="注入" tagType="inject" />
          <DisguiseRule field="thinking" desc="缺失时按模型注入 adaptive 或 enabled" tag="注入" tagType="inject" />
          <DisguiseRule field="system" desc="缺少 CC 结构时注入系统提示块" tag="注入" tagType="inject" />
          <DisguiseRule field="max_tokens" desc="< 1024 时拉到模型默认值" tag="下限" tagType="floor" />
          <DisguiseRule field="messages" desc="透传，不修改" tag="透传" tagType="pass" />
        </div>
      </div>

      {isLearned && (
        <button
          onClick={clearCache}
          disabled={loading}
          className="text-[11px] font-semibold px-3 py-1.5 rounded-md border border-[#e2e2ea] text-[#dc2626] hover:bg-[#fef2f2] hover:border-[#fecaca] disabled:opacity-50"
        >
          {loading ? '清除中…' : '清除缓存'}
        </button>
      )}
    </div>
  )
}

function DisguiseRule({ field, desc, tag, tagType }: { field: string; desc: string; tag: string; tagType: 'inject' | 'floor' | 'pass' }) {
  const cls = tagType === 'inject' ? 'bg-[#f0fdf4] text-[#16a34a] border-[#bbf7d0]'
    : tagType === 'floor' ? 'bg-[#fffbeb] text-[#d97706] border-[#fde68a]'
    : 'bg-[#f8f8fa] text-[#9b9bae] border-[#e2e2ea]'
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className="font-mono text-[11px] text-[#9b9bae] w-[100px] flex-shrink-0">{field}</span>
      <span className="flex-1 text-[11px] text-[#57534e]">{desc}</span>
      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${cls}`}>{tag}</span>
    </div>
  )
}
```

- [ ] **Step 2: Replace old AccountDetailCard layout with tabbed version**

In AccountDetailCard component, find the "Session Slots" section insertion point and restructure:

Replace the existing Session Slots + footer structure with:

```tsx
{/* Tabs */}
<div className="mt-5 flex border-b border-[#f0f0f0]">
  <button
    onClick={() => setActiveTab('slots')}
    className={`px-4 py-2.5 text-[12px] font-semibold border-b-2 transition-colors ${activeTab === 'slots' ? 'border-[#1d1d1f] text-[#1d1d1f]' : 'border-transparent text-[#86868b] hover:text-[#1d1d1f]'}`}
  >
    Session Slots
    <span className={`ml-1.5 text-[10px] font-mono px-1.5 py-0.5 rounded ${activeTab === 'slots' ? 'bg-[#1d1d1f] text-white' : 'bg-[#f5f5f7] text-[#86868b]'}`}>
      {account.stats.session_slots?.used ?? 0}/{account.stats.session_slots?.max ?? account.max_sessions ?? 3}
    </span>
  </button>
  <button
    onClick={() => setActiveTab('disguise')}
    className={`px-4 py-2.5 text-[12px] font-semibold border-b-2 transition-colors ${activeTab === 'disguise' ? 'border-[#1d1d1f] text-[#1d1d1f]' : 'border-transparent text-[#86868b] hover:text-[#1d1d1f]'}`}
  >
    CC 伪装
  </button>
</div>

<div className="mt-4">
  {activeTab === 'slots' && <SessionSlotsSection account={account} />}
  {activeTab === 'disguise' && <CCDisguiseSection account={account} />}
</div>
```

Add `const [activeTab, setActiveTab] = useState<'slots' | 'disguise'>('slots')` at the top of `AccountDetailCard`.

- [ ] **Step 3: Verify frontend builds**

Run: `cd web && npx tsc --noEmit`
Expected: No new type errors

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/admin/AdminAccountsPage.tsx
git commit -m "feat: redesign account detail card with tabbed Session Slots + CC Disguise sections"
```

---

### Task 7: Remove fingerprint preset system

**Files:**
- Delete: `src/fingerprint-store.ts`
- Delete: `server/src/routes/fingerprint-presets.ts`
- Delete: `server/src/services/fingerprint-presets.ts`
- Delete: `web/src/pages/admin/AdminFingerprintPresetsPage.tsx`
- Modify: `src/proxy.ts` (remove getAccountFingerprint calls)
- Modify: `src/account-pool.ts` (remove related imports)
- Modify: `server/src/app.ts` (remove route registration)
- Modify: `web/src/router.tsx` (remove route)
- Modify: `web/src/pages/admin/AdminAccountsPage.tsx` (remove fingerprint_status/fingerprint_preset_id related UI)

- [ ] **Step 1: Remove fingerprint-store references from proxy.ts**

In `src/proxy.ts`:
1. Remove the import: `import { ensureAccountFingerprint, getAccountFingerprint } from './fingerprint-store.js'`
2. Remove the `isFingerprintReady` function (around line 290-293)
3. In `applyRewrite` (around line 710), change:
   ```typescript
   const preset = await getAccountFingerprint(account.account.id)
   const profile = buildEffectiveProfile(account.account, preset?.fingerprint ?? null)
   ```
   to:
   ```typescript
   const profile = buildEffectiveProfile(account.account, null)
   ```
4. Remove any other usages (grep for `ensureAccountFingerprint`, `getAccountFingerprint`, `isFingerprintReady`)

- [ ] **Step 2: Remove from account-pool.ts**

In `src/account-pool.ts`, remove the import `import { getAccountFingerprint } from './fingerprint-store.js'` if present.

- [ ] **Step 3: Remove server route**

In `server/src/app.ts`, find and remove:
```typescript
import fingerprintPresetsRouter from './routes/fingerprint-presets.js'
// ...
app.use('/api/admin/fingerprint-presets', fingerprintPresetsRouter)
```

- [ ] **Step 4: Delete files**

```bash
rm src/fingerprint-store.ts
rm server/src/routes/fingerprint-presets.ts
rm server/src/services/fingerprint-presets.ts
rm web/src/pages/admin/AdminFingerprintPresetsPage.tsx
```

- [ ] **Step 5: Remove frontend route**

In `web/src/router.tsx`, remove any route referencing `AdminFingerprintPresetsPage`.

- [ ] **Step 6: Remove fingerprint UI from AdminAccountsPage.tsx**

Search for `fingerprint_status`, `fingerprint_preset_id`, `observed_fingerprint` in `web/src/pages/admin/AdminAccountsPage.tsx`. Remove:
- Fields from `OAuthAccount` interface
- Any UI elements displaying these fields
- Any edit form fields for preset binding

- [ ] **Step 7: Verify builds**

```bash
npx tsc --noEmit
cd web && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: remove fingerprint preset system (replaced by version lock + header injection)"
```

---

### Task 8: Test suite + deploy

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add cc-disguise test to test script**

In `package.json`, append ` && tsx tests/cc-disguise.test.ts` to the test script.

- [ ] **Step 2: Run all tests**

```bash
npm test
```
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add cc-disguise test to test suite"
```

- [ ] **Step 4: Deploy**

```bash
rsync -avz --exclude='config.yaml' --exclude='fullchain.pem' --exclude='privkey.pem' \
  --exclude='node_modules/' --exclude='dist/' --exclude='.superpowers/' \
  --exclude='server/node_modules/' --exclude='server/dist/' \
  --exclude='web/node_modules/' --exclude='web/dist/' \
  --exclude='/clients/' --exclude='.DS_Store' --exclude='.claude/' \
  --exclude='mockups/' \
  -e "ssh -o StrictHostKeyChecking=no" \
  ./ root@1.2.3.4:/home/ubuntu/gw/

ssh root@1.2.3.4 "cd /home/ubuntu/gw && cd web && npm run build && cd .. && cp -r web/dist/* /opt/1panel/www/gw.example.com/ && pm2 delete gateway api-server && pm2 start ecosystem.config.cjs"
```

Verify: send a NewAPI-style request and check `request_body_out` in DB has tools and system prompt injected. Open admin panel and verify Session Slots + CC 伪装 tabs work.
