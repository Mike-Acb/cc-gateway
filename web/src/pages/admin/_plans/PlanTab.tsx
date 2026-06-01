import { useCallback, useEffect, useState } from 'react'
import { api } from '../../../api/client'
import {
  Button,
  Checkbox,
  Chip,
  Field,
  Input,
  Modal,
  Pill,
  Select,
  Table,
  dialog,
} from '../../../ui'
import type { Column } from '../../../ui/Table'

export interface Plan {
  id: string
  name: string
  type: 'quota' | 'pool'
  subtype: string | null
  price: string
  currency: string
  quota_amount: string | null
  duration_days: number | null
  max_concurrent: number
  sort_order: number
  enabled: boolean
  recommended: boolean
  description: string | null
  features: string[] | null
  limit_5h_usd: string | number | null
  limit_1d_usd: string | number | null
  limit_7d_usd: string | number | null
  limit_30d_usd: string | number | null
}

interface FormState {
  name: string
  type: 'quota' | 'pool'
  subtype: string
  price: string
  currency: string
  quota_amount: string
  duration_days: number
  max_concurrent: number
  sort_order: number
  description: string
  features: string
  enabled: boolean
  recommended: boolean
  limit_5h_usd: string
  limit_1d_usd: string
  limit_7d_usd: string
  limit_30d_usd: string
}

const EMPTY_FORM: FormState = {
  name: '',
  type: 'quota',
  subtype: 'monthly',
  price: '0',
  currency: 'CNY',
  quota_amount: '0',
  duration_days: 30,
  max_concurrent: 1,
  sort_order: 0,
  description: '',
  features: '',
  enabled: true,
  recommended: false,
  limit_5h_usd: '',
  limit_1d_usd: '',
  limit_7d_usd: '',
  limit_30d_usd: '',
}

// 空输入或 0 输入都按 null 发送（后端也会归一，前端预先处理为显式 null）。
function toLimitPayload(v: string): number | null {
  const s = v.trim()
  if (s === '') return null
  const n = Number(s)
  if (!Number.isFinite(n) || n === 0) return null
  return n
}

// 显示 cap：NULL/undefined/0 → "不限"，否则美元格式。
function fmtCap(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '不限'
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n === 0) return '不限'
  // 2~6 位小数按需显示，去掉尾随 0。
  const abs = Math.abs(n)
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6
  return `$${n.toFixed(digits).replace(/\.?0+$/, '')}`
}

function toFormLimit(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return ''
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n === 0) return ''
  // 去掉尾随 0，最多保留 6 位小数
  return String(Number(n.toFixed(6)))
}

