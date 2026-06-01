import { useCallback, useEffect, useState } from 'react'
import { api } from '../../../api/client'
import { Button, Field, Input, Modal, Table, dialog } from '../../../ui'
import type { Column } from '../../../ui/Table'

interface ModelPricing {
  id: string
  model_pattern: string
  input_mtok: string
  output_mtok: string
  cache_read_mtok: string
  cache_write_mtok: string
  effective_from: string
  created_at: string
}

interface FormState {
  model_pattern: string
  input_mtok: string
  output_mtok: string
  cache_read_mtok: string
  cache_write_mtok: string
  effective_from: string
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

const EMPTY_FORM: FormState = {
  model_pattern: '',
  input_mtok: '0',
  output_mtok: '0',
  cache_read_mtok: '0',
  cache_write_mtok: '0',
  effective_from: today(),
}

export default function PricingTab() {
  const [rows, setRows] = useState<ModelPricing[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState<ModelPricing | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const data = await api<{ model_pricing: ModelPricing[] }>('/admin/invoices/model-pricing')
      setRows(data.model_pricing ?? [])
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
  function openEdit(r: ModelPricing) {
    setEditing(r)
    setIsNew(false)
    setForm({
      model_pattern: r.model_pattern,
      input_mtok: String(r.input_mtok),
      output_mtok: String(r.output_mtok),
      cache_read_mtok: String(r.cache_read_mtok),
      cache_write_mtok: String(r.cache_write_mtok),
      effective_from: r.effective_from?.slice(0, 10) ?? today(),
    })
  }
  function closeModal() {
    setEditing(null)
    setIsNew(false)
  }

  async function save() {
    setSaving(true)
    try {
      if (editing) {
        await api(`/admin/invoices/model-pricing/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            input_mtok: Number(form.input_mtok),
            output_mtok: Number(form.output_mtok),
            cache_read_mtok: Number(form.cache_read_mtok),
            cache_write_mtok: Number(form.cache_write_mtok),
            effective_from: form.effective_from,
          }),
        })
      } else {
        await api('/admin/invoices/model-pricing', {
          method: 'POST',
          body: JSON.stringify({
            model_pattern: form.model_pattern,
            input_mtok: Number(form.input_mtok),
            output_mtok: Number(form.output_mtok),
            cache_read_mtok: Number(form.cache_read_mtok),
            cache_write_mtok: Number(form.cache_write_mtok),
            effective_from: form.effective_from,
          }),
        })
      }
      closeModal()
      await load()
    } catch (e: any) {
      await dialog.alert(e?.message ?? '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const columns: Column<ModelPricing>[] = [
    { key: 'model_pattern', header: '模型', render: (r) => <span className="font-mono text-[var(--ink)]">{r.model_pattern}</span> },
    { key: 'input_mtok', header: 'Input / MTok', render: (r) => <span className="font-mono tabular-nums">{Number(r.input_mtok).toFixed(4)}</span> },
    { key: 'output_mtok', header: 'Output / MTok', render: (r) => <span className="font-mono tabular-nums">{Number(r.output_mtok).toFixed(4)}</span> },
    { key: 'cache_read_mtok', header: 'CacheR / MTok', render: (r) => <span className="font-mono tabular-nums">{Number(r.cache_read_mtok).toFixed(4)}</span> },
    { key: 'cache_write_mtok', header: 'CacheW / MTok', render: (r) => <span className="font-mono tabular-nums">{Number(r.cache_write_mtok).toFixed(4)}</span> },
    { key: 'effective_from', header: '生效日', render: (r) => <span className="font-mono">{r.effective_from?.slice(0, 10) ?? '-'}</span> },
    { key: 'actions', header: '', render: (r) => (
      <Button size="sm" variant="ghost" onClick={() => openEdit(r)}>编辑</Button>
    ) },
  ]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[12px] text-[var(--ink-3)]">共 {rows.length} 条定价记录</div>
        <Button variant="primary" size="sm" onClick={openNew}>新建定价</Button>
      </div>

      {err && <div className="border border-[var(--err)] text-[var(--err)] text-[12px] px-3 py-2 rounded">{err}</div>}

      <div className="border border-[var(--rule)] rounded overflow-hidden">
        {loading
          ? <div className="p-6 text-center text-[12px] text-[var(--ink-3)]">加载中…</div>
          : <Table<ModelPricing> rows={rows} columns={columns} emptyLabel="暂无定价。" />
        }
      </div>

      <Modal
        open={editing !== null || isNew}
        onClose={closeModal}
        title={editing ? `编辑 ${editing.model_pattern}` : '新建模型定价'}
        footer={
          <>
            <Button variant="ghost" onClick={closeModal}>取消</Button>
            <Button
              variant="primary"
              disabled={saving || !form.model_pattern}
              onClick={save}
            >{saving ? '保存中…' : '保存'}</Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="模型 Pattern">
            <Input
              value={form.model_pattern}
              disabled={!!editing}
              onChange={(e) => setForm({ ...form, model_pattern: e.target.value })}
              placeholder="claude-sonnet-4-6"
            />
          </Field>
          <Field label="生效日">
            <Input type="date" value={form.effective_from} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} />
          </Field>
          <Field label="Input / MTok">
            <Input type="number" step="0.0001" value={form.input_mtok} onChange={(e) => setForm({ ...form, input_mtok: e.target.value })} />
          </Field>
          <Field label="Output / MTok">
            <Input type="number" step="0.0001" value={form.output_mtok} onChange={(e) => setForm({ ...form, output_mtok: e.target.value })} />
          </Field>
          <Field label="Cache Read / MTok">
            <Input type="number" step="0.0001" value={form.cache_read_mtok} onChange={(e) => setForm({ ...form, cache_read_mtok: e.target.value })} />
          </Field>
          <Field label="Cache Write / MTok">
            <Input type="number" step="0.0001" value={form.cache_write_mtok} onChange={(e) => setForm({ ...form, cache_write_mtok: e.target.value })} />
          </Field>
        </div>
      </Modal>
    </div>
  )
}
