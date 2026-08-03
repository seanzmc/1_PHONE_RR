import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useAuthStore } from '../state/authStore'
import {
  UserAccountRow,
  UserManagement,
  accountTargetName,
  adminPasswordInputProps,
  partitionAccounts,
  sortAccounts,
  type Account,
} from './UserManagement'
import { managerPasswordLabels } from '../lib/passwordLabels'

function account(over: Partial<Account> & Pick<Account, 'id'>): Account {
  return {
    email: `${over.id}@example.test`,
    displayName: over.id,
    role: 'BDC',
    isActive: true,
    mustChangePassword: false,
    createdAt: '2026-07-31T00:00:00.000Z',
    ...over,
  }
}

describe('User Management page guidance and sort semantics', () => {
  it('explains the page and exposes the active sort state with named sort controls', () => {
    const previousAuth = useAuthStore.getState()
    useAuthStore.setState({
      session: {
        userId: 'admin-1',
        role: 'ADMIN',
        email: 'admin@example.test',
        displayName: 'Admin',
        mustChangePassword: false,
      },
      loading: false,
      viewAsUserId: null,
    })

    try {
      const markup = renderToStaticMarkup(createElement(UserManagement))

      expect(markup).toContain('<h2>User Management</h2>')
      expect(markup).toContain('Manage accounts, roles, temporary passwords, and sign-in access.')
      expect(markup).toContain('aria-sort="ascending"')
      expect(markup).toContain('aria-label="Sort by Name"')
      expect(markup).toContain('aria-label="Sort by Email"')
      expect(markup).toContain('aria-label="Sort by Role"')
      expect(markup).toContain('aria-label="Sort by Account status"')
    } finally {
      useAuthStore.setState(previousAuth, true)
    }
  })
})

describe('User Management row control targets', () => {
  it('uses the display name when present and falls back to email', () => {
    expect(accountTargetName(account({ id: 'named', displayName: 'Taylor Reed' }))).toBe('Taylor Reed')
    expect(accountTargetName(account({ id: 'x', displayName: null, email: 'x@example.test' }))).toBe(
      'x@example.test',
    )
  })

  it('names enabled-account controls for their target and preserves approved visible copy', () => {
    const markup = renderToStaticMarkup(
      createElement(UserAccountRow, {
        account: account({ id: 'x', displayName: 'Taylor Reed', mustChangePassword: true }),
        sessionUserId: 'someone-else',
        canManageUsers: true,
        onRole: () => {},
        onToggleActive: () => {},
        onGenerateTemporary: () => {},
        onSetTemporary: () => {},
      }),
    )

    expect(markup).toContain('PASSWORD CHANGE REQUIRED')
    expect(markup).toContain('aria-label="Role for Taylor Reed"')
    expect(markup).toContain('aria-label="Disable Taylor Reed"')
    expect(markup).toContain('aria-label="Generate temporary password for Taylor Reed"')
    expect(markup).toContain('aria-label="Set temporary password for Taylor Reed"')
    expect(markup).toContain('>Generate temporary password</button>')
    expect(markup).toContain('>Set temporary password…</button>')
  })

  it('uses the email fallback for disabled-account controls and missing-name copy', () => {
    const markup = renderToStaticMarkup(
      createElement(UserAccountRow, {
        account: account({
          id: 'x',
          displayName: null,
          email: 'x@example.test',
          isActive: false,
        }),
        sessionUserId: 'someone-else',
        canManageUsers: true,
        onRole: () => {},
        onToggleActive: () => {},
        onGenerateTemporary: () => {},
        onSetTemporary: () => {},
      }),
    )

    expect(markup).toContain('<span class="ui-muted">(no display name)</span>')
    expect(markup).toContain('aria-label="Role for x@example.test"')
    expect(markup).toContain('aria-label="Enable x@example.test"')
    expect(markup).toContain('aria-label="Generate temporary password for x@example.test"')
    expect(markup).toContain('aria-label="Set temporary password for x@example.test"')
  })

  it('keeps self-role changes disabled with the existing explanation', () => {
    const markup = renderToStaticMarkup(
      createElement(UserAccountRow, {
        account: account({ id: 'self', displayName: 'Admin User', role: 'ADMIN' }),
        sessionUserId: 'self',
        canManageUsers: true,
        onRole: () => {},
        onToggleActive: () => {},
        onGenerateTemporary: () => {},
        onSetTemporary: () => {},
      }),
    )

    expect(markup).toContain('aria-label="Role for Admin User"')
    expect(markup).toContain('title="You cannot change your own role"')
    expect(markup).toContain('disabled=""')
  })
})

describe('partitionAccounts', () => {
  it('keeps enabled and disabled accounts in separate buckets', () => {
    const rows = [
      account({ id: 'enabled' }),
      account({ id: 'disabled', isActive: false }),
      account({ id: 'enabled-rep', role: 'REP' }),
    ]

    expect(partitionAccounts(rows).enabled.map((row) => row.id)).toEqual(['enabled', 'enabled-rep'])
    expect(partitionAccounts(rows).disabled.map((row) => row.id)).toEqual(['disabled'])
  })
})

describe('sortAccounts', () => {
  const rows = [
    account({ id: 'z', displayName: 'Zed', email: 'a@example.test', role: 'REP' }),
    account({ id: 'a', displayName: 'Amy', email: 'z@example.test', role: 'ADMIN' }),
    account({ id: 'blank', displayName: null, email: 'm@example.test', role: 'MANAGER' }),
  ]

  it('sorts names ascending and descending without mutating the source', () => {
    expect(sortAccounts(rows, 'name', 'asc').map((row) => row.id)).toEqual(['a', 'z', 'blank'])
    expect(sortAccounts(rows, 'name', 'desc').map((row) => row.id)).toEqual(['z', 'a', 'blank'])
    expect(rows.map((row) => row.id)).toEqual(['z', 'a', 'blank'])
  })

  it('sorts email and role deterministically', () => {
    expect(sortAccounts(rows, 'email', 'asc').map((row) => row.id)).toEqual(['z', 'blank', 'a'])
    expect(sortAccounts(rows, 'role', 'asc').map((row) => row.id)).toEqual(['a', 'blank', 'z'])
  })
})

describe('adminPasswordInputProps', () => {
  it('identifies admin-entered credentials for password managers', () => {
    expect(adminPasswordInputProps).toEqual({ autoComplete: 'new-password' })
  })

  it('gives each editable manager password a field-specific visibility label', () => {
    expect(managerPasswordLabels('Taylor Reed')).toEqual({
      initial: 'Initial password',
      manualReset: 'Temporary password for Taylor Reed',
    })
  })
})
