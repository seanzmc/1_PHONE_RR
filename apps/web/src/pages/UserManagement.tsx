import { useEffect, useState, type ChangeEventHandler, type KeyboardEventHandler, type ReactNode } from 'react'
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

const ADMINISTRATOR_ISSUED_PASSWORD_HINT =
  'Minimum 8 characters. This password is temporary; the user must replace it at next sign-in.'

export function accountTargetName(account: Account): string {
  return account.displayName ?? account.email
}

export function buildAccountSortHeader(
  label: string,
  key: AccountSortKey,
  sortKey: AccountSortKey,
  sortDirection: SortDirection,
  onSort: (key: AccountSortKey) => void,
): TableHeader {
  const active = key === sortKey
  return {
    content: (
      <button
        type="button"
        className="ui-sortbtn"
        aria-label={`Sort by ${label}`}
        onClick={() => onSort(key)}
      >
        {label} {active ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}
      </button>
    ),
    ariaSort: active ? (sortDirection === 'asc' ? 'ascending' : 'descending') : undefined,
  }
}

export type AdministratorIssuedPasswordFieldProps = {
  fieldLabel: string
  inputLabel: string
  value: string
  onChange: ChangeEventHandler<HTMLInputElement>
  onKeyDown?: KeyboardEventHandler<HTMLInputElement | HTMLTextAreaElement>
  placeholder?: string
}

export function AdministratorIssuedPasswordField({
  fieldLabel,
  inputLabel,
  value,
  onChange,
  onKeyDown,
  placeholder,
}: AdministratorIssuedPasswordFieldProps) {
  return (
    <Field label={fieldLabel} hint={ADMINISTRATOR_ISSUED_PASSWORD_HINT}>
      <PasswordInput
        label={inputLabel}
        {...adminPasswordInputProps}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
      />
    </Field>
  )
}

export type SetTemporaryPasswordModalProps = {
  open: boolean
  target: Account | undefined
  value: string
  onChange: ChangeEventHandler<HTMLInputElement>
  onKeyDown?: KeyboardEventHandler<HTMLInputElement | HTMLTextAreaElement>
  onClose: () => void
  onSubmit: () => void
}

export function SetTemporaryPasswordModal({
  open,
  target,
  value,
  onChange,
  onKeyDown,
  onClose,
  onSubmit,
}: SetTemporaryPasswordModalProps) {
  const targetName = target ? accountTargetName(target) : ''
  const inputTargetName = target?.displayName ?? target?.email ?? 'user'
  return (
    <Modal
      open={open}
      title={`Set temporary password — ${targetName}`}
      onClose={onClose}
      onSubmit={onSubmit}
      submitDisabled={value.length < 8}
    >
      <AdministratorIssuedPasswordField
        fieldLabel="New password"
        inputLabel={managerPasswordLabels(inputTargetName).manualReset}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder="new password"
      />
    </Modal>
  )
}

export type GeneratedTemporaryPasswordModalProps = {
  account: Account | null
  password: string
  copied: boolean
  onCopy: () => void
  onClose: () => void
}

export function GeneratedTemporaryPasswordModal({
  account,
  password,
  copied,
  onCopy,
  onClose,
}: GeneratedTemporaryPasswordModalProps) {
  return (
    <Modal
      open={!!account}
      title={`Temporary password — ${account ? accountTargetName(account) : ''}`}
      onClose={onClose}
      submitLabel="Done"
      onSubmit={onClose}
      cancelLabel="Close"
      hint="Shown once — generate another if it's lost."
    >
      <p>Read this to them, or copy it:</p>
      <p className="ui-temppw">{password}</p>
      <div className="ui-row">
        <Button onClick={onCopy}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
      <p className="ui-hint">
        They must choose their own password the first time they sign in — until they do, this
        account can't use anything else. It isn't stored anywhere in readable form, so if it's
        lost just reset again.
      </p>
    </Modal>
  )
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

export type UserAccountSectionsProps = {
  enabledAccounts: Account[]
  disabledAccounts: Account[]
  headers: Array<ReactNode | TableHeader>
  renderRows: (accounts: Account[]) => ReactNode
}

export function UserAccountSections({
  enabledAccounts,
  disabledAccounts,
  headers,
  renderRows,
}: UserAccountSectionsProps) {
  return (
    <>
      <h3>Enabled accounts</h3>
      <Table headers={headers}>{renderRows(enabledAccounts)}</Table>

      <h3 style={{ marginTop: 'var(--space-6)' }}>Inactive accounts</h3>
      {disabledAccounts.length === 0 ? (
        <p className="ui-muted">No disabled accounts.</p>
      ) : (
        <Table headers={headers}>{renderRows(disabledAccounts)}</Table>
      )}
    </>
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
    return buildAccountSortHeader(label, key, sortKey, sortDirection, changeSort)
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

      <UserAccountSections
        enabledAccounts={enabledAccounts}
        disabledAccounts={disabledAccounts}
        headers={accountHeaders}
        renderRows={accountRows}
      />

      <GeneratedTemporaryPasswordModal
        account={issuedFor}
        password={issuedPassword}
        copied={issuedCopied}
        onCopy={copyIssued}
        onClose={() => setIssuedFor(null)}
      />

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
        <AdministratorIssuedPasswordField
          fieldLabel="Initial password"
          inputLabel={managerPasswordLabels(newName.trim() || 'new account').initial}
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          onKeyDown={onAddKeyDown}
        />
      </Modal>

      <SetTemporaryPasswordModal
        open={!!resetTargetId}
        target={resetTarget}
        value={resetValue}
        onChange={(event) => setResetValue(event.target.value)}
        onKeyDown={onResetKeyDown}
        onClose={closeReset}
        onSubmit={submitReset}
      />
    </div>
  )
}
