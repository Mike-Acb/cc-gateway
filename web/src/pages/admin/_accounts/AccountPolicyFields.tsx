import { useState } from 'react'
import { Field, Input, Select } from '../../../ui/Field'

export interface PolicyValues {
  account_type: string
  weight: number
  max_rpm: number
  max_tpm: number
  max_concurrent: number
  max_sessions: number
  session_ttl_seconds: number
  cooldown_seconds: number
  max_retries: number
  max_daily_req: number
  max_daily_tok: number
  max_daily_cost: number
}

export const DEFAULT_POLICY: PolicyValues = {
  account_type: 'max',
  weight: 10,
  max_rpm: 60,
  max_tpm: 8000000,
  max_concurrent: 5,
  max_sessions: 5,
  session_ttl_seconds: 3600,
  cooldown_seconds: 60,
  max_retries: 2,
  max_daily_req: 0,
  max_daily_tok: 0,
  max_daily_cost: 0,
}

interface Props {
  value: PolicyValues
  onChange: (next: PolicyValues) => void
  compact?: boolean
  hideAccountType?: boolean
}

const ACCOUNT_TYPES = ['pro', 'max', 'team', 'enterprise']

function NumField({
  label, hint, value, onChange, min = 0, step = 1, placeholder,
}: {
  label: string
  hint?: string
  value: number
  onChange: (n: number) => void
  min?: number
  step?: number
  placeholder?: string
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        min={min}
        step={step}
        value={value === 0 ? '' : String(value)}
        placeholder={placeholder ?? (value === 0 ? '0 = 无限制' : undefined)}
        onChange={(e) => {
          const raw = e.target.value.trim()
          const n = raw === '' ? 0 : Number(raw)
          if (Number.isFinite(n)) onChange(n)
        }}
      />
    </Field>
  )
}

export default function AccountPolicyFields({ value, onChange, compact = false, hideAccountType = false }: Props) {
  const [showAdvanced, setShowAdvanced] = useState(false)
  const patch = (p: Partial<PolicyValues>) => onChange({ ...value, ...p })
  const gridCols = compact ? 'grid-cols-2' : 'grid-cols-2 md:grid-cols-3'

  return (
    <div className="flex flex-col gap-4">
      {/* Section: 类型 + 权重 */}
      <div className={`grid ${gridCols} gap-3`}>
        {!hideAccountType && (
          <Field label="账号类型">
            <Select
              value={value.account_type}
              onChange={(e) => patch({ account_type: e.target.value })}
            >
              {ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </Select>
          </Field>
        )}
        <NumField
          label="调度权重"
          hint="越大越优先"
          value={value.weight}
          onChange={(n) => patch({ weight: n })}
          min={0}
          placeholder="10"
        />
      </div>

      {/* Section: 速率 */}
      <div>
        <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)] pb-2">
          速率上限
        </div>
        <div className={`grid ${gridCols} gap-3`}>
          <NumField
            label="RPM"
            hint="每分钟请求"
            value={value.max_rpm}
            onChange={(n) => patch({ max_rpm: n })}
          />
          <NumField
            label="TPM"
            hint="每分钟 token"
            value={value.max_tpm}
            onChange={(n) => patch({ max_tpm: n })}
          />
          <NumField
            label="并发"
            hint="max_concurrent"
            value={value.max_concurrent}
            onChange={(n) => patch({ max_concurrent: n })}
          />
        </div>
      </div>

      {/* Section: 会话 */}
      <div>
        <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-3)] pb-2">
          会话策略
        </div>
        <div className={`grid ${gridCols} gap-3`}>
          <NumField
            label="最大会话"
            hint="0=不限"
            value={value.max_sessions}
            onChange={(n) => patch({ max_sessions: n })}
          />
          <NumField
            label="会话粘性(秒)"
            hint="session_ttl_seconds"
            value={value.session_ttl_seconds}
            onChange={(n) => patch({ session_ttl_seconds: n })}
          />
        </div>
      </div>

      {/* 高阶（折叠） */}
      <div>
        <button
          type="button"
          className="font-mono text-[11px] text-[var(--ink-2)] hover:text-[var(--ink)] transition-colors"
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced ? '▼' : '▶'} 高阶（冷却 / 重试 / 日配额）
        </button>
        {showAdvanced && (
          <div className="mt-3 pl-3 border-l-2 border-[var(--rule)] flex flex-col gap-3">
            <div className={`grid ${gridCols} gap-3`}>
              <NumField
                label="冷却(秒)"
                hint="错误冷却时长"
                value={value.cooldown_seconds}
                onChange={(n) => patch({ cooldown_seconds: n })}
              />
              <NumField
                label="重试次数"
                value={value.max_retries}
                onChange={(n) => patch({ max_retries: n })}
              />
            </div>
            <div className={`grid ${gridCols} gap-3`}>
              <NumField
                label="每日请求上限"
                hint="0=不限"
                value={value.max_daily_req}
                onChange={(n) => patch({ max_daily_req: n })}
              />
              <NumField
                label="每日 token 上限"
                hint="0=不限"
                value={value.max_daily_tok}
                onChange={(n) => patch({ max_daily_tok: n })}
              />
              <NumField
                label="每日花费上限 (USD)"
                hint="0=不限"
                value={value.max_daily_cost}
                onChange={(n) => patch({ max_daily_cost: n })}
                step={0.01}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
