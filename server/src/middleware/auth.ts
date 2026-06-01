import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET ?? 'cc-gateway-jwt-secret-change-me'
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'cc-gateway-refresh-secret-change-me'

export type JWTPayload = {
  userId: string
  username: string
  role: string
}

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload
    }
  }
}

export function generateTokens(payload: JWTPayload) {
  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '15m' })
  const refreshToken = jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: '7d' })
  return { accessToken, refreshToken }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Try Authorization header first
  const header = req.headers.authorization
  let token: string | undefined

  if (header?.startsWith('Bearer ')) {
    token = header.slice(7)
  } else if (req.query.token && typeof req.query.token === 'string') {
    // Support ?token= query param for browser downloads
    token = req.query.token
  }

  if (!token) {
    res.status(401).json({ error: 'Missing or invalid authorization header' })
    return
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as JWTPayload
    req.user = payload
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}

export { JWT_SECRET, JWT_REFRESH_SECRET }
