import crypto from 'crypto'
import { query } from '../db.js'

// Cache settings to avoid querying DB on every payment
let settingsCache: Record<string, string> = {}
let settingsCacheTime = 0

async function getSettings(): Promise<Record<string, string>> {
  if (Date.now() - settingsCacheTime < 60_000 && Object.keys(settingsCache).length > 0) {
    return settingsCache
  }
  try {
    const result = await query('SELECT key, value FROM system_settings')
    const settings: Record<string, string> = {}
    for (const row of result.rows) {
      settings[row.key] = row.value
    }
    settingsCache = settings
    settingsCacheTime = Date.now()
    return settings
  } catch {
    return settingsCache
  }
}

async function getEpayConfig() {
  const s = await getSettings()
  return {
    url: s.epay_url || process.env.EPAY_URL || 'https://pay.example.com',
    pid: s.epay_pid || process.env.EPAY_PID || '1000',
    key: s.epay_key || process.env.EPAY_KEY || 'your-epay-key',
    notifyUrl: s.epay_notify_url || process.env.EPAY_NOTIFY_URL || (s.gateway_url ? s.gateway_url + '/api/subscription/notify' : 'http://localhost:3000/api/subscription/notify'),
    returnUrl: s.epay_return_url || process.env.EPAY_RETURN_URL || (s.gateway_url ? s.gateway_url + '/checkout/result' : 'http://localhost:5173/checkout/result'),
  }
}

// MD5签名: 参数名ASCII排序, 去掉sign/sign_type/空值, 拼接KEY
function generateSign(params: Record<string, string>, key: string): string {
  const sorted = Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'sign_type' && params[k] !== '')
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&')
  return crypto.createHash('md5').update(sorted + key).digest('hex')
}

// Verify callback sign
export async function verifySign(params: Record<string, string>): Promise<boolean> {
  const config = await getEpayConfig()
  const expected = generateSign(params, config.key)
  return params.sign === expected
}

/**
 * Create payment URL for 页面跳转支付
 * @param outTradeNo 商户订单号
 * @param amount 金额
 * @param name 商品名称
 * @param payType 支付方式: 'alipay' | 'wxpay'
 */
export async function createPaymentUrl(
  outTradeNo: string,
  amount: string,
  name: string,
  payType: string = 'alipay',
): Promise<string> {
  const config = await getEpayConfig()

  const params: Record<string, string> = {
    pid: config.pid,
    type: payType,
    out_trade_no: outTradeNo,
    notify_url: config.notifyUrl,
    return_url: config.returnUrl,
    name: name,
    money: amount,
  }
  params.sign = generateSign(params, config.key)
  params.sign_type = 'MD5'

  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  return `${config.url}/submit.php?${qs}`
}

export async function getReturnUrl(): Promise<string> {
  const config = await getEpayConfig()
  return config.returnUrl
}
