# Full CC Body Disguise

让非 CC 客户端（NewAPI、API wrapper）的请求在 body 层面也看起来像真实的 Claude Code 请求。

## Problem

Header 伪装已完成（stainless headers、UA、anthropic-beta 补全），但 body 结构暴露了非 CC 身份：
- `tools: []` — CC 永远带 20+ 个 tool 定义
- 无 `thinking` — CC 对支持的模型总是带 thinking config
- system prompt 只有 billing header — CC 有完整的多段式系统提示

Anthropic 检测到同一 device_id 下交替出现"完整 CC body"和"裸 API body"，判定为凭证共享。

## Design

### 模板学习机制

第一个真实 CC 客户端连上来时，从它的请求中提取并缓存：
1. **tools 定义**（完整的 tool schema 数组）
2. **system prompt blocks**（billing header 之后的所有 system block）

判断"是否为 CC 请求"：`tools` 数组长度 > 3。

缓存位置：内存 + Redis（key 带 account_uuid，TTL 7 天）。PM2 重启从 Redis 恢复。

Fallback：如果没有 CC 客户端连过（缓存为空），使用内置的静态默认模板文件 `src/cc-tools-default.json` 和 `src/cc-system-default.json`。这两个文件从当前 CC 2.1.90 的真实请求中抓取。

### Body 补全规则

在 `rewriteMessagesBody` 中，identity rewrite 之后执行：

| 字段 | 条件 | 动作 |
|------|------|------|
| tools | 为空数组 `[]` 或不存在 | 注入缓存/默认模板 |
| tools | 非空（客户端自带） | 不动 |
| thinking | 不存在 | 按模型注入：opus 4.6/sonnet 4.6 → `{type:"adaptive"}`；其他支持 thinking 的模型 → `{type:"enabled", budget_tokens: max_tokens - 1}` |
| thinking | 已存在 | 不动 |
| system | 不包含 `"You are Claude Code"` 文本 | 在 billing header block 之后注入缓存/默认的 system prompt blocks |
| system | 已包含 CC 结构 | 不动 |
| max_tokens | 入站值 < 1024 | 拉到模型默认值：opus→64000, sonnet→32000, haiku→32000, 默认→32000 |
| max_tokens | 入站值 >= 1024 | 不改 |
| output_config | — | 不改 |
| stream | — | 不改 |

### Thinking 模型判断

从 CC 源码（`src/utils/thinking.ts`）的逻辑：
- **支持 adaptive thinking**：model 名包含 `opus-4-6`、`sonnet-4-6`（或更高版本）
- **支持 thinking 但不支持 adaptive**：model 名包含 `haiku-4-5`、`opus-4-5`、`sonnet-4-5`
- **不支持 thinking**：其他模型 → 不注入

### 模板缓存结构

```typescript
type CCTemplateCache = {
  tools: any[]              // 完整 tool schema 数组
  systemBlocks: any[]       // system prompt blocks（不含 billing header）
  learnedAt: number         // 学习时间
  learnedFromUA: string     // 学习来源的 CC 版本
}
```

Redis key: `cc-template:{accountUuid}`, 值为 JSON，TTL 7 天。

内存: `Map<string, CCTemplateCache>`, key = accountUuid。

### 学习触发

在 `rewriteMessagesBody` 开头：
```
if (body.tools?.length > 3 && !templateCache.has(acctId)) {
  // 提取 tools 和 system blocks，写入内存 + Redis
}
```

只学一次（首次 CC 请求），后续不覆盖。CC 版本更新后 Redis TTL 过期，下次 CC 请求重新学习。

### 静态默认模板

从真实 CC 2.1.90 请求中提取，存为两个 JSON 文件：
- `src/cc-tools-default.json` — 20 个 tool 的完整 schema
- `src/cc-system-default.json` — CC 标准 system prompt blocks（不含 billing header）

这些文件只在没有任何 CC 客户端连过时使用。

## Files

| File | Change |
|------|--------|
| `src/cc-disguise.ts` | 新模块：模板缓存管理 + body 补全逻辑 |
| `src/cc-tools-default.json` | 静态 tools 模板 |
| `src/cc-system-default.json` | 静态 system prompt 模板 |
| `src/rewriter.ts` | 在 `rewriteMessagesBody` 中调用 disguise |

## Not In Scope

- 伪装 `/v1/messages/count_tokens` 请求
- 伪装 event_logging batch 的 body
- 动态跟踪 CC 版本更新（依赖 Redis TTL 过期后重新学习）
