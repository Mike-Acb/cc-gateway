import { rewriteBody, rewriteHeaders, type RewriteOptions } from '../src/rewriter.js'
import type { Config } from '../src/config.js'
import { strict as assert } from 'assert'
import { _setTemplateCacheForTest, resetTemplateCache } from '../src/cc-disguise.js'

const TEST_ACCOUNT_ID = 'rw-test-account'

// Seed a minimal CC 2.1.112 template so rewriteMessagesBody→disguiseBody doesn't
// throw NoTemplateBoundError. Content doesn't need to be realistic — these tests
// assert billing-header / env rewriting, not disguise injection itself (that's
// covered in cc-disguise.test.ts).
resetTemplateCache()
_setTemplateCacheForTest(TEST_ACCOUNT_ID, {
  templateId: 'tpl-rw-test',
  tools: [
    { name: 'Task', description: 'stub', input_schema: { type: 'object' } },
    { name: 'Agent', description: 'stub', input_schema: { type: 'object' } },
    { name: 'Bash', description: 'stub', input_schema: { type: 'object' } },
    { name: 'Edit', description: 'stub', input_schema: { type: 'object' } },
    { name: 'Read', description: 'stub', input_schema: { type: 'object' } },
    { name: 'Write', description: 'stub', input_schema: { type: 'object' } },
    { name: 'Glob', description: 'stub', input_schema: { type: 'object' } },
    { name: 'Grep', description: 'stub', input_schema: { type: 'object' } },
  ],
  systemBlocks: [
    { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
  ],
  sourceUA: 'claude-cli/2.1.112 (external, cli)',
  loadedAt: Date.now(),
})

const config = {
  server: { port: 8443, tls: { cert: '', key: '' } },
  upstream: { url: 'https://api.anthropic.com' },
  auth: { tokens: [{ name: 'test', token: 'test-token' }] },
  oauth: { refresh_token: 'test-refresh' },
  redis: { host: 'localhost', port: 6379 },
  process: {
    constrained_memory: 34359738368,
    rss_range: [300000000, 500000000],
    heap_total_range: [40000000, 80000000],
    heap_used_range: [100000000, 200000000],
  },
  logging: { level: 'error', audit: false },
} satisfies Config

const opts: RewriteOptions = {
  profile: {
    oauth_account_id: TEST_ACCOUNT_ID,
    cc_template_id: 'tpl-rw-test',
    identity: {
      device_id: 'canonical_device_id_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      email: 'canonical@example.com',
      account_uuid: 'canonical-account-uuid',
    },
    env: {
      platform: 'darwin',
      platform_raw: 'darwin',
      arch: 'arm64',
      node_version: 'v24.3.0',
      terminal: 'iTerm2.app',
      version: '2.1.81',
      version_base: '2.1.81',
      package_managers: ['npm', 'pnpm'],
      runtimes: ['node'],
      is_running_with_bun: false,
      is_claude_ai_auth: true,
      build_time: '2026-03-20T21:26:18Z',
      deployment_environment: 'unknown-darwin',
      vcs: 'git',
    },
    promptEnv: {
      platform: 'darwin',
      shell: 'zsh',
      os_version: 'Darwin 24.4.0',
      home_prefix: '/Users/dev/',
    },
    fingerprint: {
      user_agent: 'claude-code/2.1.81 (external, cli)',
      x_app: 'cli',
      x_stainless_lang: 'js',
      x_stainless_runtime: 'node',
      x_stainless_runtime_version: 'v24.3.0',
      x_stainless_os: 'MacOS',
      x_stainless_arch: 'arm64',
      x_stainless_package_version: '2.1.81',
      prompt_platform: 'darwin',
      prompt_shell: 'zsh',
      prompt_os_version: 'Darwin 24.4.0',
      prompt_home_prefix: '/Users/dev/',
    },
  },
  derivedSessionId: 'derived-session-id-1234',
}

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ✗ ${name}`)
    console.log(`    ${err}`)
  }
}

// ============================================================
console.log('\n/v1/messages - metadata.user_id rewriting')
// ============================================================

await test('rewrites device_id in metadata.user_id', async () => {
  const body = {
    metadata: {
      user_id: JSON.stringify({
        device_id: 'original_device_id',
        account_uuid: 'acct-123',
        session_id: 'sess-456',
      }),
    },
    messages: [{ role: 'user', content: 'hello' }],
  }

  const result = JSON.parse(
    (await rewriteBody(Buffer.from(JSON.stringify(body)), '/v1/messages', config, opts)).toString(),
  )
  const userId = JSON.parse(result.metadata.user_id)

  assert.equal(userId.device_id, opts.profile.identity.device_id)
  assert.equal(userId.account_uuid, opts.profile.identity.account_uuid)
  assert.equal(userId.session_id, opts.derivedSessionId)
})

// ============================================================
console.log('\n/v1/messages - system prompt environment rewriting')
// ============================================================

await test('preserves Platform in system prompt while injecting template blocks', async () => {
  const body = {
    system: [{ type: 'text', text: 'Platform: linux\nShell: bash\nOS Version: Linux 6.5.0' }],
    messages: [],
  }
  const result = JSON.parse(
    (await rewriteBody(Buffer.from(JSON.stringify(body)), '/v1/messages', config, opts)).toString(),
  )
  const envBlock = result.system.find((b: any) => (b.text ?? b).includes('Platform:'))
  assert.ok(envBlock, 'Should have a block with Platform')
  const text = envBlock.text ?? envBlock
  assert.ok(text.includes('Platform: linux'))
  assert.ok(text.includes('Shell: bash'))
  assert.ok(text.includes('OS Version: Linux 6.5.0'))
})

await test('preserves working directory path', async () => {
  const body = {
    system: 'Primary working directory: /home/bob/myproject',
    messages: [],
  }
  const result = JSON.parse(
    (await rewriteBody(Buffer.from(JSON.stringify(body)), '/v1/messages', config, opts)).toString(),
  )
  assert.ok(result.system.includes('/home/bob/myproject'), `Got: ${result.system}`)
})

await test('rewrites billing header in system prompt (string format)', async () => {
  const body = {
    system: 'x-anthropic-billing-header: cc_version=2.1.81.a1b; cc_entrypoint=cli; cch=00000;\nOther content here.',
    messages: [],
  }
  const result = JSON.parse(
    (await rewriteBody(Buffer.from(JSON.stringify(body)), '/v1/messages', config, opts)).toString(),
  )
  assert.ok(result.system.includes('x-anthropic-billing-header:'), 'Billing header should be rewritten, not stripped')
  assert.ok(result.system.includes('cch=00000'), 'Should contain cch placeholder')
  assert.ok(result.system.includes('cc_entrypoint=cli'), 'Should contain entrypoint')
  assert.ok(result.system.includes('Other content'), 'Non-billing content should remain')
})

await test('rewrites billing header in system prompt (array format)', async () => {
  const body = {
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.81.a1b; cc_entrypoint=cli;' },
      { type: 'text', text: 'Platform: linux\nShell: bash' },
    ],
    messages: [],
  }
  const result = JSON.parse(
    (await rewriteBody(Buffer.from(JSON.stringify(body)), '/v1/messages', config, opts)).toString(),
  )
  assert.equal(result.system.length, 3, 'Billing header rewrite now also injects template blocks')
  assert.ok(result.system[0].text.includes('cch=00000'), 'First block should have cch placeholder')
  assert.ok(result.system[0].text.includes('cc_version=2.1.112.'), 'Should use template version')
  assert.ok(result.system[2].text.includes('Platform: linux'), 'Original env block should be preserved')
})

await test('injects billing header when client did not send one', async () => {
  const body = {
    system: [
      { type: 'text', text: 'Platform: linux\nShell: bash' },
    ],
    messages: [],
  }
  const result = JSON.parse(
    (await rewriteBody(Buffer.from(JSON.stringify(body)), '/v1/messages', config, opts)).toString(),
  )
  assert.equal(result.system.length, 3, 'Should inject billing block plus template blocks')
  assert.ok(result.system[0].text.includes('x-anthropic-billing-header:'), 'Injected block should be first')
  assert.ok(result.system[0].text.includes('cch=00000'), 'Injected block should have cch placeholder')
})

await test('api_key canonical rewrite injects billing header without template blocks', async () => {
  const body = {
    system: [
      { type: 'text', text: 'Platform: linux\nShell: bash' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    model: 'claude-opus-4-6',
    max_tokens: 32000,
    stream: true,
  }
  const result = JSON.parse(
    (await rewriteBody(
      Buffer.from(JSON.stringify(body)),
      '/v1/messages',
      config,
      { ...opts, disableTemplateDisguise: true },
    )).toString(),
  )
  assert.equal(result.system.length, 2, 'Should only inject billing block and preserve original env block')
  assert.ok(result.system[0].text.includes('x-anthropic-billing-header:'), 'Injected block should be first')
  assert.ok(!result.system.some((b: any) => (b?.text ?? b).includes('You are Claude Code')), 'Should not inject template disguise blocks')
  assert.deepEqual(result.tools, [], 'Should preserve original sparse tools array')
})

await test('api_key canonical rewrite preserves sparse body while canonicalizing metadata', async () => {
  const body = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    model: 'claude-opus-4-6',
    max_tokens: 32000,
    stream: true,
  }
  const result = JSON.parse(
    (await rewriteBody(
      Buffer.from(JSON.stringify(body)),
      '/v1/messages',
      config,
      { ...opts, disableTemplateDisguise: true },
    )).toString(),
  )
  const userId = JSON.parse(result.metadata.user_id)
  assert.equal(userId.device_id, opts.profile.identity.device_id)
  assert.equal(userId.account_uuid, opts.profile.identity.account_uuid)
  assert.equal(userId.session_id, opts.derivedSessionId)
  assert.equal(result.max_tokens, 32000)
  assert.equal(result.stream, true)
  assert.deepEqual(result.tools, [])
})

await test('api_key canonical header rewrite keeps claude-cli user agent', async () => {
  const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', tools: [], messages: [{ role: 'user', content: 'hi' }] }))
  const headers = await rewriteHeaders(
    { 'user-agent': 'claude-code/2.1.123', 'content-type': 'application/json' },
    config,
    { ...opts, disableTemplateDisguise: true },
    '/v1/messages',
    body,
  )
  assert.equal(headers['user-agent'], 'claude-cli/2.1.112 (external, cli)')
  assert.ok(headers['x-claude-code-session-id'])
  assert.ok(headers['anthropic-beta']?.includes('claude-code-20250219'))
})

await test('preserves home paths in user messages with system-reminder', async () => {
  const body = {
    system: '',
    messages: [{
      role: 'user',
      content: '<system-reminder>Working directory: /home/alice/code</system-reminder>',
    }],
  }
  const result = JSON.parse(
    (await rewriteBody(Buffer.from(JSON.stringify(body)), '/v1/messages', config, opts)).toString(),
  )
  assert.ok(result.messages[0].content[0].text.includes('/home/alice/code'))
})

await test('merges adjacent user messages and hoists tool_result blocks first', async () => {
  const body = {
    system: '',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd', caller: 'tool_search' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'before result' },
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'after result' },
        ],
      },
    ],
    tools: [
      { name: 'Task', description: 'stub', input_schema: { type: 'object' } },
      { name: 'Agent', description: 'stub', input_schema: { type: 'object' } },
      { name: 'Bash', description: 'stub', input_schema: { type: 'object' } },
    ],
  }

  const result = JSON.parse(
    (await rewriteBody(Buffer.from(JSON.stringify(body)), '/v1/messages', config, opts)).toString(),
  )

  assert.equal(result.messages.length, 2, 'adjacent user turns should merge')
  assert.equal(result.messages[0].content[0].type, 'tool_use')
  assert.equal(result.messages[0].content[0].caller, undefined, 'caller field should be stripped')
  assert.equal(result.messages[1].content[0].type, 'tool_result', 'tool_result should be hoisted to the front')
  assert.equal(result.messages[1].content[1].type, 'text')
  assert.equal(result.messages[1].content[2].type, 'text')
  assert.equal(result.messages[1].content[1].text, 'before result')
  assert.equal(result.messages[1].content[2].text, 'after result')
})

await test('smooshes system-reminder siblings into the last tool_result', async () => {
  const body = {
    system: '',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'cat /tmp/a' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'file text' },
          { type: 'text', text: '<system-reminder>Read only the requested file.</system-reminder>' },
        ],
      },
    ],
    tools: [
      { name: 'Task', description: 'stub', input_schema: { type: 'object' } },
      { name: 'Agent', description: 'stub', input_schema: { type: 'object' } },
      { name: 'Bash', description: 'stub', input_schema: { type: 'object' } },
    ],
  }

  const result = JSON.parse(
    (await rewriteBody(Buffer.from(JSON.stringify(body)), '/v1/messages', config, opts)).toString(),
  )

  assert.equal(result.messages[1].content.length, 1, 'system-reminder sibling should be folded into tool_result')
  assert.equal(result.messages[1].content[0].type, 'tool_result')
  assert.equal(
    result.messages[1].content[0].content,
    'file text\n\n<system-reminder>Read only the requested file.</system-reminder>',
  )
})

await test('sanitizes error tool_result content to text-only', async () => {
  const body = {
    system: '',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_err', name: 'Bash', input: { command: 'bad command' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_err',
            is_error: true,
            content: [
              { type: 'text', text: 'command failed' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'abc' },
              },
            ],
          },
        ],
      },
    ],
    tools: [
      { name: 'Task', description: 'stub', input_schema: { type: 'object' } },
      { name: 'Agent', description: 'stub', input_schema: { type: 'object' } },
      { name: 'Bash', description: 'stub', input_schema: { type: 'object' } },
    ],
  }

  const result = JSON.parse(
    (await rewriteBody(Buffer.from(JSON.stringify(body)), '/v1/messages', config, opts)).toString(),
  )

  assert.deepEqual(result.messages[1].content[0].content, [{ type: 'text', text: 'command failed' }])
})

await test('removes orphaned leading tool_result and repairs missing tool_result pairs', async () => {
  const body = {
    system: '',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'orphaned_tool', content: 'stale orphan' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_missing', name: 'Bash', input: { command: 'echo hi' } },
        ],
      },
    ],
    tools: [
      { name: 'Task', description: 'stub', input_schema: { type: 'object' } },
      { name: 'Agent', description: 'stub', input_schema: { type: 'object' } },
      { name: 'Bash', description: 'stub', input_schema: { type: 'object' } },
    ],
  }

  const result = JSON.parse(
    (await rewriteBody(Buffer.from(JSON.stringify(body)), '/v1/messages', config, opts)).toString(),
  )

  assert.equal(result.messages.length, 3, 'missing tool_result should be synthesized')
  assert.deepEqual(result.messages[0].content, [
    { type: 'text', text: '[Orphaned tool result removed due to conversation resume]' },
  ])
  assert.equal(result.messages[2].role, 'user')
  assert.equal(result.messages[2].content[0].type, 'tool_result')
  assert.equal(result.messages[2].content[0].tool_use_id, 'toolu_missing')
  assert.equal(result.messages[2].content[0].is_error, true)
})

await test('filters orphaned thinking-only assistants and ensures assistant content stays non-empty', async () => {
  const body = {
    system: '',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private chain', signature: 'sig-1' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '   ' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_3', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_3', content: 'done' },
        ],
      },
    ],
    tools: [
      { name: 'Task', description: 'stub', input_schema: { type: 'object' } },
      { name: 'Agent', description: 'stub', input_schema: { type: 'object' } },
      { name: 'Bash', description: 'stub', input_schema: { type: 'object' } },
    ],
  }

  const result = JSON.parse(
    (await rewriteBody(Buffer.from(JSON.stringify(body)), '/v1/messages', config, opts)).toString(),
  )

  assert.equal(result.messages.length, 2, 'orphaned thinking and whitespace-only assistants should be filtered out')
  assert.equal(result.messages[0].role, 'assistant')
  assert.equal(result.messages[1].role, 'user')
})

await test('does not merge adjacent assistant messages in gateway normalization', async () => {
  const body = {
    system: '',
    messages: [
      {
        role: 'assistant',
        id: 'msg_a_1',
        content: [{ type: 'text', text: 'first assistant chunk' }],
      },
      {
        role: 'assistant',
        id: 'msg_a_2',
        content: [{ type: 'text', text: 'second assistant chunk' }],
      },
    ],
  }

  const result = JSON.parse(
    (await rewriteBody(Buffer.from(JSON.stringify(body)), '/v1/messages', config, opts)).toString(),
  )

  assert.equal(result.messages.length, 2, 'adjacent assistants should stay separate in gateway')
  assert.equal(result.messages[0].content[0].text, 'first assistant chunk')
  assert.equal(result.messages[1].content[0].text, 'second assistant chunk')
})

await test('preserves caller and available tool_reference when tool search is enabled', async () => {
  const body = {
    system: '',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_ts', name: 'Bash', input: { command: 'pwd' }, caller: 'tool_search' },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_ts',
            content: [
              { type: 'tool_reference', tool_name: 'Read' },
            ],
          },
          { type: 'text', text: 'Tool loaded.' },
        ],
      },
    ],
    tools: [
      { name: 'Task', description: 'stub', input_schema: { type: 'object' } },
      { name: 'Agent', description: 'stub', input_schema: { type: 'object' } },
      { name: 'Bash', description: 'stub', input_schema: { type: 'object' } },
      { name: 'Read', description: 'stub', input_schema: { type: 'object' } },
      { name: 'tool_search', description: 'stub', input_schema: { type: 'object' } },
    ],
  }

  const result = JSON.parse(
    (await rewriteBody(Buffer.from(JSON.stringify(body)), '/v1/messages', config, opts)).toString(),
  )

  assert.equal(result.messages[0].content[0].caller, 'tool_search', 'caller should survive when tool search is enabled')
  assert.equal(result.messages[1].content[0].content[0].type, 'tool_reference', 'available tool_reference should survive')
  assert.equal(result.messages[1].content[1].type, 'text', 'tool_reference sibling text should stay in place')
  assert.equal(result.messages[1].content[1].text, 'Tool loaded.')
})

await test('strips caller and tool_reference blocks when tool search is not enabled', async () => {
  const body = {
    system: '',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_no_ts', name: 'Bash', input: { command: 'pwd' }, caller: 'tool_search' },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_no_ts',
            content: [
              { type: 'tool_reference', tool_name: 'Read' },
            ],
          },
        ],
      },
    ],
    tools: [
      { name: 'Task', description: 'stub', input_schema: { type: 'object' } },
      { name: 'Agent', description: 'stub', input_schema: { type: 'object' } },
      { name: 'Bash', description: 'stub', input_schema: { type: 'object' } },
      { name: 'Read', description: 'stub', input_schema: { type: 'object' } },
    ],
  }

  const result = JSON.parse(
    (await rewriteBody(Buffer.from(JSON.stringify(body)), '/v1/messages', config, opts)).toString(),
  )

  assert.equal(result.messages[0].content[0].caller, undefined, 'caller should be stripped when tool search is disabled')
  assert.deepEqual(result.messages[1].content[0].content, [
    { type: 'text', text: '[Tool references removed - tool search not enabled]' },
  ])
})

await test('strips signature-bearing thinking blocks when requested', async () => {
  const body = {
    system: '',
    messages: [
      {
        role: 'assistant',
        id: 'msg_think_1',
        content: [
          { type: 'thinking', thinking: 'private chain', signature: 'sig-123' },
          { type: 'text', text: 'visible answer' },
        ],
      },
    ],
  }

  const result = JSON.parse(
    (await rewriteBody(
      Buffer.from(JSON.stringify(body)),
      '/v1/messages',
      config,
      { ...opts, stripSignatureBlocks: true },
    )).toString(),
  )

  assert.deepEqual(result.messages[0].content, [
    { type: 'text', text: 'visible answer' },
  ])
})

await test('drops text/thinking blocks after final tool_use when dropTrailingAfterToolUse', async () => {
  // 真实样本:trace ccg-moxta8zc-2972c92fb8f7 (sharpglacier665, 2026-05-09 11:55)
  // 客户端 SDK 重组 streaming 时把 text 重复输出,产生 [text, tool_use, text(重复)]
  // Anthropic 上游误判为配对缺失,回 400 messages.1: tool_use without tool_result。
  const body = {
    system: '',
    messages: [
      { role: 'user', content: '需求' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我来处理。' },
          { type: 'tool_use', id: 'toolu_01abc', name: 'Bash', input: { command: 'ls' } },
          { type: 'text', text: '我来处理。' },
          { type: 'thinking', thinking: 'leftover', signature: 'sig' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_01abc', content: 'ok' },
        ],
      },
    ],
  }

  const result = JSON.parse(
    (await rewriteBody(
      Buffer.from(JSON.stringify(body)),
      '/v1/messages',
      config,
      { ...opts, dropTrailingAfterToolUse: true },
    )).toString(),
  )

  assert.deepEqual(result.messages[1].content, [
    { type: 'text', text: '我来处理。' },
    { type: 'tool_use', id: 'toolu_01abc', name: 'Bash', input: { command: 'ls' } },
  ])
})

await test('keeps blocks after final tool_use when dropTrailingAfterToolUse is false', async () => {
  const body = {
    system: '',
    messages: [
      { role: 'user', content: '需求' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我来处理。' },
          { type: 'tool_use', id: 'toolu_01abc', name: 'Bash', input: { command: 'ls' } },
          { type: 'text', text: 'trailing kept' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_01abc', content: 'ok' },
        ],
      },
    ],
  }

  const result = JSON.parse(
    (await rewriteBody(
      Buffer.from(JSON.stringify(body)),
      '/v1/messages',
      config,
      { ...opts, dropTrailingAfterToolUse: false },
    )).toString(),
  )

  // 默认 false → 保留 trailing text(透传需求)
  assert.equal(result.messages[1].content.length, 3)
  assert.equal(result.messages[1].content[2].type, 'text')
  assert.equal(result.messages[1].content[2].text, 'trailing kept')
})

// ============================================================
console.log('\n/api/event_logging/batch - event data rewriting')
// ============================================================

await test('rewrites device_id and email in events', async () => {
  const body = {
    events: [{
      event_type: 'ClaudeCodeInternalEvent',
      event_data: {
        device_id: 'real_device_id',
        email: 'real@email.com',
        event_name: 'tengu_init',
        env: { platform: 'linux', arch: 'x64' },
      },
    }],
  }
  const result = JSON.parse(
    (await rewriteBody(Buffer.from(JSON.stringify(body)), '/api/event_logging/batch', config, opts)).toString(),
  )
  const data = result.events[0].event_data
  assert.equal(data.device_id, opts.profile.identity.device_id)
  assert.equal(data.email, opts.profile.identity.email)
})

await test('preserves event env object', async () => {
  const body = {
    events: [{
      event_type: 'ClaudeCodeInternalEvent',
      event_data: {
        device_id: 'x',
        env: {
          platform: 'linux',
          arch: 'x64',
          node_version: 'v20.0.0',
          terminal: 'xterm',
          is_ci: true,
          deployment_environment: 'unknown-linux',
        },
      },
    }],
  }
  const result = JSON.parse(
    (await rewriteBody(Buffer.from(JSON.stringify(body)), '/api/event_logging/batch', config, opts)).toString(),
  )
  const env = result.events[0].event_data.env
  assert.equal(env.platform, 'linux')
  assert.equal(env.arch, 'x64')
  assert.equal(env.node_version, 'v20.0.0')
  assert.equal(env.terminal, 'xterm')
  assert.equal(env.is_ci, true)
  assert.equal(env.deployment_environment, 'unknown-linux')
})

await test('strips baseUrl that leaks gateway address', async () => {
  const body = {
    events: [{
      event_type: 'ClaudeCodeInternalEvent',
      event_data: {
        device_id: 'x',
        baseUrl: 'https://gateway.office.com:8443',
        gateway: 'custom',
      },
    }],
  }
  const result = JSON.parse(
    (await rewriteBody(Buffer.from(JSON.stringify(body)), '/api/event_logging/batch', config, opts)).toString(),
  )
  const data = result.events[0].event_data
  assert.equal(data.baseUrl, undefined, 'baseUrl should be stripped')
  assert.equal(data.gateway, undefined, 'gateway should be stripped')
})

await test('preserves process metrics (base64 encoded)', async () => {
  const processData = {
    uptime: 100,
    rss: 999999999,
    heapTotal: 999999999,
    heapUsed: 999999999,
    constrainedMemory: 68719476736, // 64GB - different from canonical 32GB
    cpuUsage: { user: 1000, system: 500 },
  }
  const body = {
    events: [{
      event_type: 'ClaudeCodeInternalEvent',
      event_data: {
        device_id: 'x',
        process: Buffer.from(JSON.stringify(processData)).toString('base64'),
      },
    }],
  }
  const result = JSON.parse(
    (await rewriteBody(Buffer.from(JSON.stringify(body)), '/api/event_logging/batch', config, opts)).toString(),
  )
  const decoded = JSON.parse(
    Buffer.from(result.events[0].event_data.process, 'base64').toString(),
  )
  assert.equal(decoded.constrainedMemory, 68719476736, 'Should preserve original constrainedMemory')
  assert.equal(decoded.uptime, 100, 'uptime should be preserved')
  assert.equal(decoded.rss, 999999999, 'rss should be preserved')
})

// ============================================================
console.log('\nHTTP header rewriting')
// ============================================================

await test('rewrites User-Agent to canonical version', async () => {
  const headers = await rewriteHeaders(
    { 'user-agent': 'claude-code/2.0.50 (external, cli)', 'x-app': 'cli' },
    config,
    opts,
  )
  assert.equal(headers['user-agent'], 'claude-cli/2.1.112 (external, cli)')
  assert.equal(headers['x-app'], 'cli')
})

await test('strips authorization header (gateway injects its own)', async () => {
  const headers = await rewriteHeaders(
    { 'authorization': 'Bearer client-placeholder-token', 'x-app': 'cli' },
    config,
  )
  assert.equal(headers['authorization'], undefined)
})

await test('strips proxy-authorization header', async () => {
  const headers = await rewriteHeaders(
    { 'proxy-authorization': 'Bearer proxy-token' },
    config,
  )
  assert.equal(headers['proxy-authorization'], undefined)
})

await test('strips x-api-key header (gateway injects real token)', async () => {
  const headers = await rewriteHeaders(
    { 'x-api-key': 'client-gateway-token', 'x-app': 'cli' },
    config,
  )
  assert.equal(headers['x-api-key'], undefined)
  assert.equal(headers['x-app'], 'cli')
})

await test('strips x-anthropic-billing-header', async () => {
  const headers = await rewriteHeaders(
    { 'x-anthropic-billing-header': 'cc_version=2.1.81.a1b; cc_entrypoint=cli;' },
    config,
  )
  assert.equal(headers['x-anthropic-billing-header'], undefined)
})

// ============================================================
console.log('\nNon-JSON passthrough')
// ============================================================

await test('passes non-JSON body through unchanged', async () => {
  const raw = Buffer.from('not json content')
  const result = await rewriteBody(raw, '/v1/messages', config)
  assert.equal(result.toString(), 'not json content')
})

// ── OS/arch lock tests ──

{
  // First request sets the OS lock
  const h1 = await rewriteHeaders(
    { 'x-stainless-os': 'Linux', 'x-stainless-arch': 'x64', 'user-agent': 'claude-cli/2.1.94 (external, cli)', 'content-type': 'application/json' },
    config,
    { ...opts, derivedSessionId: 'test-session' },
  )
  assert.equal(h1['x-stainless-os'], 'Linux', 'first request OS should pass through')
  assert.equal(h1['x-stainless-arch'], 'x64', 'first request arch should pass through')

  // Second request with different OS should be locked to the first
  const h2 = await rewriteHeaders(
    { 'x-stainless-os': 'MacOS', 'x-stainless-arch': 'arm64', 'user-agent': 'claude-cli/2.1.94 (external, cli)', 'content-type': 'application/json' },
    config,
    { ...opts, derivedSessionId: 'test-session' },
  )
  assert.equal(h2['x-stainless-os'], 'Linux', 'second request OS should be locked to first')
  assert.equal(h2['x-stainless-arch'], 'x64', 'second request arch should be locked to first')
  console.log('✓ OS/arch lock')
}

// ── Zero-leak header tests (new architecture) ──

{
  // Cloudflare / CDN / proxy pollution must NEVER leak to outbound
  const h = await rewriteHeaders(
    {
      'user-agent': 'Go-http-client/2.0',
      'cf-ray': '9ed142166895d521-NRT',
      'cdn-loop': 'cloudflare; loops=1',
      'cf-visitor': '{"scheme":"https"}',
      'cf-ipcountry': 'JP',
      'cf-connecting-ip': '172.238.15.15',
      'cf-warp-tag-id': 'abc-def-123',
      'x-forwarded-for': '172.238.15.15, 139.155.158.89',
      'x-forwarded-proto': 'https',
      'x-real-ip': '139.155.158.89',
      'x-request-log-id': '20260416070025868139651We3EkBw2',
      'content-type': 'application/json',
    },
    config,
    { ...opts, derivedSessionId: 'test-sess-zero-leak' },
    '/v1/messages',
  )
  for (const pollutant of ['cf-ray', 'cdn-loop', 'cf-visitor', 'cf-ipcountry', 'cf-connecting-ip', 'cf-warp-tag-id', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip', 'x-request-log-id']) {
    assert.equal(h[pollutant], undefined, `${pollutant} must not appear in outbound`)
  }
  // Non-CC UA should not lock; UA should come from cache or default
  assert.ok(h['user-agent']?.startsWith('claude-'), `UA must be CC-shaped, got: ${h['user-agent']}`)
  assert.ok(!h['user-agent']?.startsWith('Go-http'), 'Non-CC UA must not leak')
  console.log('✓ zero-leak: cf-*/cdn-loop/x-forwarded-*/x-real-ip dropped, non-CC UA replaced')
}

{
  // anthropic-beta must be model-aware: haiku omits claude-code-20250219
  const haikuBody = Buffer.from(JSON.stringify({ model: 'claude-haiku-4-5-20251001' }))
  const h = await rewriteHeaders(
    { 'user-agent': 'claude-cli/2.1.90 (external, cli)' },
    config,
    { ...opts, derivedSessionId: 'test-sess-haiku' },
    '/v1/messages',
    haikuBody,
  )
  assert.ok(!h['anthropic-beta']?.includes('claude-code-20250219'), 'haiku must NOT include claude-code-20250219')
  assert.ok(h['anthropic-beta']?.includes('oauth-2025-04-20'), 'haiku must include oauth-2025-04-20')
  assert.ok(h['anthropic-beta']?.includes('context-management-2025-06-27'), 'haiku must include context-management-2025-06-27')
  console.log(`✓ beta haiku: ${h['anthropic-beta']}`)

  // Opus includes claude-code-20250219 + effort
  const opusBody = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6' }))
  const h2 = await rewriteHeaders(
    { 'user-agent': 'claude-cli/2.1.90 (external, cli)' },
    config,
    { ...opts, derivedSessionId: 'test-sess-opus' },
    '/v1/messages',
    opusBody,
  )
  assert.ok(h2['anthropic-beta']?.includes('claude-code-20250219'), 'opus must include claude-code-20250219')
  assert.ok(h2['anthropic-beta']?.includes('effort-2025-11-24'), 'opus must include effort-2025-11-24')
  assert.ok(h2['anthropic-beta']?.includes('context-1m-2025-08-07'), 'opus must include context-1m-2025-08-07')
  console.log(`✓ beta opus: ${h2['anthropic-beta']}`)

  // Sonnet gets claude-code flag + effort but NOT context-1m (different entitlement)
  const sonnetBody = Buffer.from(JSON.stringify({ model: 'claude-sonnet-4-6' }))
  const hs = await rewriteHeaders(
    { 'user-agent': 'claude-cli/2.1.90 (external, cli)' },
    config,
    { ...opts, derivedSessionId: 'test-sess-sonnet' },
    '/v1/messages',
    sonnetBody,
  )
  assert.ok(hs['anthropic-beta']?.includes('claude-code-20250219'), 'sonnet must include claude-code-20250219')
  assert.ok(hs['anthropic-beta']?.includes('effort-2025-11-24'), 'sonnet must include effort-2025-11-24')
  assert.ok(!hs['anthropic-beta']?.includes('context-1m-2025-08-07'),
    'sonnet must NOT include context-1m-2025-08-07 (triggers 429 "Extra usage required for long context requests")')
  console.log(`✓ beta sonnet: ${hs['anthropic-beta']}`)

  // structured-outputs adds when body has output_config.format
  const soBody = Buffer.from(JSON.stringify({
    model: 'claude-sonnet-4-6',
    output_config: { format: { type: 'json_schema', schema: {} } },
  }))
  const h3 = await rewriteHeaders({}, config, { ...opts, derivedSessionId: 'test-sess-so' }, '/v1/messages', soBody)
  assert.ok(h3['anthropic-beta']?.includes('structured-outputs-2025-12-15'), 'structured outputs body must trigger beta flag')
  console.log(`✓ beta structured-outputs added`)
}

{
  // x-client-request-id must be a fresh UUID per request, never from inbound
  const inboundId = 'INBOUND-TRACE-ID-SHOULD-NOT-LEAK'
  const h = await rewriteHeaders(
    {
      'user-agent': 'claude-cli/2.1.90 (external, cli)',
      'x-client-request-id': inboundId,
    },
    config,
    { ...opts, derivedSessionId: 'test-sess-uuid' },
    '/v1/messages',
  )
  assert.notEqual(h['x-client-request-id'], inboundId, 'inbound x-client-request-id must not leak')
  assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(h['x-client-request-id'] ?? ''),
    `x-client-request-id must be UUID, got: ${h['x-client-request-id']}`)
  console.log(`✓ x-client-request-id fresh UUID`)
}

// ============================================================
console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
