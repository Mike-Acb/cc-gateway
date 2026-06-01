import { strict as assert } from 'assert'
import { AccountOptionsSchema, OAUTH_DEFAULT_OPTIONS, APIKEY_DEFAULT_OPTIONS } from '../../src/features/options.js'

// parses OAuth default
{
  const result = AccountOptionsSchema.safeParse(OAUTH_DEFAULT_OPTIONS)
  assert.ok(result.success, 'OAuth default should parse successfully')
  console.log('✓ parses OAuth default')
}

// parses ApiKey default
{
  const result = AccountOptionsSchema.safeParse(APIKEY_DEFAULT_OPTIONS)
  assert.ok(result.success, 'ApiKey default should parse successfully')
  console.log('✓ parses ApiKey default')
}

// rejects extraHeaders containing authorization
{
  const bad = structuredClone(APIKEY_DEFAULT_OPTIONS)
  bad.override.extraHeaders = { authorization: 'evil' }
  const result = AccountOptionsSchema.safeParse(bad)
  assert.ok(!result.success, 'should reject extraHeaders with "authorization" key')
  console.log('✓ rejects extraHeaders containing authorization')
}

// rejects extraHeaders containing x-api-key (case-insensitive)
{
  const bad = structuredClone(APIKEY_DEFAULT_OPTIONS)
  bad.override.extraHeaders = { 'X-Api-Key': 'evil' }
  const result = AccountOptionsSchema.safeParse(bad)
  assert.ok(!result.success, 'should reject extraHeaders with "X-Api-Key" key (case-insensitive)')
  console.log('✓ rejects extraHeaders containing x-api-key (case-insensitive)')
}

console.log('\n✅ options.test.ts passed')
