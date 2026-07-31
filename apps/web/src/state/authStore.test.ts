import { beforeEach, describe, expect, it, vi } from 'vitest'
import { query } from '../lib/api'
import { canMutateInCurrentView, isReadOnlyViewAs, useAuthStore } from './authStore'

vi.mock('../lib/api', () => ({
  configureViewAs: vi.fn(),
  mutate: vi.fn(),
  query: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(query).mockReset()
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
