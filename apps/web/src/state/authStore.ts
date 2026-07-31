import { create } from 'zustand'
import { hasPermission as roleHasPermission, type Permission, type Role } from '@phoneup/contracts'
import { configureViewAs, mutate, query } from '../lib/api'

export function isReadOnlyViewAs(viewAsUserId: string | null): boolean {
  return viewAsUserId !== null
}

export function canMutateInCurrentView(hasPermission: boolean, viewAsUserId: string | null): boolean {
  return hasPermission && !isReadOnlyViewAs(viewAsUserId)
}

type Session = {
  userId: string
  role: Role
  email: string
  displayName: string | null
  /** Holding an admin-issued temporary password: every screen is blocked until changed. */
  mustChangePassword: boolean
} | null

export type ViewAsProfile = {
  userId: string
  role: Role
  email: string
  displayName: string | null
}

type AuthState = {
  session: Session
  loading: boolean
  viewAsProfiles: ViewAsProfile[]
  viewAsUserId: string | null
  selectedViewAs: () => ViewAsProfile | null
  effectiveRole: () => Role | null
  hasPermission: (perm: Permission) => boolean
  loadViewAsProfiles: () => Promise<void>
  setViewAsUserId: (userId: string | null) => void
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  loading: true,
  viewAsProfiles: [],
  viewAsUserId: null,

  selectedViewAs: () => {
    const { viewAsProfiles, viewAsUserId } = get()
    return viewAsProfiles.find((profile) => profile.userId === viewAsUserId) ?? null
  },

  effectiveRole: () => {
    const { session } = get()
    if (!session) return null
    return get().selectedViewAs()?.role ?? session.role
  },

  hasPermission: (perm) => {
    const role = get().effectiveRole()
    return role ? roleHasPermission(role, perm) : false
  },

  loadViewAsProfiles: async () => {
    const { session } = get()
    if (session?.role !== 'ADMIN') {
      set({ viewAsProfiles: [] })
      return
    }
    const profiles = await query<ViewAsProfile[]>('auth.viewAsProfiles')
    set({ viewAsProfiles: profiles })
  },

  setViewAsUserId: (userId) => {
    const { session } = get()
    if (!session || session.role !== 'ADMIN') return
    const target = userId === session.userId ? null : userId
    if (target && !get().viewAsProfiles.some((profile) => profile.userId === target)) return
    configureViewAs(target)
    set({ viewAsUserId: target })
  },

  login: async (email, password) => {
    await mutate('auth.login', { email, password })
    await get().refresh()
  },

  logout: async () => {
    configureViewAs(null)
    await mutate('auth.logout')
    set({ session: null, viewAsProfiles: [], viewAsUserId: null })
  },

  refresh: async () => {
    configureViewAs(null)
    set({ loading: true })
    try {
      const me = await query<Session>('auth.me')
      set({ session: me, viewAsProfiles: [], viewAsUserId: null })
    } finally {
      set({ loading: false })
    }
  },

  changePassword: async (currentPassword, newPassword) => {
    await mutate('auth.changePassword', { currentPassword, newPassword })
    // re-read the session so mustChangePassword clears and the app unlocks
    await get().refresh()
  },
}))
