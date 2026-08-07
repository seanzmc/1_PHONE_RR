import { StrictMode, act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  AssignmentDrawerMount,
  AssignmentTriggerFocusRestorer,
  RoleNavigation,
  activityImportStaffNavigation,
  bootstrapRecoveryVisible,
  canOpenAssignmentDrawer,
  dashboardRepDrillDown,
  focusPageHeading,
  landingPage,
  navigationForRole,
  repBackPage,
} from './App'
import { resetTokenFromLocation } from './lib/publicAuth'
import { createLifecycleContainer } from './test/reactLifecycle'

function renderNavigationForRole(role: 'ADMIN' | 'MANAGER' | 'BDC' | 'REP'): string {
  return renderToStaticMarkup(
    createElement(RoleNavigation, {
      role,
      activePage: 'dashboard',
      onNavigate: () => {},
    }),
  )
}

describe('app navigation', () => {
  it('lands every role on Team Dashboard', () => {
    expect(landingPage('ADMIN')).toBe('dashboard')
    expect(landingPage('MANAGER')).toBe('dashboard')
    expect(landingPage('BDC')).toBe('dashboard')
    expect(landingPage('REP')).toBe('dashboard')
  })

  it('orders role destinations around the daily workflow', () => {
    expect(navigationForRole('REP')).toEqual({
      canAssign: false,
      primary: [
        { page: 'dashboard', label: 'Team Dashboard' },
        { page: 'me', label: 'My Dashboard' },
      ],
      management: [],
    })
    expect(navigationForRole('BDC')).toEqual({
      canAssign: true,
      primary: [{ page: 'dashboard', label: 'Team Dashboard' }],
      management: [],
    })
    expect(navigationForRole('MANAGER')).toEqual({
      canAssign: true,
      primary: [
        { page: 'dashboard', label: 'Team Dashboard' },
        { page: 'staff', label: 'Staff List' },
        { page: 'import', label: 'Import Activity' },
      ],
      management: [
        { page: 'users', label: 'User Management' },
        { page: 'audit', label: 'Audit Log' },
      ],
    })
    expect(navigationForRole('ADMIN')).toEqual(navigationForRole('MANAGER'))
  })

  it('renders Team Dashboard for every role and keeps administrative pages in Management', () => {
    const rep = renderNavigationForRole('REP')
    expect(rep).toContain('Team Dashboard')
    expect(rep).toContain('My Dashboard')
    expect(rep).not.toContain('Management')

    const bdc = renderNavigationForRole('BDC')
    expect(bdc).toContain('Team Dashboard')
    expect(bdc).not.toContain('My Dashboard')
    expect(bdc).not.toContain('Management')

    const manager = renderNavigationForRole('MANAGER')
    expect(manager).toContain('<summary>Management</summary>')
    expect(manager).toContain('User Management')
    expect(manager).toContain('Audit Log')
    expect(manager).not.toContain('>Users<')
  })

  it('does not expose assignment actions during View-as', () => {
    expect(canOpenAssignmentDrawer(true, null)).toBe(true)
    expect(canOpenAssignmentDrawer(true, 'viewed-user')).toBe(false)
    expect(canOpenAssignmentDrawer(false, null)).toBe(false)
  })

  it('supplies Dashboard rep drill-down only for the effective role with rep.view', () => {
    const openRep = vi.fn()

    expect(dashboardRepDrillDown('ADMIN', openRep)).toBe(openRep)
    expect(dashboardRepDrillDown('MANAGER', openRep)).toBe(openRep)
    expect(dashboardRepDrillDown('BDC', openRep)).toBeUndefined()
    expect(dashboardRepDrillDown('REP', openRep)).toBeUndefined()
    expect(dashboardRepDrillDown(null, openRep)).toBeUndefined()

    // A signed-in ADMIN viewing as a BDC must use the BDC effective role.
    expect(dashboardRepDrillDown('BDC', openRep)).toBeUndefined()
  })

  it('wires the Import Activity next step to Staff List', () => {
    const setPage = vi.fn()

    activityImportStaffNavigation(setPage)()

    expect(setPage).toHaveBeenCalledOnce()
    expect(setPage).toHaveBeenCalledWith('staff')
  })

  it('mounts a fresh assignment drawer only while it is open', () => {
    const props = {
      onClose: () => {},
      onOpenRep: () => {},
    }

    expect(renderToStaticMarkup(createElement(AssignmentDrawerMount, { ...props, open: false }))).toBe('')
    const html = renderToStaticMarkup(createElement(AssignmentDrawerMount, { ...props, open: true }))
    expect(html).toContain('Assign lead')
    expect(html).toContain('aria-label="Close Assign lead"')
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
    expect(repBackPage(null, 'REP')).toBe('dashboard')
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
