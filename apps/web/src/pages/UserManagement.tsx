import { useEffect, useState } from 'react'
import { mutate, query } from '../lib/api'
import { canMutateInCurrentView, useAuthStore } from '../state/authStore'
import { Badge, Button, Field, Input, Select, Table, type TableHeader } from '../ui'
import { PasswordInput } from '../ui/PasswordInput'
import { authErrorCopy } from '../lib/authErrors'
import { managerPasswordLabels } from '../lib/passwordLabels'
import { Modal } from '../ui/Modal'
import { useSubmitOnEnter } from '../ui/useSubmitOnEnter'

type Role = 'ADMIN' | 'MANAGER' | 'BDC' | 'REP'

export type Account = {
  id: string
  email: string
  displayName: string | null
  role: Role
  isActive: boolean
  mustChangePassword: boolean
  createdAt: string
}

export type AccountSortKey = 'name' | 'email' | 'role' | 'status'
export type SortDirection = 'asc' | 'desc'

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

export function sortAccounts(
  accounts: Account[],
  key: AccountSortKey,
  direction: SortDirection,
): Account[] {
  const multiplier = direction === 'asc' ? 1 : -1
  return [...accounts].sort((a, b) => {
    if (key === 'name') {
      if (!a.displayName) return b.displayName ? 1 : compareText(a.email, b.email)
      if (!b.displayName) return -1
      return multiplier * compareText(a.displayName, b.displayName) || compareText(a.email, b.email)
    }
    if (key === 'status') {
      return multiplier * compareText(a.isActive ? 'enabled' : 'disabled', b.isActive ? 'enabled' : 'disabled')
    }
    return multiplier * compareText(a[key], b[key]) || compareText(a.email, b.email)
  })
}

export function partitionAccounts(accounts: Account[]): { enabled: Account[]; disabled: Account[] } {
  return {
    enabled: accounts.filter((account) => account.isActive),
    disabled: accounts.filter((account) => !account.isActive),
  }
}

const ROLES: Role[] = ['ADMIN', 'MANAGER', 'BDC', 'REP']

export const adminPasswordInputProps = {
  autoComplete: 'new-password',
} as const

export function accountTargetName(account: Account): string {
  return account.displayName ?? account.email
}

export type UserAccountRowProps = {
  account: Account
  sessionUserId: string | undefined
  canManageUsers: boolean
  onRole: (userId: string, role: Role) => void
  onToggleActive: (userId: string, isActive: boolean) => void
  onGenerateTemporary: (account: Account) => void
  onSetTemporary: (userId: string) => void
}

export function UserAccountRow({
  account,
  sessionUserId,
  canManageUsers,
  onRole,
  onToggleActive,
  onGenerateTemporary,
  onSetTemporary,
}: UserAccountRowProps) {
  const isSelf = account.id === sessionUserId
  const targetName = accountTargetName(account)

  return (
    <tr>
      <td>
        {account.displayName ? account.displayName : <span className="ui-muted">(no display name)</span>}
      </td>
      <td>{account.email}</td>
      <td>
        <Select
          value={account.role}
          aria-label={`Role for ${targetName}`}
          disabled={isSelf || !canManageUsers}
          title={isSelf ? 'You cannot change your own role' : undefined}
          onChange={(event) => onRole(account.id, event.target.value as Role)}
        >
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </Select>
      </td>
      <td>
        <div className="ui-row">
          <Badge tone={account.isActive ? 'ok' : 'danger'}>
            {account.isActive ? 'ENABLED' : 'DISABLED'}
          </Badge>
          {account.mustChangePassword && <Badge tone="warn">PASSWORD CHANGE REQUIRED</Badge>}
        </div>
      </td>
      <td>
        <div className="ui-row">
          <Button
            size="sm"
            aria-label={`${account.isActive ? 'Disable' : 'Enable'} ${targetName}`}
            disabled={!canManageUsers}
            onClick={() => onToggleActive(account.id, !account.isActive)}
          >
            {account.isActive ? 'Disable' : 'Enable'}
          </Button>
          <Button
            size="sm"
            variant="primary"
            aria-label={`Generate temporary password for ${targetName}`}
            disabled={!canManageUsers}
            onClick={() => onGenerateTemporary(account)}
          >
            Generate temporary password
          </Button>
          <Button
            size="sm"
            aria-label={`Set temporary password for ${targetName}`}
            disabled={!canManageUsers}
            onClick={() => onSetTemporary(account.id)}
          >
            Set temporary password…
          </Button>
        </div>
      </td>
    </tr>
  )
}

