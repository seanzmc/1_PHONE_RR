import { describe, expect, it, vi } from 'vitest'
import { bootstrapRecoveryVisible, focusPageHeading, repBackPage } from './App'

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

describe('focusPageHeading', () => {
  it('makes the current page heading programmatically focusable and focuses it', () => {
    const heading = { tabIndex: 0, focus: vi.fn() }
    const main = { querySelector: vi.fn(() => heading) }

    focusPageHeading(main as unknown as HTMLElement)

    expect(main.querySelector).toHaveBeenCalledWith('h1, h2')
    expect(heading.tabIndex).toBe(-1)
    expect(heading.focus).toHaveBeenCalledOnce()
  })
})
