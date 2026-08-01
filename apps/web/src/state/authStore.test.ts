import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mutate, query } from '../lib/api'
import { canMutateInCurrentView, isReadOnlyViewAs, useAuthStore } from './authStore'

vi.mock('../lib/api', () => ({
  configureViewAs: vi.fn(),
  mutate: vi.fn(),
  query: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(query).mockReset()
  vi.mocked(mutate).mockReset()
  useAuthStore.setState({ session: null, loading: true, bootstrapError: null })
})

describe('View-as mutation guard', () => {
  it('makes every viewed profile read-only', () => {
    expect(isReadOnlyViewAs(null)).toBe(false)
    expect(isReadOnlyViewAs('viewed-user')).toBe(true)
  })

  it('requires both permission and a real non-view-as session for mutations', () => {
    expect(canMutateInCurrentView(true, null)).toBe(true)
    expect(canMutateInCurrentView(false, null)).toBe(false)
    expect(canMutateInCurrentView(true, 'viewed-user')).toBe(false)
  })
})

describe('auth bootstrap', () => {
  it('stores a recoverable error when the session check fails', async () => {
    vi.mocked(query).mockRejectedValueOnce(new Error('network unavailable'))

    await expect(useAuthStore.getState().refresh()).rejects.toThrow('network unavailable')

    expect(useAuthStore.getState().loading).toBe(false)
    expect(useAuthStore.getState().session).toBeNull()
    expect(useAuthStore.getState().bootstrapError).toBe('Couldn’t check your session — check your connection.')
  })

  it('clears the bootstrap error after a successful retry', async () => {
    useAuthStore.setState({ bootstrapError: 'old error' })
    vi.mocked(query).mockResolvedValueOnce(null)

    await useAuthStore.getState().refresh()

    expect(useAuthStore.getState().bootstrapError).toBeNull()
  })
})

describe('password recovery actions', () => {
  it('requests a reset without storing recovery state', async () => {
    vi.mocked(mutate).mockResolvedValueOnce({ ok: true })

    await useAuthStore.getState().requestPasswordReset('user@example.test')

    expect(mutate).toHaveBeenCalledWith('auth.requestPasswordReset', {
      email: 'user@example.test',
    })
  })

  it('completes a reset with the link token and chosen password', async () => {
    vi.mocked(mutate).mockResolvedValueOnce({ ok: true })

    await useAuthStore.getState().completePasswordReset('single-use-token', 'chosenPassword9')

    expect(mutate).toHaveBeenCalledWith('auth.completePasswordReset', {
      token: 'single-use-token',
      newPassword: 'chosenPassword9',
    })
  })

  it('omits the current password from forced first-login requests', async () => {
    vi.mocked(mutate).mockResolvedValueOnce({ ok: true })
    vi.mocked(query).mockResolvedValueOnce(null)

    await useAuthStore.getState().changePassword(undefined, 'chosenPassword9')

    expect(mutate).toHaveBeenCalledWith('auth.changePassword', {
      newPassword: 'chosenPassword9',
    })
  })

  it('keeps the password page mounted while refreshing the session after a change', async () => {
    let resolveSession!: (value: null) => void
    const sessionRefresh = new Promise<null>((resolve) => {
      resolveSession = resolve
    })
    useAuthStore.setState({ loading: false })
    vi.mocked(mutate).mockResolvedValueOnce({ ok: true })
    vi.mocked(query).mockReturnValueOnce(sessionRefresh)

    const change = useAuthStore.getState().changePassword('currentPassword9', 'chosenPassword9')
    await vi.waitFor(() => expect(query).toHaveBeenCalledWith('auth.me'))

    expect(useAuthStore.getState().loading).toBe(false)

    resolveSession(null)
    await change
  })
})