export function UserManagement() {
  const { session, viewAsUserId } = useAuthStore()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [sortKey, setSortKey] = useState<AccountSortKey>('name')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')

  const [addOpen, setAddOpen] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState<Role>('BDC')
  const [newPassword, setNewPassword] = useState('')

  const [resetTargetId, setResetTargetId] = useState<string | null>(null)
  const [resetValue, setResetValue] = useState('')

  // one-click reset: the server generates a short speakable password and returns it once
  const [issuedFor, setIssuedFor] = useState<Account | null>(null)
  const [issuedPassword, setIssuedPassword] = useState('')
  const [issuedCopied, setIssuedCopied] = useState(false)
  const canManageUsers = canMutateInCurrentView(true, viewAsUserId)

  function refresh() {
    query<Account[]>('userManagement.list')
      .then((rows) => {
        setAccounts(rows)
        setLoadError(false)
      })
      // Silent here used to render an empty table that reads as "no accounts".
      .catch(() => setLoadError(true))
  }

  useEffect(refresh, [])

  const addValid = !!newEmail && !!newName.trim() && newPassword.length >= 8

  async function createAccount() {
    if (!addValid || !canManageUsers) return
    setError(null)
    try {
      await mutate('userManagement.create', {
        email: newEmail,
        displayName: newName,
        role: newRole,
        password: newPassword,
      })
      closeAdd()
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'create failed')
    }
  }

  function closeAdd() {
    setAddOpen(false)
    setNewEmail('')
    setNewName('')
    setNewRole('BDC')
    setNewPassword('')
  }

  async function changeRole(userId: string, newRoleValue: Role) {
    if (!canManageUsers) return
    setError(null)
    try {
      await mutate('userManagement.setRole', { userId, newRole: newRoleValue })
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'role change failed')
    }
  }

  async function toggleActive(userId: string, isActive: boolean) {
    if (!canManageUsers) return
    setError(null)
    try {
      await mutate('userManagement.setActive', { userId, isActive })
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'status change failed')
    }
  }

  async function submitReset() {
    if (!resetTargetId || resetValue.length < 8 || !canManageUsers) return
    setError(null)
    try {
      await mutate('userManagement.resetPassword', { userId: resetTargetId, newPassword: resetValue })
      closeReset()
    } catch (err) {
      setError(authErrorCopy(err, 'manager_reset'))
    }
  }

  function closeReset() {
    setResetTargetId(null)
    setResetValue('')
  }

  async function issueTempPassword(account: Account) {
    if (!canManageUsers) return
    setError(null)
    try {
      const res = await mutate<{ tempPassword: string }>('userManagement.issueTempPassword', {
        userId: account.id,
      })
      setIssuedFor(account)
      setIssuedPassword(res.tempPassword)
      setIssuedCopied(false)
      refresh()
    } catch (err) {
      setError(authErrorCopy(err, 'manager_reset'))
    }
  }

  function copyIssued() {
    navigator.clipboard.writeText(issuedPassword).catch(() => {})
    setIssuedCopied(true)
  }

  const onAddKeyDown = useSubmitOnEnter(createAccount, { disabled: !addValid })
  const onResetKeyDown = useSubmitOnEnter(submitReset, { disabled: resetValue.length < 8 })

  const resetTarget = accounts.find((a) => a.id === resetTargetId)
  const partitioned = partitionAccounts(accounts)
  const enabledAccounts = sortAccounts(partitioned.enabled, sortKey, sortDirection)
  const disabledAccounts = sortAccounts(partitioned.disabled, sortKey, sortDirection)

  function changeSort(nextKey: AccountSortKey) {
    if (nextKey === sortKey) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortKey(nextKey)
    setSortDirection('asc')
  }

  function sortHeader(label: string, key: AccountSortKey) {
    const active = key === sortKey
    return {
      content: (
        <button
          type="button"
          className="ui-sortbtn"
          aria-label={`Sort by ${label}`}
          onClick={() => changeSort(key)}
        >
          {label} {active ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}
        </button>
      ),
      ariaSort: active ? (sortDirection === 'asc' ? 'ascending' : 'descending') : undefined,
    } satisfies TableHeader
  }

  function accountRows(rows: Account[]) {
    return rows.map((account) => (
      <UserAccountRow
        key={account.id}
        account={account}
        sessionUserId={session?.userId}
        canManageUsers={canManageUsers}
        onRole={changeRole}
        onToggleActive={toggleActive}
        onGenerateTemporary={issueTempPassword}
        onSetTemporary={setResetTargetId}
      />
    ))
  }

  const accountHeaders = [
    sortHeader('Name', 'name'),
    sortHeader('Email', 'email'),
    sortHeader('Role', 'role'),
    sortHeader('Account status', 'status'),
    'Actions',
  ]

  return (
    <div className="ui-page">
      <div className="ui-toolbar">
        <h2>User Management</h2>
        <span className="ui-toolbar-spacer" />
        <Button variant="primary" disabled={!canManageUsers} onClick={() => setAddOpen(true)}>
          Add account
        </Button>
      </div>
      <p className="ui-muted">Manage accounts, roles, temporary passwords, and sign-in access.</p>

      {error && <p className="ui-error" role="alert">{error}</p>}
      {loadError && (
        <p className="ui-error" role="alert">
          Couldn't load the user list — check your connection.{' '}
          <button type="button" className="ui-linkbtn" onClick={refresh}>
            Retry
          </button>
        </p>
      )}

      <h3>Enabled accounts</h3>
      <Table headers={accountHeaders}>{accountRows(enabledAccounts)}</Table>

      <h3 style={{ marginTop: 'var(--space-6)' }}>Inactive accounts</h3>
      {disabledAccounts.length === 0 ? (
        <p className="ui-muted">No disabled accounts.</p>
      ) : (
        <Table headers={accountHeaders}>{accountRows(disabledAccounts)}</Table>
      )}

      <Modal
        open={!!issuedFor}
        title={`Temporary password — ${issuedFor?.displayName ?? issuedFor?.email ?? ''}`}
        onClose={() => setIssuedFor(null)}
        submitLabel="Done"
        onSubmit={() => setIssuedFor(null)}
        cancelLabel="Close"
        hint="Shown once — generate another if it's lost."
      >
        <p>Read this to them, or copy it:</p>
        <p className="ui-temppw">{issuedPassword}</p>
        <div className="ui-row">
          <Button onClick={copyIssued}>{issuedCopied ? 'Copied' : 'Copy'}</Button>
        </div>
        <p className="ui-hint">
          They must choose their own password the first time they sign in — until they do, this
          account can't use anything else. It isn't stored anywhere in readable form, so if it's
          lost just reset again.
        </p>
      </Modal>

      <Modal
        open={addOpen}
        title="Add account"
        onClose={closeAdd}
        onSubmit={createAccount}
        submitDisabled={!addValid}
        submitLabel="Create"
      >
        <Field label="Email">
          <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} onKeyDown={onAddKeyDown} />
        </Field>
        <Field label="Display name">
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={onAddKeyDown} />
        </Field>
        <Field label="Role">
          <Select value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Initial password"
          hint="Minimum 8 characters. This password is temporary; the user must replace it at next sign-in."
        >
          <PasswordInput
            label={managerPasswordLabels(newName.trim() || 'new account').initial}
            {...adminPasswordInputProps}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            onKeyDown={onAddKeyDown}
          />
        </Field>
      </Modal>

      <Modal
        open={!!resetTargetId}
        title={`Set temporary password — ${resetTarget ? accountTargetName(resetTarget) : ''}`}
        onClose={closeReset}
        onSubmit={submitReset}
        submitDisabled={resetValue.length < 8}
      >
        <Field
          label="New password"
          hint="Minimum 8 characters. This password is temporary; the user must replace it at next sign-in."
        >
          <PasswordInput
            label={managerPasswordLabels(resetTarget?.displayName ?? resetTarget?.email ?? 'user').manualReset}
            {...adminPasswordInputProps}
            value={resetValue}
            onChange={(e) => setResetValue(e.target.value)}
            onKeyDown={onResetKeyDown}
            placeholder="new password"
          />
        </Field>
      </Modal>
    </div>
  )
}
