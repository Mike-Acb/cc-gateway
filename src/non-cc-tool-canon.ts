/**
 * 把非 CC 客户端 (opencode / crush / 类似 snake_case 工具命名约定的 TUI agent)
 * 的请求规整成 CC 形态,过 validateCCRequest;响应侧再反向还原,客户端能用。
 *
 * 设计原则 — 纯字面转换,零 tool-specific 翻译表:
 *   请求侧 client → upstream:
 *     1. tool.name        snake_case → PascalCase  (`read` → `Read`)
 *     2. input_schema.properties keys + required[]  camelCase → snake_case (递归)
 *     3. 唯一 alias: exec → Bash (case 转不出来,但 Bash 在 baseline 内必须命中)
 *   响应侧 upstream → client:
 *     4. tool_use.name    PascalCase → snake_case  (走 reverseMap)
 *     5. tool_use.input   keys snake_case → camelCase (递归)
 *
 * 不动 tool description / input value(只动 keys)。客户端的 schema 语义照原样
 * 透到模型,模型生成的 tool_use.input 字段就是客户端约定的命名风格。
 */

const EXEC_ALIAS_FROM = 'exec'
const EXEC_ALIAS_TO = 'Bash'

const SNAKE_RE = /_+([a-z0-9])/g
const CAMEL_RE = /([a-z0-9])([A-Z])/g

export function snakeToPascal(s: string): string {
  if (!s) return s
  const camel = s.replace(SNAKE_RE, (_, c: string) => c.toUpperCase())
  return camel.charAt(0).toUpperCase() + camel.slice(1)
}

export function pascalToSnake(s: string): string {
  if (!s) return s
  return s
    .replace(/([A-Z])/g, (_, c, i) => (i === 0 ? c.toLowerCase() : '_' + c.toLowerCase()))
}

export function camelToSnake(s: string): string {
  if (!s) return s
  return s.replace(CAMEL_RE, '$1_$2').toLowerCase()
}

export function snakeToCamel(s: string): string {
  if (!s) return s
  return s.replace(SNAKE_RE, (_, c: string) => c.toUpperCase())
}

/** 深度遍历 plain object,把所有 keys 用 fn 转换。array 透传,基础类型透传。 */
function deepKeyTransform(value: any, fn: (k: string) => string): any {
  if (Array.isArray(value)) return value.map(v => deepKeyTransform(v, fn))
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, any> = {}
  for (const k of Object.keys(value)) {
    out[fn(k)] = deepKeyTransform(value[k], fn)
  }
  return out
}

export interface CanonicalizeResult {
  tools: any[]
  /**
   * 反向 map: upstream_name → client_name
   *   `Read` → `read`
   *   `Bash` → `exec`   (exec alias 的反向)
   *   `SessionsSpawn` → `sessions_spawn`
   * 在响应 SSE transform 阶段用来把 tool_use.name 还原。
   */
  reverseMap: Map<string, string>
  /** 是否真的做了改写。完全没 snake_case tools 时 false → 不挂响应 transform。 */
  changed: boolean
}

/**
 * 入参 tools 看起来是 snake_case 风格 (任一 tool.name 含下划线或全小写) 才做改写。
 * 已经是 CC 风格的 tools (Read/Edit/...) 不动。混合时全部按规则跑一遍 — 自映射对
 * CC 风格 tool 无副作用 (Read → Read, file_path → file_path)。
 */
export function canonicalizeRequestTools(tools: any): CanonicalizeResult {
  if (!Array.isArray(tools) || tools.length === 0) {
    return { tools: [], reverseMap: new Map(), changed: false }
  }

  // 启发式:有任一 tool.name 命中 snake_case (含 `_` 或全小写无大写) 才认定需要改
  let looksNonCC = false
  for (const t of tools) {
    const n = t?.name
    if (typeof n === 'string' && n.length > 0) {
      if (n.includes('_') || (n === n.toLowerCase() && /[a-z]/.test(n))) {
        looksNonCC = true
        break
      }
    }
  }
  if (!looksNonCC) {
    return { tools, reverseMap: new Map(), changed: false }
  }

  const reverseMap = new Map<string, string>()
  const out: any[] = []
  for (const t of tools) {
    if (!t || typeof t !== 'object' || typeof t.name !== 'string') {
      out.push(t)
      continue
    }
    const original = t.name
    let mapped: string
    if (original === EXEC_ALIAS_FROM) {
      mapped = EXEC_ALIAS_TO
    } else if (original.includes('_') || original === original.toLowerCase()) {
      mapped = snakeToPascal(original)
    } else {
      // 已经是 PascalCase / 其他形态 — 不动
      mapped = original
    }
    // 自映射 (Read→Read / Edit→Edit) 不入 reverseMap。
    // 否则响应侧 SSE transform 会把这个 tool_use 也 buffer 并对 input keys 做
    // snake→camel 反向 — 真 CC 工具的 file_path/old_string 会被搅成 filePath/oldString,
    // 客户端 CLI 的 zod schema 校验失败 → "Invalid tool parameters"。
    // 触发条件:同请求里混了 MCP 工具(`mcp__server__xxx` 必含 `_`)就足以让
    // canonicalizeRequestTools 把整组判定为 non-CC 走到这里。
    if (mapped !== original) reverseMap.set(mapped, original)

    const next: any = { ...t, name: mapped }
    // 改 input_schema 的 properties keys + required[] (camelCase → snake_case)
    if (t.input_schema && typeof t.input_schema === 'object') {
      const schema = { ...t.input_schema }
      if (schema.properties && typeof schema.properties === 'object') {
        const newProps: Record<string, any> = {}
        for (const k of Object.keys(schema.properties)) {
          // 注意:只动 properties 自身的 key,不动 properties[k] 里 description 等字符串
          // 但 properties[k] 里如果有嵌套 schema (type:object + properties),要递归
          newProps[camelToSnake(k)] = remapSchemaNode(schema.properties[k])
        }
        schema.properties = newProps
      }
      if (Array.isArray(schema.required)) {
        schema.required = schema.required.map((x: any) =>
          typeof x === 'string' ? camelToSnake(x) : x,
        )
      }
      next.input_schema = schema
    }
    out.push(next)
  }
  return { tools: out, reverseMap, changed: true }
}

/** 递归处理嵌套 schema 节点 (type:object 时下钻 properties / required)。 */
function remapSchemaNode(node: any): any {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node
  const copy = { ...node }
  if (copy.properties && typeof copy.properties === 'object') {
    const np: Record<string, any> = {}
    for (const k of Object.keys(copy.properties)) {
      np[camelToSnake(k)] = remapSchemaNode(copy.properties[k])
    }
    copy.properties = np
  }
  if (Array.isArray(copy.required)) {
    copy.required = copy.required.map((x: any) =>
      typeof x === 'string' ? camelToSnake(x) : x,
    )
  }
  // items: { type:object, properties: ... } 也常见
  if (copy.items) {
    copy.items = remapSchemaNode(copy.items)
  }
  return copy
}

/** 响应侧反向:tool_use.name → 原 name (map 不命中保留原值)。 */
export function reverseToolUseName(name: string, reverseMap: Map<string, string>): string {
  return reverseMap.get(name) ?? name
}

/**
 * 响应侧反向:tool_use.input keys snake_case → camelCase。
 * input 可能是流式累积的整个 JSON object — 来到这里时已经 buffer 完。
 */
export function reverseToolUseInput(input: any): any {
  return deepKeyTransform(input, snakeToCamel)
}
