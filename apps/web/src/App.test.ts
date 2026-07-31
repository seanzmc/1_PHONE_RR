import { describe, expect, it } from 'vitest'
import { bootstrapRecoveryVisible, repBackPage } from './App'

describe('repBackPage', () => {
  it('returns to the page that opened the rep detail', () => {
    expect(repBackPage('staff', true)).toBe('staff')
    expect(repBackPage('dashboard', true)).toBe('dashboard')
    expect(repBackPage('assign', true)).toBe('assign')
  })

  it('uses the role-safe landing page when no origin was captured', () => {
    expect(repBackPage(null, true)).toBe('assign')
    expect(repBackPage(null, false)).toBe('me')
  })
})

describe('bootstrapRecoveryVisible', () => {
  it('shows recovery only when session bootstrap failed without a known session', () => {
    expect(bootstrapRecoveryVisible(false, 'connection failed')).toBe(true)
    expect(bootstrapRecoveryVisible(false, null)).toBe(false)
    expect(bootstrapRecoveryVisible(true, 'connection failed')).toBe(false)
  })
})
