import { StrictMode, act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  AssignmentDrawerMount,
  AssignmentTriggerFocusRestorer,
  bootstrapRecoveryVisible,
  canOpenAssignmentDrawer,
  focusPageHeading,
  landingPage,
  repBackPage,
} from './App'
import { resetTokenFromLocation } from './lib/publicAuth'
import { createLifecycleContainer } from './test/reactLifecycle'

describe('app navigation', () => {
  it('lands non-Reps on Team Dashboard and Reps on My Dashboard', () => {
    expect(landingPage('ADMIN')).toBe('dashboard')
    expect(landingPage('MANAGER')).toBe('dashboard')
    expect(landingPage('BDC')).toBe('dashboard')
    expect(landingPage('REP')).toBe('me')
  })

  it('does not expose assignment actions during View-as', () => {
    expect(canOpenAssignmentDrawer(true, null)).toBe(true)
    expect(canOpenAssignmentDrawer(true, 'viewed-user')).toBe(false)
    expect(canOpenAssignmentDrawer(false, null)).toBe(false)
  })

  it('mounts a fresh assignment drawer only while it is open', () => {
    const props = {
      onClose: () => {},
      onOpenRep: () => {},
    }

    expect(renderToStaticMarkup(createElement(AssignmentDrawerMount, { ...props, open: false }))).toBe('')
    expect(renderToStaticMarkup(createElement(AssignmentDrawerMount, { ...props, open: true }))).toContain('Assign Lead')
  })

  it('restores the Assign Lead trigger once after a real close under Strict Mode', async () => {
    let shellInert = true
    const trigger = {
      focus: vi.fn(),
      closest: vi.fn(() => (shellInert ? {} : null)),
    }
    const triggerRef = { current: trigger as unknown as HTMLElement | null }
    const lifecycle = createLifecycleContainer(null)
    const root = createRoot(lifecycle.container)

    try {
      await act(async () => {
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(AssignmentTriggerFocusRestorer, { open: true, triggerRef }),
          ),
        )
      })
      expect(trigger.focus).not.toHaveBeenCalled()

      await act(async () => {
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(AssignmentTriggerFocusRestorer, { open: false, triggerRef }),
          ),
        )
      })
      expect(trigger.closest).toHaveBeenCalledWith('[inert]')
      expect(trigger.focus).not.toHaveBeenCalled()

      await act(async () => {
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(AssignmentTriggerFocusRestorer, { open: true, triggerRef }),
          ),
        )
      })
      shellInert = false
      await act(async () => {
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(AssignmentTriggerFocusRestorer, { open: false, triggerRef }),
          ),
        )
      })
      expect(trigger.focus).toHaveBeenCalledOnce()

      await act(async () => root.unmount())
      expect(trigger.focus).toHaveBeenCalledOnce()
    } finally {
      lifecycle.cleanup()
    }
  })

  it('uses role-safe rep-detail fallback', () => {
    expect(repBackPage('staff', 'BDC')).toBe('staff')
    expect(repBackPage('dashboard', 'MANAGER')).toBe('dashboard')
    expect(repBackPage(null, 'BDC')).toBe('dashboard')
    expect(repBackPage(null, 'REP')).toBe('me')
  })
})

describe('bootstrapRecoveryVisible', () => {
  it('shows recovery only when session bootstrap failed without a known session', () => {
    expect(bootstrapRecoveryVisible(false, 'connection failed')).toBe(true)
    expect(bootstrapRecoveryVisible(false, null)).toBe(false)
    expect(bootstrapRecoveryVisible(true, 'connection failed')).toBe(false)
  })
})

describe('resetTokenFromLocation', () => {
  it('selects only a non-empty reset token from the root query string', () => {
    expect(resetTokenFromLocation('?reset_token=single-use-token')).toBe('single-use-token')
    expect(resetTokenFromLocation('?reset_token=')).toBeNull()
    expect(resetTokenFromLocation('?other=value')).toBeNull()
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
