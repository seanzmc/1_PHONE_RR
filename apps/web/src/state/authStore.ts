import { create } from 'zustand'
import { hasPermission as roleHasPermission, type Permission, type Role } from '@phoneup/contracts'
import { mutate, query } from '../lib/api'

type Session = {
  userId: string
  role: Role
  email: string
  displayName: string | null
} | null

type AuthState = {
  session: Session
  loading: boolean
  /**
   * Admin "view as" — CLIENT-ONLY layout preview (design pass §G).
   * Real server permissions are unchanged, so this shows which controls a role sees,
   * NOT what data it can read: an admin viewing-as-REP still receives admin data on
   * any screen that isn't role-filtered server-side.
   */
  viewAsRole: Role | null
  /** The role the UI should render for — viewAsRole when set, otherwise the real one. */
  effectiveRole: () => Role | null
  hasPermission: (perm: Permission) => boolean
  setViewAsRole: (role: Role | null) => void
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  loading: true,
  viewAsRole: null,

  effectiveRole: () => {
    const { session, viewAsRole } = get()
    if (!session) return null
    return viewAsRole ?? session.role
  },

  hasPermission: (perm) => {
    const role = get().effectiveRole()
    return role ? roleHasPermission(role, perm) : false
  },

  // only a real ADMIN may view-as, and never while already viewing as someone else
  setViewAsRole: (role) => {
    const { session } = get()
    if (!session || session.role !== 'ADMIN') return
    set({ viewAsRole: role === session.role ? null : role })
  },

  login: async (email, password) => {
    await mutate('auth.login', { email, password })
    await get().refresh()
  },

  logout: async () => {
    await mutate('auth.logout')
    set({ session: null, viewAsRole: null })
  },

  refresh: async () => {
    set({ loading: true })
    try {
      const me = await query<Session>('auth.me')
      set({ session: me, viewAsRole: null })
    } finally {
      set({ loading: false })
    }
  },
}))
