import { describe, expect, it } from 'vitest'
import { canMutateInCurrentView, isReadOnlyViewAs } from './authStore'

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
