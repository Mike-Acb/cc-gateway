import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api/client'
import { Button, Field, Input, Modal, Pill, Table } from '../../ui'
import type { Column } from '../../ui/Table'

type TemplateSource = 'manual' | 'cloned' | 'imported'

// Placeholders the gateway substitutes at request time (cc-disguise.ts:
// buildPlaceholderSubstitutions). Must stay in sync with the backend list;
// used by the admin UI to surface which placeholders a template carries
// and to warn when an imported template is missing expected ones.
const KNOWN_PLACEHOLDERS = [
  'CWD', 'PLATFORM', 'SHELL', 'OS_VERSION',
  'MODEL_MARKETING', 'MODEL_ID', 'CUTOFF',
] as const
type PlaceholderKey = (typeof KNOWN_PLACEHOLDERS)[number]

const PLACEHOLDER_DESCRIPTIONS: Record<PlaceholderKey, string> = {
  CWD: '按账号派生的 workspace 路径（home_prefix + hash）',
  PLATFORM: 'identity_profile.prompt_env.platform（darwin/win32/linux）',
  SHELL: 'identity_profile.prompt_env.shell（zsh/bash/...）',
  OS_VERSION: 'identity_profile.prompt_env.os_version（Darwin 24.3.0 等）',
  MODEL_MARKETING: '由 body.model 映射（Opus 4.7 / Sonnet 4.6 / ...）',
  MODEL_ID: 'body.model 逐字回填',
  CUTOFF: '由 body.model 映射知识截止月份',
}

// 扫描 system_blocks 文本，统计每个已知占位符出现次数并记录其默认值。
// 语法：`{{KEY}}` 或 `{{KEY|default}}`（带默认的是 runtime 替换失败时的兜底）。
// 未识别的 `{{XXX}}` 也单独列出，便于发现拼写错误或上游新增占位符。
function scanPlaceholders(systemText: string): {
  found: Record<PlaceholderKey, { count: number; defaults: string[] }>
  unknown: string[]
  missingDefaults: PlaceholderKey[]
} {
  const found = Object.fromEntries(
    KNOWN_PLACEHOLDERS.map(k => [k, { count: 0, defaults: [] as string[] }]),
  ) as Record<PlaceholderKey, { count: number; defaults: string[] }>
  const unknown = new Set<string>()
  for (const m of systemText.matchAll(/\{\{([A-Z_]+)(?:\|([^}]*))?\}\}/g)) {
    const key = m[1]
    const def = m[2]
    if ((KNOWN_PLACEHOLDERS as readonly string[]).includes(key)) {
      const entry = found[key as PlaceholderKey]
      entry.count++
      if (typeof def === 'string' && def.length > 0 && !entry.defaults.includes(def)) {
        entry.defaults.push(def)
      }
    } else {
      unknown.add(key)
    }
  }
  const missingDefaults = (KNOWN_PLACEHOLDERS as readonly PlaceholderKey[]).filter(
    k => found[k].count > 0 && found[k].defaults.length === 0,
  )
  return { found, unknown: Array.from(unknown), missingDefaults }
}

interface TemplateListItem {
  id: string
  name: string
  description: string | null
  source: TemplateSource
  source_ua: string | null
  is_default: boolean
  tools_count: number
  tool_names: string[]
  system_blocks_count: number
  used_by: number
  created_at: string
  updated_at: string
}

interface TemplateDetail {
  id: string
  name: string
  description: string | null
  source: TemplateSource
  source_ua: string | null
  is_default: boolean
  tools: any[]
  system_blocks: any[]
  created_at: string
  updated_at: string
  bound_accounts: { id: string; name: string; status: string }[]
}

type ToastState = { message: string; tone: 'ok' | 'err' } | null

function Toast({ toast, onClose }: { toast: ToastState; onClose: () => void }) {
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(onClose, 3500)
    return () => clearTimeout(t)
  }, [toast, onClose])
  if (!toast) return null
  const color = toast.tone === 'err' ? 'var(--err)' : 'var(--ok)'
  return (
    <div className="fixed top-6 right-6 z-[60]">
      <div
        className="flex items-center gap-3 bg-[var(--surface)] border px-4 py-2.5 rounded text-[12px]"
        style={{ borderColor: color, color }}
      >
        <span>{toast.message}</span>
        <button onClick={onClose} className="text-[var(--ink-3)] hover:text-[var(--ink)]">×</button>
      </div>
    </div>
  )
}

