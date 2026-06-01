import { strict as assert } from 'assert'
import {
  noteInvalidSignatureContext,
  noteSuccessfulSignatureContext,
  resetSignatureContextForTest,
  shouldStripSignatureBlocksForContext,
} from '../src/signature-context.js'

async function main() {
  resetSignatureContextForTest()

  assert.equal(
    await shouldStripSignatureBlocksForContext(null, 'acct-a', 'claude-sonnet-4-6'),
    false,
    'missing session key should never trigger stripping',
  )

  assert.equal(
    await shouldStripSignatureBlocksForContext('sess-1', 'acct-a', 'claude-sonnet-4-6'),
    false,
    'first-seen session should not trigger stripping',
  )

  await noteSuccessfulSignatureContext('sess-1', 'acct-a', 'claude-sonnet-4-6', 3600)

  assert.equal(
    await shouldStripSignatureBlocksForContext('sess-1', 'acct-a', 'claude-sonnet-4-6'),
    false,
    'same session + same account should not trigger stripping',
  )

  assert.equal(
    await shouldStripSignatureBlocksForContext('sess-1', 'acct-b', 'claude-sonnet-4-6'),
    true,
    'same session + different account should trigger stripping',
  )

  await noteSuccessfulSignatureContext('sess-1', 'acct-b', 'claude-sonnet-4-6', 3600)

  assert.equal(
    await shouldStripSignatureBlocksForContext('sess-1', 'acct-b', 'claude-sonnet-4-6'),
    false,
    'after updating the successful context, the new account becomes the baseline',
  )

  assert.equal(
    await shouldStripSignatureBlocksForContext('sess-1', 'acct-b', 'claude-opus-4-6'),
    true,
    'same session + different model should trigger stripping',
  )

  await noteInvalidSignatureContext('sess-1', 'acct-b', 'claude-opus-4-6', 3600)

  assert.equal(
    await shouldStripSignatureBlocksForContext('sess-1', 'acct-b', 'claude-opus-4-6'),
    true,
    'tainted session should continue stripping',
  )

  assert.equal(
    await shouldStripSignatureBlocksForContext('sess-2', 'acct-b', 'claude-opus-4-6'),
    true,
    'tainted account should strip even on a new session',
  )

  console.log('signature-context tests passed')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
