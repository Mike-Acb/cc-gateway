import { create } from 'zustand'
import { api, setAccessToken } from '../api/client'

type User = {
  id: string
  username: string
  email: string
  role: string
  status: string
}

type AuthState = {
  user: User | null
  loading: boolean
  sendCode: (email: string) => Promise<{ isNewUser: boolean }>
  verifyCode: (email: string, code: string) => Promise<{ user?: User; needsUsername?: boolean; verifiedToken?: string }>
  completeRegister: (email: string, username: string, verifiedToken: string, inviteCode?: string) => Promise<void>
  logout: () => Promise<void>
  fetchMe: () => Promise<void>
  setUserFromToken: (accessToken: string) => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true,

  sendCode: async (email) => {
    const data = await api('/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ email }),
    })
    return { isNewUser: data.isNewUser }
  },

  verifyCode: async (email, code) => {
    const data = await api('/auth/verify-code', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    })
    if (data.accessToken) {
      setAccessToken(data.accessToken)
      set({ user: data.user })
      return { user: data.user }
    }
    return { needsUsername: data.needsUsername, verifiedToken: data.verifiedToken }
  },

  completeRegister: async (email, username, verifiedToken, inviteCode) => {
    const data = await api('/auth/complete-register', {
      method: 'POST',
      body: JSON.stringify({ email, username, verifiedToken, invite_code: inviteCode || undefined }),
    })
    setAccessToken(data.accessToken)
    set({ user: data.user })
  },

  logout: async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {})
    setAccessToken(null)
    set({ user: null })
  },

  fetchMe: async () => {
    try {
      const user = await api('/auth/me')
      set({ user, loading: false })
    } catch {
      set({ user: null, loading: false })
    }
  },

  setUserFromToken: async (accessToken) => {
    setAccessToken(accessToken)
    try {
      const user = await api('/auth/me')
      set({ user, loading: false })
    } catch {
      set({ user: null, loading: false })
    }
  },
}))
