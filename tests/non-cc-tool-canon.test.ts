import { strict as assert } from 'assert'
import {
  snakeToPascal, pascalToSnake, camelToSnake, snakeToCamel,
  canonicalizeRequestTools, reverseToolUseName, reverseToolUseInput,
} from '../src/non-cc-tool-canon.js'

// ── 纯字符串 ──
{
  assert.equal(snakeToPascal('read'), 'Read')
  assert.equal(snakeToPascal('sessions_spawn'), 'SessionsSpawn')
  assert.equal(snakeToPascal('memory_get'), 'MemoryGet')
  assert.equal(snakeToPascal('web_fetch'), 'WebFetch')
  assert.equal(snakeToPascal('a_b_c_d'), 'ABCD')
  console.log('✓ snakeToPascal basics')
}
{
  assert.equal(pascalToSnake('Read'), 'read')
  assert.equal(pascalToSnake('SessionsSpawn'), 'sessions_spawn')
  assert.equal(pascalToSnake('WebFetch'), 'web_fetch')
  console.log('✓ pascalToSnake basics')
}
{
  assert.equal(camelToSnake('filePath'), 'file_path')
  assert.equal(camelToSnake('oldString'), 'old_string')
  assert.equal(camelToSnake('newString'), 'new_string')
  assert.equal(camelToSnake('replaceAll'), 'replace_all')
  assert.equal(camelToSnake('path'), 'path')
  assert.equal(camelToSnake('runInBackground'), 'run_in_background')
  console.log('✓ camelToSnake basics')
}
{
  assert.equal(snakeToCamel('file_path'), 'filePath')
  assert.equal(snakeToCamel('old_string'), 'oldString')
  assert.equal(snakeToCamel('run_in_background'), 'runInBackground')
  assert.equal(snakeToCamel('path'), 'path')
  console.log('✓ snakeToCamel basics')
}

// ── canonicalizeRequestTools — 入参非 snake 直接透传 ──
{
  const tools = [
    { name: 'Read', input_schema: { properties: { file_path: { type: 'string' } } } },
    { name: 'Bash', input_schema: { properties: { command: { type: 'string' } } } },
  ]
  const r = canonicalizeRequestTools(tools)
  assert.equal(r.changed, false)
  assert.deepEqual(r.tools, tools)
  console.log('✓ CC-style tools unchanged')
}

// ── canonicalizeRequestTools — opencode 风格 ──
{
  const tools = [
    {
      name: 'read',
      description: 'Read a file',
      input_schema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'absolute path' },
          encoding: { type: 'string' },
        },
        required: ['filePath'],
      },
    },
    {
      name: 'edit',
      input_schema: {
        properties: {
          filePath: { type: 'string' },
          oldString: { type: 'string' },
          newString: { type: 'string' },
          replaceAll: { type: 'boolean' },
        },
        required: ['filePath', 'oldString', 'newString'],
      },
    },
    { name: 'exec', input_schema: { properties: { command: { type: 'string' } } } },
    { name: 'sessions_spawn', input_schema: { properties: { agent: { type: 'string' } } } },
  ]
  const r = canonicalizeRequestTools(tools)
  assert.equal(r.changed, true)
  assert.equal(r.tools[0].name, 'Read')
  assert.equal(r.tools[0].input_schema.properties.file_path.type, 'string')
  assert.deepEqual(r.tools[0].input_schema.required, ['file_path'])
  assert.equal(r.tools[1].name, 'Edit')
  assert.equal(r.tools[1].input_schema.properties.old_string.type, 'string')
  assert.deepEqual(r.tools[1].input_schema.required, ['file_path', 'old_string', 'new_string'])
  assert.equal(r.tools[1].input_schema.properties.replace_all.type, 'boolean')
  assert.equal(r.tools[2].name, 'Bash')   // exec alias
  assert.equal(r.tools[3].name, 'SessionsSpawn')
  assert.equal(r.reverseMap.get('Read'), 'read')
  assert.equal(r.reverseMap.get('Edit'), 'edit')
  assert.equal(r.reverseMap.get('Bash'), 'exec')
  assert.equal(r.reverseMap.get('SessionsSpawn'), 'sessions_spawn')
  console.log('✓ opencode-style tools canonicalized with exec alias + reverseMap')
}

// ── reverseToolUseName ──
{
  const rm = new Map([
    ['Read', 'read'],
    ['Bash', 'exec'],
    ['SessionsSpawn', 'sessions_spawn'],
  ])
  assert.equal(reverseToolUseName('Read', rm), 'read')
  assert.equal(reverseToolUseName('Bash', rm), 'exec')
  assert.equal(reverseToolUseName('SessionsSpawn', rm), 'sessions_spawn')
  // 上游自己编出 / 未声明的 tool —— 保留原名
  assert.equal(reverseToolUseName('UnknownTool', rm), 'UnknownTool')
  console.log('✓ reverseToolUseName fallback to original on miss')
}