export default function PlanTab() {
  const [rows, setRows] = useState<Plan[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState<Plan | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const data = await api<Plan[]>('/admin/plans')
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setErr(e?.message ?? '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  function openNew() {
    setEditing(null)
    setIsNew(true)
    setForm(EMPTY_FORM)
  }

  function openEdit(p: Plan) {
    setEditing(p)
    setIsNew(false)
    setForm({
      name: p.name,
      type: p.type,
      subtype: p.subtype ?? 'monthly',
      price: p.price,
      currency: p.currency ?? 'CNY',
      quota_amount: p.quota_amount ?? '0',
      duration_days: p.duration_days ?? 30,
      max_concurrent: p.max_concurrent ?? 1,
      sort_order: p.sort_order ?? 0,
      description: p.description ?? '',
      features: Array.isArray(p.features) ? p.features.join(', ') : '',
      enabled: p.enabled,
      recommended: !!p.recommended,
      limit_5h_usd: toFormLimit(p.limit_5h_usd),
      limit_1d_usd: toFormLimit(p.limit_1d_usd),
      limit_7d_usd: toFormLimit(p.limit_7d_usd),
      limit_30d_usd: toFormLimit(p.limit_30d_usd),
    })
  }

  function closeModal() {
    setEditing(null)
    setIsNew(false)
  }

  async function save() {
    // 推荐唯一性：同类型下若已有其他套餐是推荐，弹框让用户决定替换 or 放弃本次推荐
    let recommended = !!form.recommended
    let demoteId: string | null = null
    if (recommended) {
      const existing = rows.find(
        (r) => r.type === form.type && r.recommended && r.id !== editing?.id,
      )
      if (existing) {
        const typeLabel = form.type === 'pool' ? '订阅' : '按量'
        const ok = await dialog.confirm(
          `${typeLabel} 类型下「${existing.name}」当前已设为推荐。\n\n` +
            `确定：取消「${existing.name}」的推荐，将本套餐设为推荐\n` +
            `取消：保持原推荐不变，本次保存不勾选推荐`,
          { title: '替换推荐套餐' },
        )
        if (ok) {
          demoteId = existing.id
        } else {
          recommended = false
        }
      }
    }

    setSaving(true)
    try {
      if (demoteId) {
        await api(`/admin/plans/${demoteId}`, {
          method: 'PATCH',
          body: JSON.stringify({ recommended: false }),
        })
      }
      const body: Record<string, unknown> = {
        name: form.name,
        type: form.type,
        subtype: form.type === 'pool' ? form.subtype : null,
        price: Number(form.price),
        currency: form.currency,
        quota_amount: form.type === 'quota' ? Number(form.quota_amount) : null,
        duration_days: form.type === 'pool' ? Number(form.duration_days) || null : null,
        max_concurrent: Number(form.max_concurrent) || 1,
        sort_order: Number(form.sort_order) || 0,
        description: form.description || null,
        features: form.features
          ? form.features.split(',').map((s) => s.trim()).filter(Boolean)
          : null,
        enabled: form.enabled,
        recommended,
        // pool 额度上限：非 pool 一律发 null 以清空之前可能存在的值；
        // pool 时空/0 也按 null 发送（= 不限）。
        limit_5h_usd:  form.type === 'pool' ? toLimitPayload(form.limit_5h_usd)  : null,
        limit_1d_usd:  form.type === 'pool' ? toLimitPayload(form.limit_1d_usd)  : null,
        limit_7d_usd:  form.type === 'pool' ? toLimitPayload(form.limit_7d_usd)  : null,
        limit_30d_usd: form.type === 'pool' ? toLimitPayload(form.limit_30d_usd) : null,
      }
      if (editing) {
        await api(`/admin/plans/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      } else {
        await api('/admin/plans', { method: 'POST', body: JSON.stringify(body) })
      }
      closeModal()
      await load()
    } catch (e: any) {
      await dialog.alert(e?.message ?? '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function remove(p: Plan) {
    if (!(await dialog.confirm(`删除套餐 ${p.name}？若存在活跃订阅将被拒绝。`, { danger: true }))) return
    try {
      await api(`/admin/plans/${p.id}`, { method: 'DELETE' })
      await load()
    } catch (e: any) {
      await dialog.alert(e?.message ?? '删除失败')
    }
  }

  async function toggleEnabled(p: Plan) {
    try {
      await api(`/admin/plans/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !p.enabled }),
      })
      await load()
    } catch (e: any) {
      await dialog.alert(e?.message ?? '切换失败')
    }
  }

  const columns: Column<Plan>[] = [
    { key: 'name', header: '名称', render: (r) => <span className="text-[var(--ink)] font-medium">{r.name}</span> },
    { key: 'type', header: '类型', render: (r) => (
      <Pill tone={r.type === 'quota' ? 'info' : 'warn'}>{r.type === 'quota' ? '按量' : '订阅'}</Pill>
    ) },
    { key: 'price', header: '价格', render: (r) => (
      <span className="font-mono tabular-nums">{Number(r.price).toFixed(2)} {r.currency}</span>
    ) },
    { key: 'quota', header: '额度/周期', render: (r) => (
      r.type === 'quota'
        ? <span className="font-mono">${Number(r.quota_amount ?? 0).toFixed(2)}</span>
        : <span className="font-mono">{r.duration_days ?? '-'} 天</span>
    ) },
    { key: 'caps', header: '额度上限', render: (r) => (
      r.type === 'pool'
        ? (
          <span className="font-mono text-[11px] text-[var(--ink-2)] tabular-nums">
            5h: {fmtCap(r.limit_5h_usd)} · 1d: {fmtCap(r.limit_1d_usd)} · 7d: {fmtCap(r.limit_7d_usd)} · 30d: {fmtCap(r.limit_30d_usd)}
          </span>
        )
        : <span className="text-[var(--ink-3)]">—</span>
    ) },
    { key: 'features', header: '特性', render: (r) => (
      <div className="flex flex-wrap gap-1">
        {(r.features ?? []).slice(0, 3).map((f, i) => <Chip key={i}>{f}</Chip>)}
        {(r.features?.length ?? 0) > 3 && <Chip>+{(r.features?.length ?? 0) - 3}</Chip>}
      </div>
    ) },
    { key: 'enabled', header: '状态', render: (r) => (
      <div className="flex items-center gap-1">
        <Pill tone={r.enabled ? 'ok' : 'mute'}>{r.enabled ? '启用' : '停用'}</Pill>
        {r.recommended && <Pill tone="warn">推荐</Pill>}
      </div>
    ) },
    { key: 'actions', header: '', render: (r) => (
      <div className="flex gap-1">
        <Button size="sm" variant="ghost" onClick={() => openEdit(r)}>编辑</Button>
        <Button size="sm" variant="ghost" onClick={() => toggleEnabled(r)}>{r.enabled ? '停用' : '启用'}</Button>
        <Button size="sm" variant="ghost" onClick={() => remove(r)}>删除</Button>
      </div>
    ) },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[12px] text-[var(--ink-3)]">共 {rows.length} 个套餐</div>
        <Button variant="primary" size="sm" onClick={openNew}>新建套餐</Button>
      </div>

      {err && <div className="border border-[var(--err)] text-[var(--err)] text-[12px] px-3 py-2 rounded">{err}</div>}

      <div className="border border-[var(--rule)] rounded overflow-hidden">
        {loading
          ? <div className="p-6 text-center text-[12px] text-[var(--ink-3)]">加载中…</div>
          : <Table<Plan> rows={rows} columns={columns} emptyLabel="暂无套餐。" />
        }
      </div>

      <Modal
        open={editing !== null || isNew}
        onClose={closeModal}
        title={editing ? `编辑 ${editing.name}` : '新建套餐'}
        footer={
          <>
            <Button variant="ghost" onClick={closeModal}>取消</Button>
            <Button variant="primary" disabled={saving || !form.name} onClick={save}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="名称">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="类型">
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as 'quota' | 'pool' })}>
              <option value="quota">按量 (quota)</option>
              <option value="pool">订阅 (pool)</option>
            </Select>
          </Field>
          {form.type === 'pool' && (
            <Field label="子类型">
              <Select value={form.subtype} onChange={(e) => setForm({ ...form, subtype: e.target.value })}>
                <option value="monthly">月卡</option>
                <option value="daily">日卡</option>
                <option value="per_use">次卡</option>
              </Select>
            </Field>
          )}
          <Field label="价格">
            <Input type="number" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
          </Field>
          <Field label="币种">
            <Select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
              <option value="CNY">CNY</option>
              <option value="USD">USD</option>
            </Select>
          </Field>
          {form.type === 'quota' && (
            <Field label="充值额度 ($)">
              <Input type="number" step="0.01" value={form.quota_amount} onChange={(e) => setForm({ ...form, quota_amount: e.target.value })} />
            </Field>
          )}
          {form.type === 'pool' && (
            <Field label="有效天数">
              <Input type="number" value={form.duration_days} onChange={(e) => setForm({ ...form, duration_days: Number(e.target.value) })} />
            </Field>
          )}
          <Field label="最大并发 / 客户端">
            <Input type="number" value={form.max_concurrent} onChange={(e) => setForm({ ...form, max_concurrent: Number(e.target.value) })} />
          </Field>
          <Field label="排序">
            <Input type="number" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })} />
          </Field>
        </div>

        {form.type === 'pool' && (
          <div className="mt-4 border-t border-[var(--rule)] pt-3 space-y-2">
            <div className="text-[11px] text-[var(--ink-3)] font-mono uppercase tracking-[0.14em]">
              额度上限 (USD)
            </div>
            <div className="text-[10px] text-[var(--ink-3)]">
              窗口内累计 USD 达到上限即阻断；留空或填 0 表示不限。
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="5 小时额度 (USD)">
                <Input
                  type="number"
                  step="0.000001"
                  min="0"
                  placeholder="不限"
                  value={form.limit_5h_usd}
                  onChange={(e) => setForm({ ...form, limit_5h_usd: e.target.value })}
                />
              </Field>
              <Field label="1 天额度 (USD)">
                <Input
                  type="number"
                  step="0.000001"
                  min="0"
                  placeholder="不限"
                  value={form.limit_1d_usd}
                  onChange={(e) => setForm({ ...form, limit_1d_usd: e.target.value })}
                />
              </Field>
              <Field label="7 天额度 (USD)">
                <Input
                  type="number"
                  step="0.000001"
                  min="0"
                  placeholder="不限"
                  value={form.limit_7d_usd}
                  onChange={(e) => setForm({ ...form, limit_7d_usd: e.target.value })}
                />
              </Field>
              <Field label="30 天额度 (USD)">
                <Input
                  type="number"
                  step="0.000001"
                  min="0"
                  placeholder="不限"
                  value={form.limit_30d_usd}
                  onChange={(e) => setForm({ ...form, limit_30d_usd: e.target.value })}
                />
              </Field>
            </div>
          </div>
        )}

        <div className="mt-4 space-y-3">
          <Field label="描述">
            <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="适合个人轻度使用" />
          </Field>
          <Field label="特性标签（逗号分隔）">
            <Input value={form.features} onChange={(e) => setForm({ ...form, features: e.target.value })} placeholder="不限速, 优先支持" />
          </Field>
          <div className="flex items-center gap-4">
            <Checkbox
              label="启用"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            <Checkbox
              label="推荐（/plans 页面展示 推荐 标签）"
              checked={form.recommended}
              onChange={(e) => setForm({ ...form, recommended: e.target.checked })}
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}
