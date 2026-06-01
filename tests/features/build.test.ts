import { strict as assert } from 'assert'
import { buildFeatures } from '../../src/features/build.js'
import { OAUTH_DEFAULT_OPTIONS, APIKEY_DEFAULT_OPTIONS } from '../../src/features/options.js'
import type { Account } from '../../src/account-pool.js'

const oauth: Account = { authKind: 'oauth', options: OAUTH_DEFAULT_OPTIONS } as any
const api: Account   = { authKind: 'api_key', options: APIKEY_DEFAULT_OPTIONS } as any

// OAuth 默认:6 校验 (含 normalizeTemperature=true) + 3 cc-canonical + 0 清洗 + 4 覆盖 = 13
{
  const f = buildFeatures(oauth)
  assert.equal(f.length, 13, 'OAuth 默认装配数')
  assert.ok(f.find(x => x.id === 'normalize-temperature'))
  assert.ok(f.find(x => x.id === 'body-integrity'))
  assert.ok(f.find(x => x.id === 'request-shape'))
  assert.ok(f.find(x => x.id === 'model-allowlist'))
  assert.ok(f.find(x => x.id === 'fast-mode-reject'))
  assert.ok(f.find(x => x.id === 'require-stream'))
  assert.ok(f.find(x => x.id === 'cc-build-headers'))
  assert.ok(f.find(x => x.id === 'cc-rewrite-messages-body'))
  assert.ok(f.find(x => x.id === 'cc-session-binding'))
  assert.equal(f.find(x => x.id === 'strip-cc-headers'), undefined, 'OAuth 默认不清洗')
  assert.ok(f.find(x => x.id === 'user-agent'))
  console.log('✓ OAuth default → 13 features (6 校验 + 3 cc + 0 清洗 + 4 覆盖)')
}

// ApiKey 默认:5 (normalizeTemperature=false) + 0 cc + 4 + 4 = 13
{
  const f = buildFeatures(api)
  assert.equal(f.length, 13, 'ApiKey 默认装配数')
  assert.equal(f.find(x => x.id === 'normalize-temperature'), undefined, 'APIKEY 默认不规整 temperature')
  assert.ok(f.find(x => x.id === 'strip-cc-headers'))
  assert.ok(f.find(x => x.id === 'strip-cc-beta-flags'))
  assert.ok(f.find(x => x.id === 'sanitize-system-text'))
  assert.ok(f.find(x => x.id === 'drop-metadata'))
  console.log('✓ ApiKey default → 13 features')
}

// phase 顺序:inbound-validate → outbound-canonical → outbound-clean → outbound-override
{
  const f = buildFeatures(oauth)
  const phases = f.map(x => x.phase)
  const lastValIdx = phases.lastIndexOf('inbound-validate')
  const firstCanIdx = phases.indexOf('outbound-canonical')
  assert.ok(lastValIdx < firstCanIdx, 'inbound-validate 必须排在 outbound-canonical 前')
}
{
  const f = buildFeatures(api)
  const phases = f.map(x => x.phase)
  const lastValIdx = phases.lastIndexOf('inbound-validate')
  const firstCleanIdx = phases.indexOf('outbound-clean')
  assert.ok(lastValIdx < firstCleanIdx, 'inbound-validate 必须排在 outbound-clean 前')
  const lastCleanIdx = phases.lastIndexOf('outbound-clean')
  const firstOverrideIdx = phases.indexOf('outbound-override')
  assert.ok(lastCleanIdx < firstOverrideIdx, 'outbound-clean 必须排在 outbound-override 前')
  console.log('✓ phase 顺序:validate → canonical → clean → override')
}

// 手工关闭 4 项校验 → -4 features
{
  const acct: Account = { authKind: 'api_key', options: {
    ...APIKEY_DEFAULT_OPTIONS,
    validate: { ...APIKEY_DEFAULT_OPTIONS.validate, body: false, shape: false, model: false, fastMode: false, requireStream: true },
  } } as any
  const f = buildFeatures(acct)
  assert.equal(f.length, 13 - 4, 'ApiKey 关 4 校验 → 9')
  console.log('✓ 关闭 4 校验项 → -4 装配')
}

// 关闭所有 4 个 outbound-clean
{
  const acct: Account = { authKind: 'api_key', options: {
    ...APIKEY_DEFAULT_OPTIONS,
    clean: { ...APIKEY_DEFAULT_OPTIONS.clean, ccHeaders: false, ccBetaFlags: false, systemText: false, metadata: false },
  } } as any
  const f = buildFeatures(acct)
  assert.equal(f.length, 13 - 4, 'ApiKey 关 4 清洗 → 9')
  console.log('✓ 关闭 4 清洗项 → -4 装配')
}

console.log('\n✅ buildFeatures tests passed')
