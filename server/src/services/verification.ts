import { randomInt, randomUUID } from 'crypto'
import { getRedis } from '../redis.js'

type StoredCode = {
  code: string
  token: string   // UUID for magic link
  attempts: number
}

const CODE_TTL = 300      // 5 minutes
const RATE_LIMIT_TTL = 60 // 1 minute between sends
const MAX_ATTEMPTS = 5
const VERIFIED_TTL = 600  // 10 minutes to complete registration

function key(email: string) { return `magic:${email}` }
function limitKey(email: string) { return `magic:limit:${email}` }
function verifiedKey(token: string) { return `magic:verified:${token}` }

export async function generateMagicCode(email: string): Promise<{ code: string; token: string }> {
  const redis = getRedis()
  if (!redis) throw new Error('Redis unavailable')

  // Rate limit check
  const limited = await redis.get(limitKey(email))
  if (limited) throw new Error('RATE_LIMITED')

  const code = randomInt(100000, 1000000).toString()
  const token = randomUUID()

  const data: StoredCode = { code, token, attempts: 0 }
  await redis.set(key(email), JSON.stringify(data), 'EX', CODE_TTL)
  await redis.set(limitKey(email), '1', 'EX', RATE_LIMIT_TTL)

  return { code, token }
}

export async function verifyByCode(email: string, code: string): Promise<{ valid: boolean; token?: string }> {
  const redis = getRedis()
  if (!redis) return { valid: false }

  const raw = await redis.get(key(email))
  if (!raw) return { valid: false }

  const data: StoredCode = JSON.parse(raw)

  if (data.attempts >= MAX_ATTEMPTS) {
    await redis.del(key(email))
    return { valid: false }
  }

  if (data.code !== code) {
    data.attempts += 1
    const ttl = await redis.ttl(key(email))
    await redis.set(key(email), JSON.stringify(data), 'EX', ttl > 0 ? ttl : CODE_TTL)
    return { valid: false }
  }

  // Success — clean up and mark verified
  await redis.del(key(email))
  await redis.set(verifiedKey(data.token), email, 'EX', VERIFIED_TTL)
  return { valid: true, token: data.token }
}

export async function verifyByToken(token: string): Promise<string | null> {
  const redis = getRedis()
  if (!redis) return null

  // Find the email associated with this magic link token
  // We need to scan for the token in stored codes
  const keys = await redis.keys('magic:*')
  for (const k of keys) {
    if (k.startsWith('magic:limit:') || k.startsWith('magic:verified:')) continue
    const raw = await redis.get(k)
    if (!raw) continue
    try {
      const data: StoredCode = JSON.parse(raw)
      if (data.token === token) {
        const email = k.replace('magic:', '')
        await redis.del(k)
        await redis.set(verifiedKey(token), email, 'EX', VERIFIED_TTL)
        return email
      }
    } catch { continue }
  }
  return null
}

/** Consume a verified token — returns email if valid, null if expired/used */
export async function consumeVerifiedToken(token: string): Promise<string | null> {
  const redis = getRedis()
  if (!redis) return null

  const email = await redis.get(verifiedKey(token))
  if (email) {
    await redis.del(verifiedKey(token))
  }
  return email
}
