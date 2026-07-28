import { create } from 'zustand'
import type { Role } from '@phoneup/contracts'
import { mutate, query } from '../lib/api'

type Session = { role: Role; email: string } | null

type AuthState = {
  session: Session
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  loading: true,

  login: async (email, password) => {
    const result = await mutate<{ role: Role; email: string }>('auth.login', { email, password })
    set({ session: result })
  },

  logout: async () => {
    await mutate('auth.logout')
    set({ session: null })
  },

  refresh: async () => {
    set({ loading: true })
    try {
      const me = await query<{ userId: string; role: Role } | null>('auth.me')
      set({ session: me ? { role: me.role, email: '' } : null })
    } finally {
      set({ loading: false })
    }
  },
}))
