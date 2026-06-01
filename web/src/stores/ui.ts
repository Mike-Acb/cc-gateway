import { create } from 'zustand'

type ViewAs = 'user' | 'admin'

type UiState = {
  viewAs: ViewAs
  sidebarOpen: boolean
  setViewAs: (v: ViewAs) => void
  setSidebarOpen: (o: boolean) => void
  toggleSidebar: () => void
}

export const useUiStore = create<UiState>((set) => ({
  viewAs: (localStorage.getItem('cc.viewAs') as ViewAs) || 'user',
  sidebarOpen: false,
  setViewAs: (v) => {
    localStorage.setItem('cc.viewAs', v)
    set({ viewAs: v })
  },
  setSidebarOpen: (o) => set({ sidebarOpen: o }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
}))