// ── reverseToolUseInput — keys 反向到 camelCase ──
{
  const input = {
    file_path: '/tmp/a.txt',
    old_string: 'foo',
    replace_all: true,
    nested: { run_in_background: false, sub_field: { inner_key: 1 } },
    arr: [{ key_a: 1 }, { key_b: 2 }],
  }
  const r = reverseToolUseInput(input)
  assert.deepEqual(r, {
    filePath: '/tmp/a.txt',
    oldString: 'foo',
    replaceAll: true,
    nested: { runInBackground: false, subField: { innerKey: 1 } },
    arr: [{ keyA: 1 }, { keyB: 2 }],
  })
  console.log('✓ reverseToolUseInput keys camelCased recursively (objects + arrays)')
}

// ── Round-trip:opencode 发什么 → 期望客户端拿到等价 ──
{
  // 模拟整个流程
  const clientTools = [{
    name: 'edit',
    input_schema: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        oldString: { type: 'string' },
        newString: { type: 'string' },
      },
      required: ['filePath', 'oldString', 'newString'],
    },
  }]
  const { tools: forUpstream, reverseMap } = canonicalizeRequestTools(clientTools)
  // 模型按 PascalCase schema 生成的 tool_use
  const upstreamToolUse = {
    name: 'Edit',
    input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' },
  }
  // 网关反向 → 客户端
  const clientToolUse = {
    name: reverseToolUseName(upstreamToolUse.name, reverseMap),
    input: reverseToolUseInput(upstreamToolUse.input),
  }
  assert.deepEqual(clientToolUse, {
    name: 'edit',
    input: { filePath: '/tmp/x', oldString: 'a', newString: 'b' },
  })
  console.log('✓ end-to-end round-trip: opencode edit tool')
  console.log(`  upstream sees:`, JSON.stringify(forUpstream[0].name), JSON.stringify(forUpstream[0].input_schema.required))
}

// ── Regression: CC 工具 + MCP 工具混合 — 自映射不入 reverseMap ──
//   场景:CC + 任一 MCP server (工具名形如 mcp__foo__bar,含 `_`) 触发
//   canonicalize 的启发式判定,但 CC 自家工具 (Read/Edit/...) 是自映射
//   (snakeToPascal(Read) === Read)。reverseMap 不能把它们也记进去,
//   否则响应侧 SSE transform 会对真 CC 工具的 tool_use input 做 snake→camel
//   反向 (file_path → filePath),触发客户端 CLI 的 zod 校验失败。
{
  const tools = [
    { name: 'Read', input_schema: { properties: { file_path: { type: 'string' } } } },
    { name: 'Edit', input_schema: { properties: { file_path: { type: 'string' }, old_string: { type: 'string' } } } },
    {
      name: 'mcp__memory__search',
      input_schema: {
        type: 'object',
        properties: { queryText: { type: 'string' } },
        required: ['queryText'],
      },
    },
  ]
  const r = canonicalizeRequestTools(tools)
  assert.equal(r.changed, true, 'has at least one non-CC tool → changed')
  // MCP 工具被改名,记入 map
  assert.equal(r.tools[2].name, 'McpMemorySearch')
  assert.equal(r.reverseMap.get('McpMemorySearch'), 'mcp__memory__search')
  // CC 工具自映射 — 不入 map
  assert.equal(r.reverseMap.has('Read'), false, 'Read self-mapping must NOT be in reverseMap')
  assert.equal(r.reverseMap.has('Edit'), false, 'Edit self-mapping must NOT be in reverseMap')
  // 总条目只有真改名的那一个
  assert.equal(r.reverseMap.size, 1, 'reverseMap holds only the renamed tool')
  // CC 工具的 schema keys 没被乱动
  assert.equal(r.tools[0].input_schema.properties.file_path.type, 'string')
  assert.equal(r.tools[1].input_schema.properties.old_string.type, 'string')
  console.log('✓ CC + MCP mixed: self-mapping excluded from reverseMap')
}

// ── Edge: tools 为空 / null / 异形 ──
{
  assert.deepEqual(canonicalizeRequestTools([]),       { tools: [], reverseMap: new Map(), changed: false })
  assert.deepEqual(canonicalizeRequestTools(undefined), { tools: [], reverseMap: new Map(), changed: false })
  assert.deepEqual(canonicalizeRequestTools(null),      { tools: [], reverseMap: new Map(), changed: false })
  const r = canonicalizeRequestTools([{ name: 123 }, null, { description: 'no name' }])
  assert.equal(r.changed, false) // 没有任何合法 snake name → 不动
  console.log('✓ edge: empty / non-array / malformed tools')
}

// ── Edge: 嵌套 schema (items.properties) ──
{
  const tools = [{
    name: 'memory_search',
    input_schema: {
      type: 'object',
      properties: {
        queryText: { type: 'string' },
        filterTags: {
          type: 'array',
          items: { type: 'object', properties: { tagName: { type: 'string' }, matchMode: { type: 'string' } } },
        },
      },
      required: ['queryText'],
    },
  }]
  const r = canonicalizeRequestTools(tools)
  assert.equal(r.tools[0].name, 'MemorySearch')
  assert.equal(r.tools[0].input_schema.properties.query_text.type, 'string')
  assert.equal(r.tools[0].input_schema.properties.filter_tags.items.properties.tag_name.type, 'string')
  assert.equal(r.tools[0].input_schema.properties.filter_tags.items.properties.match_mode.type, 'string')
  console.log('✓ nested schema (array items.properties) transformed')
}

console.log('\n✅ non-cc-tool-canon tests passed')
