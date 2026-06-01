import { useEffect, useState } from 'react'
import { api } from '../../../api/client'
import { Modal, Button } from '../../../ui'
import AccountPolicyFields, { DEFAULT_POLICY, type PolicyValues } from './AccountPolicyFields'
import AccountOptionsForm, { OAUTH_DEFAULT_OPTIONS, type AccountOptions } from './AccountOptionsForm'

interface AccountGroup {
  id: string
  name: string
  is_default?: boolean
}

interface Props {
  open: boolean
  accountIds: string[]
  onClose: () => void
  onSuccess: () => void
}

type ApplyToggle = {
  policy: boolean
  options: boolean
  groups: boolean
}

export default function BulkEditModal({ open, accountIds, onClose, onSuccess }: Props) {
  const [policy, setPolicy] = useState<PolicyValues>(DEFAULT_POLICY)
  const [options, setOptions] = useState<AccountOptions>(OAUTH_DEFAULT_OPTIONS)
  const [groups, setGroups] = useState<AccountGroup[]>([])
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set())
  const [apply, setApply] = useState<ApplyToggle>({
    policy: false,
    options: false,
    groups: false,
  })
  const [showPolicy, setShowPolicy] = useState(false)
  const [showOptions, setShowOptions] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ ok: number; failed: number } | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setResult(null)
    setApply({ policy: false, options: false, groups: false })
    api<any>('/admin/groups').catch(() => ({ items: [] })).then((g) => {
      const list = (g.items ?? g.groups ?? []) as AccountGroup[]
      setGroups(list)
    })
  }, [open])

  const submit = async () => {
    if (!apply.policy && !apply.options && !apply.groups) {
      setError('请至少勾选一组要修改的字段')
      return
    }
    setError(null)
    setLoading(true)
    try {
      const updates: any = {}
      if (apply.policy) {
        updates.weight = policy.weight
        updates.max_rpm = policy.max_rpm
        updates.max_tpm = policy.max_tpm
        updates.max_concurrent = policy.max_concurrent
        updates.max_sessions = policy.max_sessions
        updates.session_ttl_seconds = policy.session_ttl_seconds
        updates.cooldown_seconds = policy.cooldown_seconds
        updates.max_retries = policy.max_retries
        updates.max_daily_req = policy.max_daily_req
        updates.max_daily_tok = policy.max_daily_tok
        updates.max_daily_cost = policy.max_daily_cost
      }
      if (apply.options) {
        updates.options = options
      }
      if (apply.groups) {
        updates.group_ids = Array.from(selectedGroupIds)
      }

      const r = await api<{ ok: boolean; updated: number; failed: number }>(
        '/admin/oauth-accounts/bulk-update',
        {
          method: 'POST',
          body: JSON.stringify({ account_ids: accountIds, updates }),
        },
      )
      setResult({ ok: r.updated, failed: r.failed })
      if (r.updated > 0) onSuccess()
    } catch (e: any) {
      setError(e?.message ?? '批量修改失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      open={open}
      title={`批量修改 ${accountIds.length} 个账号`}
      onClose={onClose}
      size="lg"
      footer={
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose} disabled={loading}>关闭</Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={loading || (!apply.policy && !apply.options && !apply.groups)}
          >
            {loading ? `保存中…` : `应用到 ${accountIds.length} 个账号`}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 p-1">
        <p className="text-[12px] text-[var(--ink-3)]">
          勾选哪一组就改哪一组。不勾的字段保持各账号原值不变。
        </p>

        {/* 策略 */}
        <div className="border border-[var(--rule)] rounded">
          <label className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-[var(--mute-bg)]">
            <span className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={apply.policy}
                onChange={(e) => setApply(a => ({ ...a, policy: e.target.checked }))}
              />
              <span className="font-medium">应用策略</span>
              <span className="text-[10px] text-[var(--ink-3)] font-mono">
                (w{policy.weight} · RPM {policy.max_rpm} · TPM {policy.max_tpm} · 并发 {policy.max_concurrent})
              </span>
            </span>
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); setShowPolicy(v => !v) }}
              className="text-[11px] text-[var(--ink-3)] hover:text-[var(--ink)]"
            >
              {showPolicy ? '▼ 收起' : '▶ 展开编辑'}
            </button>
          </label>
          {showPolicy && (
            <div className="border-t border-[var(--rule)] p-3">
              <AccountPolicyFields value={policy} onChange={setPolicy} compact hideAccountType />
            </div>
          )}
        </div>

        {/* 选项 */}
        <div className="border border-[var(--rule)] rounded">
          <label className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-[var(--mute-bg)]">
            <span className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={apply.options}
                onChange={(e) => setApply(a => ({ ...a, options: e.target.checked }))}
              />
              <span className="font-medium">应用选项 (校验 / 清洗 / 覆盖 / 事件)</span>
            </span>
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); setShowOptions(v => !v) }}
              className="text-[11px] text-[var(--ink-3)] hover:text-[var(--ink)]"
            >
              {showOptions ? '▼ 收起' : '▶ 展开编辑'}
            </button>
          </label>
          {showOptions && (
            <div className="border-t border-[var(--rule)] p-3">
              <AccountOptionsForm authKind="oauth" value={options} onChange={setOptions} />
            </div>
          )}
        </div>

        {/* 分组 */}
        <div className="border border-[var(--rule)] rounded">
          <label className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-[var(--mute-bg)]">
            <span className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={apply.groups}
                onChange={(e) => setApply(a => ({ ...a, groups: e.target.checked }))}
              />
              <span className="font-medium">应用分组绑定</span>
              <span className="text-[10px] text-[var(--ink-3)] font-mono">
                ({selectedGroupIds.size} 个组,空 = 移到共享池)
              </span>
            </span>
          </label>
          {apply.groups && (
            <div className="border-t border-[var(--rule)] p-3">
              {groups.length === 0 ? (
                <div className="text-[12px] text-[var(--ink-3)] py-2">没有分组。</div>
              ) : (
                <div className="grid grid-cols-2 gap-1">
                  {groups.map(g => (
                    <label key={g.id} className="flex items-center gap-1.5 text-[12px] cursor-pointer hover:bg-[var(--mute-bg)] px-1 py-0.5 rounded">
                      <input
                        type="checkbox"
                        checked={selectedGroupIds.has(g.id)}
                        onChange={() => {
                          setSelectedGroupIds(prev => {
                            const next = new Set(prev)
                            if (next.has(g.id)) next.delete(g.id)
                            else next.add(g.id)
                            return next
                          })
                        }}
                      />
                      <span className="truncate">{g.name}{g.is_default ? ' [默认]' : ''}</span>
                    </label>
                  ))}
                </div>
              )}
              <div className="text-[10px] text-[var(--ink-3)] mt-2">
                不勾任何组 = 移到共享池 (group_id=NULL)
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="border border-[var(--err)] text-[var(--err)] p-2 text-xs rounded">{error}</div>
        )}

        {result && (
          <div className="border border-[var(--rule)] rounded p-3 text-[12px]">
            <span className="text-[var(--ok)] font-medium">已更新 {result.ok} 个</span>
            {result.failed > 0 && <span className="text-[var(--err)] ml-3">失败 {result.failed} 个</span>}
          </div>
        )}
      </div>
    </Modal>
  )
}
