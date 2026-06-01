# User Settings Implementation Plan — `feat/user-settings`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/settings` 页：展示邮箱 / 用户名 / 注册时间；支持改用户名；语言切换；退出登录（从 AppShell footer 独立拎出来）；危险区域（清空 client / 请求日志的自助入口留占位）。

**Architecture:**
- 后端 `PATCH /api/me` 允许改 username；已有 `/api/auth/me` 返回 profile。
- 前端 `web/src/pages/settings/SettingsPage.tsx`（重写，已有）。

**Tech Stack:** React 19 + `@/ui` + Express。

---

## 约束

1. 改用户名：4-32 字符、允许中英数/下划线；查重；失败提示清楚。
2. "危险区域"本期只留 UI 框架，不接真实删除 —— 未来补。
3. 禁 emoji、禁渐变色、禁 PR。

---

## 文件结构

**Modify:**
- `server/src/routes/auth.ts` — 加 PATCH /me
- `web/src/pages/settings/SettingsPage.tsx`（重写）
- `web/src/router.tsx` — 挂真实页

---

## Task 1: 切分支 + PATCH /me

- [ ] **Step 1**:

```bash
cd /path/to/cc-gateway
git checkout main && git pull && git checkout -b feat/user-settings
```

- [ ] **Step 2**: 在 `server/src/routes/auth.ts` 增加

```typescript
router.patch('/me', requireUser, async (req, res) => {
  const user = (req as any).user
  const username = String(req.body?.username || '').trim()
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5]{4,32}$/.test(username)) {
    return res.status(400).json({ error: 'username must be 4-32 chars (letters/numbers/underscore/CJK)' })
  }
  const dup = await query('SELECT 1 FROM users WHERE username = $1 AND id <> $2', [username, user.id])
  if (dup.rows.length > 0) return res.status(409).json({ error: 'username taken' })
  const { rows } = await query(
    'UPDATE users SET username = $1 WHERE id = $2 RETURNING id, email, username, role, status',
    [username, user.id],
  )
  res.json(rows[0])
})
```

- [ ] **Step 3**: 手测

```bash
curl -s -X PATCH -H "content-type: application/json" \
  -H "cookie: access_token=$COOKIE" \
  -d '{"username":"newname123"}' \
  http://localhost:3001/api/auth/me
```

- [ ] **Step 4**: 提交

```bash
git add server/src/routes/auth.ts
git commit -m "feat(settings): PATCH /api/auth/me for username update"
```

---

## Task 2: 前端页

- [ ] **Step 1**: 重写

```tsx
// web/src/pages/settings/SettingsPage.tsx
import { useState } from 'react'
import { api } from '../../api/client'
import { useAuthStore } from '../../stores/auth'
import { useNavigate } from 'react-router-dom'
import { LanguageSwitcher } from '../../i18n'
import { Field, Input, Button } from '../../ui'

export default function SettingsPage() {
  const { user, fetchMe, logout } = useAuthStore()
  const navigate = useNavigate()
  const [username, setUsername] = useState(user?.username ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  async function onSave() {
    setError(''); setSaved(false); setSaving(true)
    try {
      await api('/auth/me', { method: 'PATCH', body: JSON.stringify({ username }) })
      await fetchMe()
      setSaved(true)
    } catch (e: any) {
      setError(e?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-[720px] space-y-8">
      <header>
        <h1 className="text-[26px] font-serif">设置</h1>
        <p className="text-[13px] text-[var(--mute)] mt-1">账户与偏好</p>
      </header>

      <section className="p-5 rounded-[6px] border border-[var(--line)] bg-[var(--surface)]">
        <h2 className="text-[14px] font-medium mb-3">账户信息</h2>
        <div className="space-y-4">
          <Field label="邮箱">
            <Input value={user?.email ?? ''} disabled />
          </Field>
          <Field label="用户名">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} />
          </Field>
          <Field label="角色">
            <Input value={user?.role ?? ''} disabled />
          </Field>
          {error && <div className="text-[12px] text-[var(--err)]">{error}</div>}
          {saved && <div className="text-[12px] text-[var(--ok)]">已保存</div>}
          <div>
            <Button variant="primary" disabled={saving || username === user?.username} onClick={onSave}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      </section>

      <section className="p-5 rounded-[6px] border border-[var(--line)] bg-[var(--surface)]">
        <h2 className="text-[14px] font-medium mb-3">偏好</h2>
        <Field label="语言"><LanguageSwitcher /></Field>
      </section>

      <section className="p-5 rounded-[6px] border border-[var(--err)] bg-[var(--surface)]">
        <h2 className="text-[14px] font-medium mb-3 text-[var(--err)]">危险区域</h2>
        <p className="text-[13px] text-[var(--mute)] mb-3">以下操作不可逆。尚未开放，如需处理请联系管理员。</p>
        <div className="flex gap-2">
          <Button variant="ghost" disabled>清空请求日志</Button>
          <Button variant="ghost" disabled>撤销所有 client</Button>
          <Button variant="ghost" disabled>注销账户</Button>
        </div>
      </section>

      <div>
        <Button variant="ghost" onClick={async () => { await logout(); navigate('/auth') }}>退出登录</Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2**: 挂路由

```tsx
import SettingsPage from './pages/settings/SettingsPage'
<Route path="/settings" element={<SettingsPage />} />
```

- [ ] **Step 3**: 提交

```bash
git add web/src/pages/settings/SettingsPage.tsx web/src/router.tsx
git commit -m "feat(settings): rewrite settings page with profile + danger zone"
```

---

## Task 3: 部署 + 合并

- [ ] `./scripts/deploy-gwbk.sh`
- [ ] 访问 `/settings`：验证改用户名 → 左下角 AppShell 的 username 实时更新
- [ ] merge

```bash
git fetch origin main && git rebase origin/main
git checkout main && git merge --no-ff feat/user-settings -m "merge: feat/user-settings"
git push origin main
```