function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins}分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  return `${days}天前`
}

function sourceLabel(s: TemplateSource): { label: string; tone: 'ok' | 'info' | 'accent' } {
  switch (s) {
    case 'imported': return { label: '导入', tone: 'ok' }
    case 'manual':   return { label: '手动', tone: 'info' }
    case 'cloned':   return { label: '克隆', tone: 'accent' }
    default:         return { label: String(s), tone: 'info' }
  }
}

type SourceFilter = 'all' | TemplateSource

export default function AdminCCDisguisePage() {
  const [items, setItems] = useState<TemplateListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<ToastState>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<SourceFilter>('all')

  // editor modal state
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<TemplateDetail | null>(null)
  const [editMode, setEditMode] = useState<'create' | 'edit'>('create')
  const [formName, setFormName] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formSourceUa, setFormSourceUa] = useState('')
  const [formTools, setFormTools] = useState('')
  const [formSystem, setFormSystem] = useState('')
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  // delete confirm
  const [toDelete, setToDelete] = useState<TemplateListItem | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api<{ items: TemplateListItem[] }>('/admin/cc-disguise-templates')
      setItems(Array.isArray(data?.items) ? data.items : [])
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : '加载失败', tone: 'err' })
      setItems([])
    }
  }, [])

  useEffect(() => {
    load().finally(() => setLoading(false))
  }, [load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter(it => {
      if (filter !== 'all' && it.source !== filter) return false
      if (!q) return true
      if (it.name.toLowerCase().includes(q)) return true
      if ((it.description ?? '').toLowerCase().includes(q)) return true
      if ((it.source_ua ?? '').toLowerCase().includes(q)) return true
      if (it.tool_names.some(t => t.toLowerCase().includes(q))) return true
      return false
    })
  }, [items, search, filter])

  const counts = useMemo(() => {
    let imported = 0, manual = 0, cloned = 0
    for (const it of items) {
      if (it.source === 'imported') imported++
      else if (it.source === 'manual') manual++
      else if (it.source === 'cloned') cloned++
    }
    return { total: items.length, imported, manual, cloned }
  }, [items])

  const openCreate = () => {
    setEditMode('create')
    setEditing(null)
    setFormName('')
    setFormDescription('')
    setFormSourceUa('claude-cli/2.1.112 (external, cli)')
    setFormTools('[\n  {\n    "name": "Bash",\n    "description": "Execute bash commands",\n    "input_schema": {"type": "object", "properties": {}}\n  }\n]')
    setFormSystem('[]')
    setFormError('')
    setEditorOpen(true)
  }

  const openEdit = async (row: TemplateListItem) => {
    try {
      const detail = await api<TemplateDetail>(`/admin/cc-disguise-templates/${row.id}`)
      setEditMode('edit')
      setEditing(detail)
      setFormName(detail.name)
      setFormDescription(detail.description ?? '')
      setFormSourceUa(detail.source_ua ?? '')
      setFormTools(JSON.stringify(detail.tools ?? [], null, 2))
      setFormSystem(JSON.stringify(detail.system_blocks ?? [], null, 2))
      setFormError('')
      setEditorOpen(true)
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : '加载详情失败', tone: 'err' })
    }
  }

  const submitForm = async () => {
    const name = formName.trim()
    if (!name) { setFormError('请填写名称'); return }

    let tools: any, system: any
    try { tools = JSON.parse(formTools) } catch { setFormError('tools 不是合法 JSON'); return }
    try { system = formSystem.trim() ? JSON.parse(formSystem) : [] } catch { setFormError('system_blocks 不是合法 JSON'); return }

    const payload: any = {
      name,
      description: formDescription.trim() || null,
      source_ua: formSourceUa.trim() || null,
      tools,
      system_blocks: system,
    }

    setSaving(true)
    setFormError('')
    try {
      if (editMode === 'edit' && editing) {
        await api(`/admin/cc-disguise-templates/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        })
        setToast({ message: `已更新 ${name}`, tone: 'ok' })
      } else {
        await api('/admin/cc-disguise-templates', {
          method: 'POST',
          body: JSON.stringify(payload),
        })
        setToast({ message: `已创建 ${name}`, tone: 'ok' })
      }
      setEditorOpen(false)
      await load()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const submitClone = async (row: TemplateListItem) => {
    try {
      await api(`/admin/cc-disguise-templates/${row.id}/clone`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      setToast({ message: `已克隆 ${row.name}`, tone: 'ok' })
      await load()
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : '克隆失败', tone: 'err' })
    }
  }

  const submitDelete = async () => {
    if (!toDelete) return
    setDeleting(true)
    try {
      const result = await api<{ deleted: boolean; unbound_accounts: number }>(
        `/admin/cc-disguise-templates/${toDelete.id}`,
        { method: 'DELETE' },
      )
      const extra = result.unbound_accounts > 0 ? `，解绑 ${result.unbound_accounts} 个账号` : ''
      setToast({ message: `已删除 ${toDelete.name}${extra}`, tone: 'ok' })
      setToDelete(null)
      await load()
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : '删除失败', tone: 'err' })
    } finally {
      setDeleting(false)
    }
  }

  const columns: Column<TemplateListItem>[] = [
    {
      key: 'name',
      header: '名称',
      render: (r) => {
        const src = sourceLabel(r.source)
        return (
          <div className="flex flex-col gap-0.5">
            <span className="inline-flex items-center gap-2">
              <span className="text-[13px] text-[var(--ink)] font-medium">{r.name}</span>
              <Pill tone={src.tone}>{src.label}</Pill>
              {r.is_default && <Pill tone="accent">默认</Pill>}
            </span>
            {r.description && <span className="text-[11px] text-[var(--ink-3)]">{r.description}</span>}
          </div>
        )
      },
    },
    {
      key: 'source_ua',
      header: 'UA',
      render: (r) => r.source_ua
        ? <span className="font-mono text-[11px] text-[var(--ink-2)]">{r.source_ua}</span>
        : <span className="text-[var(--ink-3)]">—</span>,
    },
    {
      key: 'tools',
      header: '工具',
      render: (r) => {
        const preview = r.tool_names.slice(0, 3).join(', ')
        const more = r.tool_names.length > 3 ? ` +${r.tool_names.length - 3}` : ''
        return (
          <div className="flex flex-col gap-0.5">
            <span className="tabular-nums text-[var(--ink)]">{r.tools_count}</span>
            {preview && (
              <span className="font-mono text-[10px] text-[var(--ink-3)] truncate max-w-[220px]">
                {preview}{more}
              </span>
            )}
          </div>
        )
      },
    },
    {
      key: 'system',
      header: 'system',
      render: (r) => <span className="tabular-nums text-[var(--ink-2)]">{r.system_blocks_count}</span>,
    },
    {
      key: 'used_by',
      header: '绑定账号',
      render: (r) => <span className="tabular-nums text-[var(--ink-2)]">{r.used_by}</span>,
    },
    {
      key: 'updated',
      header: '更新',
      render: (r) => <span className="text-[var(--ink-2)]">{fmtRelative(r.updated_at)}</span>,
    },
    {
      key: 'actions',
      header: <span className="block text-right">操作</span>,
      render: (r) => (
        <div className="flex items-center gap-1.5 justify-end">
          <Button size="sm" variant="default" onClick={() => openEdit(r)}>编辑</Button>
          <Button size="sm" variant="default" onClick={() => submitClone(r)}>克隆</Button>
          <Button size="sm" variant="danger" onClick={() => setToDelete(r)}>删除</Button>
        </div>
      ),
      className: 'text-right',
    },
  ]

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <Toast toast={toast} onClose={() => setToast(null)} />

      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-serif">CC 伪装模板</h1>
          <p className="text-[13px] text-[var(--mute)] mt-1">
            账号的 CC 指纹基线（tools + system blocks）。模板仅能从真实 CC 2.1.112+ 的 HAR 导入，或在现有模板上克隆/手动编辑。未绑定模板的 OAuth 账号会被拒绝转发。
          </p>
          <p className="text-[12px] text-[var(--ink-3)] mt-1">
            导入时会把 <span className="font-mono">{`# Environment`}</span> 段里的 PII 替换为 <span className="font-mono">{`{{CWD}} {{PLATFORM}} {{SHELL}} {{OS_VERSION}} {{MODEL_MARKETING}} {{MODEL_ID}} {{CUTOFF}}`}</span> 占位符，请求时网关再从账号的 identity_profile 回填。CC 2.1.112 的原文（如 "Claude 4.X" / "Fast mode for..."）逐字保留。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => { setLoading(true); load().finally(() => setLoading(false)) }}>
            刷新
          </Button>
          <Button variant="primary" onClick={openCreate}>新建模板</Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {([
          { k: 'all', label: `全部 ${counts.total}` },
          { k: 'imported', label: `导入 ${counts.imported}` },
          { k: 'manual', label: `手动 ${counts.manual}` },
          { k: 'cloned', label: `克隆 ${counts.cloned}` },
        ] as { k: SourceFilter; label: string }[]).map(opt => (
          <button
            key={opt.k}
            onClick={() => setFilter(opt.k)}
            className={`px-2.5 py-1 rounded text-[11px] border transition-colors ${
              filter === opt.k
                ? 'border-[var(--accent)] bg-[var(--accent-weak)] text-[var(--accent)]'
                : 'border-[var(--rule)] text-[var(--ink-2)] hover:border-[var(--ink-3)]'
            }`}
          >
            {opt.label}
          </button>
        ))}
        <div className="ml-auto w-[240px]">
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索名称 / UA / 工具 / 账号"
          />
        </div>
      </div>

      {loading ? (
        <div className="text-[13px] text-[var(--mute)]">Loading…</div>
      ) : (
        <div className="border border-[var(--rule)] rounded overflow-hidden bg-[var(--surface)]">
          <Table<TemplateListItem>
            rows={filtered}
            columns={columns}
            emptyLabel={items.length === 0 ? '暂无模板 — 请从真实 CC 2.1.112 的 HAR 导入一个。' : '无匹配结果。'}
          />
        </div>
      )}

      <Modal
        open={editorOpen}
        title={editMode === 'edit' ? `编辑 ${editing?.name ?? ''}` : '新建 CC 伪装模板'}
        onClose={() => setEditorOpen(false)}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditorOpen(false)}>取消</Button>
            <Button variant="primary" onClick={submitForm} disabled={saving || !formName.trim()}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {formError && (
            <div className="border border-[var(--err)] rounded px-3 py-2 text-[12px] text-[var(--err)]">
              {formError}
            </div>
          )}
          <Field label="名称" hint="deployment 内唯一">
            <Input value={formName} onChange={e => { setFormName(e.target.value); setFormError('') }} />
          </Field>
          <Field label="描述">
            <Input value={formDescription} onChange={e => setFormDescription(e.target.value)} />
          </Field>
          <Field label="来源 UA" hint="claude-cli/2.1.112 ... — 用于显示，不影响校验">
            <Input value={formSourceUa} onChange={e => setFormSourceUa(e.target.value)} />
          </Field>
          <Field label="Tools (JSON 数组)" hint="至少包含 3 个 CC 核心工具 [Task, Agent, Bash, Edit, Read, Write, Glob, Grep]">
            <textarea
              value={formTools}
              onChange={e => setFormTools(e.target.value)}
              rows={12}
              className="border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--ink)] rounded focus:outline-none focus:border-[var(--ink)] focus:shadow-[0_0_0_3px_rgba(26,26,26,0.06)] resize-vertical w-full"
              spellCheck={false}
            />
          </Field>
          <Field label="System blocks (JSON 数组，可选)" hint="运行时会把 {{CWD}} / {{PLATFORM}} / {{SHELL}} / {{OS_VERSION}} / {{MODEL_MARKETING}} / {{MODEL_ID}} / {{CUTOFF}} 替换为绑定账号的 identity_profile 值。billing-header 会自动过滤。">
            <textarea
              value={formSystem}
              onChange={e => setFormSystem(e.target.value)}
              rows={6}
              className="border border-[var(--rule)] bg-[var(--surface)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--ink)] rounded focus:outline-none focus:border-[var(--ink)] focus:shadow-[0_0_0_3px_rgba(26,26,26,0.06)] resize-vertical w-full"
              spellCheck={false}
            />
          </Field>
          {(() => {
            const scan = scanPlaceholders(formSystem)
            const anyFound = Object.values(scan.found).some(f => f.count > 0)
            const missing = KNOWN_PLACEHOLDERS.filter(k => scan.found[k].count === 0)
            if (!anyFound && scan.unknown.length === 0) {
              return (
                <div className="text-[11px] text-[var(--warn)] border border-[var(--warn)] rounded px-2.5 py-2">
                  此模板未检测到任何占位符 —— 通常说明它是老版 `# Environment` 剥离版（会在请求中露出"没有 Environment 段"这个负指纹），或手动填写时漏了占位符。建议从最新 HAR 重新导入。
                </div>
              )
            }
            return (
              <div className="border border-[var(--rule)] rounded px-2.5 py-2 space-y-1.5">
                <div className="text-[11px] text-[var(--ink-3)]">已识别的占位符（runtime 由 identity_profile / body.model 填充，失败回退到下面的默认值）</div>
                <div className="flex flex-col gap-1">
                  {KNOWN_PLACEHOLDERS.map(k => {
                    const entry = scan.found[k]
                    const hasIt = entry.count > 0
                    return (
                      <div key={k} className="flex items-center gap-2">
                        <span
                          title={PLACEHOLDER_DESCRIPTIONS[k]}
                          className={`font-mono text-[10px] px-1.5 py-[2px] rounded border ${
                            hasIt
                              ? 'border-[var(--ok)] text-[var(--ok)] bg-[var(--ok-weak,rgba(0,128,0,0.08))]'
                              : 'border-[var(--rule)] text-[var(--ink-3)]'
                          }`}
                        >
                          {`{{${k}}}`}{hasIt && entry.count > 1 ? ` ×${entry.count}` : ''}
                        </span>
                        {hasIt && entry.defaults.length > 0 && (
                          <span className="font-mono text-[10px] text-[var(--ink-3)] truncate" title={entry.defaults.join(' / ')}>
                            默认 → {entry.defaults[0]}{entry.defaults.length > 1 ? ` (+${entry.defaults.length - 1})` : ''}
                          </span>
                        )}
                        {hasIt && entry.defaults.length === 0 && (
                          <span className="text-[10px] text-[var(--warn)]">无默认值 → runtime 失败时会丢弃该占位符</span>
                        )}
                      </div>
                    )
                  })}
                </div>
                {missing.length > 0 && (
                  <div className="text-[11px] text-[var(--warn)]">
                    模板缺少：{missing.map(k => `{{${k}}}`).join(' ')} —— 这些字段不会在请求中出现（CC 版本指纹缺口）。
                  </div>
                )}
                {scan.missingDefaults.length > 0 && (
                  <div className="text-[11px] text-[var(--warn)]">
                    无默认值占位符：{scan.missingDefaults.map(k => `{{${k}}}`).join(' ')} —— 建议改为 {'{'}{'{'}KEY|fallback{'}'}{'}'}  的形式。
                  </div>
                )}
                {scan.unknown.length > 0 && (
                  <div className="text-[11px] text-[var(--err)]">
                    未知占位符 {scan.unknown.map(k => `{{${k}}}`).join(' ')} —— 网关不会替换，会原样发出去。检查拼写或更新网关端列表。
                  </div>
                )}
              </div>
            )
          })()}
          {editMode === 'edit' && editing && editing.bound_accounts.length > 0 && (
            <Field label="已绑定账号" hint="编辑后下次 gateway reload 生效">
              <div className="flex flex-wrap gap-1.5">
                {editing.bound_accounts.map(a => (
                  <span
                    key={a.id}
                    className="font-mono text-[11px] px-2 py-[2px] rounded bg-[var(--mute-bg)] text-[var(--ink-2)] border border-[var(--rule)]"
                  >
                    {a.name}
                  </span>
                ))}
              </div>
            </Field>
          )}
        </div>
      </Modal>

      <Modal
        open={!!toDelete}
        title="删除模板"
        onClose={() => setToDelete(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setToDelete(null)}>取消</Button>
            <Button variant="danger" onClick={submitDelete} disabled={deleting}>
              {deleting ? '删除中…' : '确认删除'}
            </Button>
          </>
        }
      >
        <div className="text-[13px] text-[var(--ink-2)] space-y-2">
          <p>
            即将删除 <span className="font-mono text-[var(--ink)]">{toDelete?.name}</span>。
          </p>
          {toDelete && toDelete.used_by > 0 && (
            <p className="text-[12px] text-[var(--warn)]">
              当前有 {toDelete.used_by} 个账号绑定到此模板 — 删除后会解绑，这些账号在重新绑定模板前会 503。
            </p>
          )}
        </div>
      </Modal>

    </div>
  )
}
