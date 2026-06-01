import { DEPLOYMENT } from './db.js'
import { getRedis, isRedisAvailable } from './redis.js'

type SignatureContext = {
  accountId: string
  model: string | null
  tainted: boolean
  updatedAt: number
}

const memoryContexts = new Map<string, SignatureContext>()
const memoryAccountTaints = new Map<string, number>()

const ACCOUNT_TAINT_TTL_SECONDS = 12 * 60 * 60

function makeKey(sessionKey: string): string {
  return `sigctx:${DEPLOYMENT}:${sessionKey}`
}

function makeAccountTaintKey(accountId: string): string {
  return `sigctxacct:${DEPLOYMENT}:${accountId}`
}

async function readContext(sessionKey: string): Promise<SignatureContext | null> {
  const memory = memoryContexts.get(sessionKey)
  if (memory) return memory

  if (!isRedisAvailable()) return null
  const raw = await getRedis().get(makeKey(sessionKey))
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as SignatureContext
    if (!parsed || typeof parsed.accountId !== 'string') return null
    memoryContexts.set(sessionKey, parsed)
    return parsed
  } catch {
    return null
  }
}

async function isAccountTainted(accountId: string): Promise<boolean> {
  const memory = memoryAccountTaints.get(accountId)
  if (typeof memory === 'number') {
    if (memory > Date.now()) return true
    memoryAccountTaints.delete(accountId)
  }

  if (!isRedisAvailable()) return false
  const raw = await getRedis().get(makeAccountTaintKey(accountId))
  if (!raw) return false
  const until = Number(raw)
  if (!Number.isFinite(until) || until <= Date.now()) return false
  memoryAccountTaints.set(accountId, until)
  return true
}

export async function shouldStripSignatureBlocksForContext(
  sessionKey: string | null,
  accountId: string | null,
  model: string | null,
): Promise<boolean> {
  if (!accountId) return false
  if (await isAccountTainted(accountId)) return true
  if (!sessionKey) return false
  const previous = await readContext(sessionKey)
  if (!previous) return false
  return previous.tainted
    || previous.accountId !== accountId
    || previous.model !== model
}

export async function noteSuccessfulSignatureContext(
  sessionKey: string | null,
  accountId: string | null,
  model: string | null,
  ttlSeconds: number,
): Promise<void> {
  if (!sessionKey || !accountId) return

  const existing = await readContext(sessionKey)
  const context: SignatureContext = {
    accountId,
    model,
    tainted: existing?.tainted === true,
    updatedAt: Date.now(),
  }
  memoryContexts.set(sessionKey, context)

  if (!isRedisAvailable()) return
  await getRedis().set(
    makeKey(sessionKey),
    JSON.stringify(context),
    'EX',
    Math.max(60, ttlSeconds),
  )
}

export async function noteInvalidSignatureContext(
  sessionKey: string | null,
  accountId: string | null,
  model: string | null,
  ttlSeconds: number,
): Promise<void> {
  const now = Date.now()

  if (accountId) {
    const until = now + ACCOUNT_TAINT_TTL_SECONDS * 1000
    memoryAccountTaints.set(accountId, until)
    if (isRedisAvailable()) {
      await getRedis().set(
        makeAccountTaintKey(accountId),
        String(until),
        'EX',
        ACCOUNT_TAINT_TTL_SECONDS,
      )
    }
  }

  if (!sessionKey || !accountId) return

  const context: SignatureContext = {
    accountId,
    model,
    tainted: true,
    updatedAt: now,
  }
  memoryContexts.set(sessionKey, context)

  if (!isRedisAvailable()) return
  await getRedis().set(
    makeKey(sessionKey),
    JSON.stringify(context),
    'EX',
    Math.max(60, ttlSeconds),
  )
}

export function resetSignatureContextForTest(): void {
  memoryContexts.clear()
  memoryAccountTaints.clear()
}
