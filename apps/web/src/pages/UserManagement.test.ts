import { describe, expect, it } from 'vitest'
import {
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
