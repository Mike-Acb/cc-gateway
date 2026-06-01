import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { dialog } from '../../ui'

interface IdentityProfileEnv {
  platform: string
  platform_raw?: string
  arch: string
  node_version: string
  terminal: string
  version: string
  version_base?: string
  package_managers?: string[]
  runtimes?: string[]
  is_running_with_bun?: boolean
  is_claude_ai_auth?: boolean
  build_time?: string
  deployment_environment?: string
  vcs?: string
}

interface IdentityProfilePromptEnv {
  platform: string
  shell: string
  os_version: string
  home_prefix: string
}

interface IdentityProfileBody {
  env: IdentityProfileEnv
  prompt_env: IdentityProfilePromptEnv
}

interface IdentityProfile {
  id: string
  name: string
  is_default: boolean
  profile: IdentityProfileBody
  created_at: string
  updated_at: string
  account_count: number
}

const EMPTY_PROFILE: IdentityProfileBody = {
  env: {
    platform: 'darwin',
    platform_raw: 'darwin',
    arch: 'arm64',
    node_version: 'v22.1.0',
    terminal: 'iTerm.app',
    version: '2.1.888',
    version_base: '2.1.888',
    package_managers: ['npm', 'pnpm'],
    runtimes: ['node'],
    is_running_with_bun: false,
    is_claude_ai_auth: true,
    build_time: '2026-03-27T00:00:00.000Z',
    deployment_environment: 'production',
    vcs: 'git',
  },
  prompt_env: {
    platform: 'darwin',
    shell: 'zsh',
    os_version: 'Darwin 24.4.0',
    home_prefix: '/Users/dev/',
  },
}

const INPUT_CLS = 'w-full px-3 py-2 rounded-lg border border-[#d2d2d7] text-[14px] focus:outline-none focus:ring-2 focus:ring-[#007aff]/40'

export default function AdminIdentityProfilesPage() {
  const [profiles, setProfiles] = useState<IdentityProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const [profileJson, setProfileJson] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const data = await api<{ profiles: IdentityProfile[] }>('/admin/identity-profiles')
      setProfiles(data.profiles)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load profiles')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const openNew = () => {
    setEditId(null)
    setName('')
    setIsDefault(false)
    setProfileJson(JSON.stringify(EMPTY_PROFILE, null, 2))
    setError(null)
    setShowForm(true)
  }

  const openEdit = (p: IdentityProfile) => {
    setEditId(p.id)
    setName(p.name)
    setIsDefault(p.is_default)
    setProfileJson(JSON.stringify(p.profile, null, 2))
    setError(null)
    setShowForm(true)
  }

  const cloneFrom = (p: IdentityProfile) => {
    setEditId(null)
    setName(p.name + ' (copy)')
    setIsDefault(false)
    setProfileJson(JSON.stringify(p.profile, null, 2))
    setError(null)
    setShowForm(true)
  }

  const submit = async () => {
    setError(null)
    setSubmitting(true)
    try {
      const profile = JSON.parse(profileJson)
      const body = JSON.stringify({ name, profile, is_default: isDefault })
      if (editId) {
        await api(`/admin/identity-profiles/${editId}`, { method: 'PATCH', body })
      } else {
        await api('/admin/identity-profiles', { method: 'POST', body })
      }
      setShowForm(false)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSubmitting(false)
    }
  }

  const remove = async (p: IdentityProfile) => {
    if (!(await dialog.confirm(`Delete profile "${p.name}"?`, { danger: true }))) return
    try {
      await api(`/admin/identity-profiles/${p.id}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      await dialog.alert(e instanceof Error ? e.message : 'Failed to delete')
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-[22px] font-semibold text-[#1d1d1f]">身份模板</h1>
        <button
          onClick={openNew}
          className="px-4 py-2 bg-[#007aff] text-white text-[14px] font-medium rounded-xl hover:bg-[#0066d6] transition-colors"
        >
          + 新建模板
        </button>
      </div>

      {loading ? (
        <div className="text-[#86868b] text-[14px]">加载中…</div>
      ) : (
        <div className="bg-white rounded-2xl border border-[#e5e5ea] overflow-hidden">
          <table className="w-full text-[14px]">
            <thead className="bg-[#f5f5f7] text-[12px] text-[#6e6e73] uppercase">
              <tr>
                <th className="text-left px-4 py-3">名称</th>
                <th className="text-left px-4 py-3">系统</th>
                <th className="text-left px-4 py-3">Shell / Terminal</th>
                <th className="text-left px-4 py-3">Node</th>
                <th className="text-center px-4 py-3">使用账号</th>
                <th className="text-right px-4 py-3">操作</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map(p => (
                <tr key={p.id} className="border-t border-[#e5e5ea]">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-[#1d1d1f]">{p.name}</span>
                      {p.is_default && (
                        <span className="px-1.5 py-0.5 text-[10px] font-medium text-[#007aff] bg-[#007aff]/10 rounded">DEFAULT</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-[#1d1d1f]">{p.profile.env.platform} {p.profile.env.arch}</td>
                  <td className="px-4 py-3 text-[#1d1d1f]">{p.profile.prompt_env.shell} / {p.profile.env.terminal}</td>
                  <td className="px-4 py-3 text-[#1d1d1f]">{p.profile.env.node_version}</td>
                  <td className="px-4 py-3 text-center text-[#1d1d1f]">{p.account_count}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => openEdit(p)} className="text-[#007aff] hover:underline mr-3">编辑</button>
                    <button onClick={() => cloneFrom(p)} className="text-[#007aff] hover:underline mr-3">克隆</button>
                    <button onClick={() => remove(p)} className="text-[#ff3b30] hover:underline">删除</button>
                  </td>
                </tr>
              ))}
              {profiles.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-[#86868b]">暂无模板</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-[#e5e5ea] flex items-center justify-between">
              <h2 className="text-[18px] font-semibold text-[#1d1d1f]">{editId ? '编辑身份模板' : '新建身份模板'}</h2>
              <button onClick={() => setShowForm(false)} className="text-[#86868b] hover:text-[#1d1d1f]">×</button>
            </div>
            <div className="px-6 py-4 overflow-y-auto flex-1 space-y-4">
              <div>
                <label className="block text-[13px] font-medium text-[#1d1d1f] mb-1">名称</label>
                <input value={name} onChange={e => setName(e.target.value)} className={INPUT_CLS} placeholder="macOS arm64 iTerm" />
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" id="is-default" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} />
                <label htmlFor="is-default" className="text-[13px] text-[#1d1d1f]">设为默认模板</label>
              </div>
              <div>
                <label className="block text-[13px] font-medium text-[#1d1d1f] mb-1">Profile JSON (env + prompt_env)</label>
                <textarea
                  value={profileJson}
                  onChange={e => setProfileJson(e.target.value)}
                  className={INPUT_CLS + ' font-mono text-[12px]'}
                  rows={20}
                />
              </div>
              {error && <div className="text-[13px] text-[#ff3b30]">{error}</div>}
            </div>
            <div className="px-6 py-4 border-t border-[#e5e5ea] flex gap-3">
              <button onClick={() => setShowForm(false)} className="flex-1 py-2.5 text-[14px] font-medium text-[#1d1d1f] bg-[#f5f5f7] rounded-xl hover:bg-[#e8e8ed]">取消</button>
              <button onClick={submit} disabled={submitting || !name} className="flex-1 py-2.5 bg-[#007aff] text-white text-[14px] font-medium rounded-xl hover:bg-[#0066d6] disabled:opacity-40">{submitting ? '保存中…' : '保存'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
