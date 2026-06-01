import { request as httpsRequest } from 'https'
import { log } from './logger.js'

export function buildBillableExclusionMessagesProbeBody(
  outboundBody: Buffer,
  model: string,
): Record<string, any> | null {
  let parsed: any
  try {
    parsed = JSON.parse(outboundBody.toString('utf-8'))
  } catch {
    return null
  }

  const probe: Record<string, any> = {
    model,
    max_tokens: 1,
    stream: false,
    messages: [{ role: 'user', content: 'ping' }],
  }

  if (parsed.system !== undefined && parsed.system !== null) {
    probe.system = parsed.system
  }
  if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
    probe.tools = parsed.tools
  }

  if (probe.system === undefined && probe.tools === undefined) return null
  return probe
}

function parseUsageToken(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

function summarizeProbeResponse(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 500)
}

export function parseMessagesProbeInputTokens(responseText: string): number | null {
  try {
    const parsed = JSON.parse(responseText)
    if (!parsed?.usage) return null
    return (
      parseUsageToken(parsed.usage.input_tokens)
      + parseUsageToken(parsed.usage.cache_creation_input_tokens)
      + parseUsageToken(parsed.usage.cache_read_input_tokens)
    )
  } catch {
    return null
  }
}

async function requestMessagesProbe(
  upstream: URL,
  headers: Record<string, string>,
  payload: Record<string, any>,
  agent?: any,
  traceId?: string,
): Promise<number | null> {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8')
  const url = new URL('/v1/messages', upstream)
  const probeHeaders: Record<string, string> = {
    ...headers,
    accept: 'application/json',
    'content-type': 'application/json',
    'accept-encoding': 'identity',
    host: upstream.host,
    'content-length': String(body.length),
  }
  delete probeHeaders['content-encoding']
  delete probeHeaders['transfer-encoding']

  return new Promise((resolve) => {
    let settled = false
    const finish = (value: number | null) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const req = httpsRequest(
      url,
      {
        method: 'POST',
        headers: probeHeaders,
        ...(agent && { agent }),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const responseText = Buffer.concat(chunks).toString('utf-8')
          if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
            log('warn', `Billable exclusion messages probe upstream status=${res.statusCode ?? 0}, traceId=${traceId ?? ''}, body=${summarizeProbeResponse(responseText)}`)
            finish(null)
            return
          }
          const tokens = parseMessagesProbeInputTokens(responseText)
          if (tokens === null) {
            log('warn', `Billable exclusion messages probe usage parse failed, traceId=${traceId ?? ''}, body=${summarizeProbeResponse(responseText)}`)
          }
          finish(tokens)
        })
      },
    )
    req.setTimeout(3_000, () => {
      log('warn', `Billable exclusion messages probe timed out after 3000ms, traceId=${traceId ?? ''}`)
      req.destroy()
      finish(null)
    })
    req.on('error', (err) => {
      if (!settled) {
        log('warn', `Billable exclusion messages probe request error, traceId=${traceId ?? ''}, error=${err instanceof Error ? err.message : String(err)}`)
      }
      finish(null)
    })
    req.write(body)
    req.end()
  })
}

export async function calculateBillableExcludedTokensByMessagesProbe(args: {
  outboundBody: Buffer
  model: string
  upstream: URL
  headers: Record<string, string>
  agent?: any
  traceId?: string
}): Promise<number | null> {
  const body = buildBillableExclusionMessagesProbeBody(args.outboundBody, args.model)
  if (!body) return 0

  return requestMessagesProbe(args.upstream, args.headers, body, args.agent, args.traceId)
}
