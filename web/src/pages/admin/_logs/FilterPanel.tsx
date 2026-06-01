import { Button, Checkbox, Field, Input, Segmented, Select } from '../../../ui'

export type BlockSourceFilter = '' | 'gw' | 'up'
export type StreamingFilter = '' | 'true' | 'false'

export interface FilterValue {
  user_email: string
  oauth_account_name: string
  client_name: string
  model: string
  block_source: BlockSourceFilter
  block_reason: string
  streaming: StreamingFilter
  since: string
  until: string
}

export const EMPTY_FILTER: FilterValue = {
  user_email: '',
  oauth_account_name: '',
  client_name: '',
  model: '',
  block_source: '',
  block_reason: '',
  streaming: '',
  since: '',
  until: '',
}

const REASONS: { value: string; label: string }[] = [
  { value: 'rate_limited', label: '限流' },
  { value: 'plan_forbidden_model', label: '套餐禁用模型' },
  { value: 'quota_exceeded', label: '配额耗尽' },
  { value: 'auth_missing', label: '缺失鉴权' },
  { value: 'malformed_block', label: '格式错误' },
  { value: 'upstream_5xx', label: '上游 5xx' },
  { value: 'upstream_429', label: '上游 429' },
]

const SOURCE_OPTIONS: { value: BlockSourceFilter; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'gw', label: '网关拦截' },
  { value: 'up', label: '上游响应' },
]

const STREAM_OPTIONS: { value: StreamingFilter; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'true', label: '流式' },
  { value: 'false', label: '非流式' },
]

export interface FilterPanelProps {
  value: FilterValue
  onChange: (next: FilterValue) => void
  onReset: () => void
}

export default function FilterPanel({ value, onChange, onReset }: FilterPanelProps) {
  const reasons = value.block_reason.split(',').map((s) => s.trim()).filter(Boolean)
  const toggleReason = (r: string) => {
    const on = reasons.includes(r)
    const next = on ? reasons.filter((x) => x !== r) : [...reasons, r]
    onChange({ ...value, block_reason: next.join(',') })
  }
  return (
    <div className="space-y-4 text-[12px]">
      <h3 className="text-[10px] uppercase tracking-[0.14em] font-mono text-[var(--ink-3)]">过滤条件</h3>

      <Field label="用户邮箱">
        <Input
          value={value.user_email}
          placeholder="模糊匹配"
          onChange={(e) => onChange({ ...value, user_email: e.target.value })}
        />
      </Field>

      <Field label="OAuth 账号">
        <Input
          value={value.oauth_account_name}
          placeholder="账号名"
          onChange={(e) => onChange({ ...value, oauth_account_name: e.target.value })}
        />
      </Field>

      <Field label="客户端">
        <Input
          value={value.client_name}
          placeholder="客户端名"
          onChange={(e) => onChange({ ...value, client_name: e.target.value })}
        />
      </Field>

      <Field label="模型">
        <Select
          value={value.model}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
        >
          <option value="">全部</option>
          <option value="claude-opus-4-7">Opus 4.7</option>
          <option value="claude-sonnet-4-6">Sonnet 4.6</option>
          <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
        </Select>
      </Field>

      <Field label="来源">
        <Segmented<BlockSourceFilter>
          options={SOURCE_OPTIONS}
          value={value.block_source}
          onChange={(v) => onChange({ ...value, block_source: v })}
        />
      </Field>

      <Field label="流式">
        <Segmented<StreamingFilter>
          options={STREAM_OPTIONS}
          value={value.streaming}
          onChange={(v) => onChange({ ...value, streaming: v })}
        />
      </Field>

      <Field label="拦截原因">
        <div className="flex flex-col gap-1.5">
          {REASONS.map((r) => (
            <Checkbox
              key={r.value}
              label={r.label}
              checked={reasons.includes(r.value)}
              onChange={() => toggleReason(r.value)}
            />
          ))}
        </div>
      </Field>

      <Field label="起始时间">
        <Input
          type="datetime-local"
          value={value.since}
          onChange={(e) => onChange({ ...value, since: e.target.value })}
        />
      </Field>

      <Field label="结束时间">
        <Input
          type="datetime-local"
          value={value.until}
          onChange={(e) => onChange({ ...value, until: e.target.value })}
        />
      </Field>

      <div className="pt-2">
        <Button variant="ghost" onClick={onReset}>重置</Button>
      </div>
    </div>
  )
}
