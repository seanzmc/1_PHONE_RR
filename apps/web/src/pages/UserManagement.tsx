import { useEffect, useState } from 'react'
import { mutate, query } from '../lib/api'
import { useAuthStore } from '../state/authStore'
import { Badge, Button, Field, Input, Select, Table } from '../ui'
import { Modal } from '../ui/Modal'
import { useSubmitOnEnter } from '../ui/useSubmitOnEnter'

type Role = 'ADMIN' | 'MANAGER' | 'BDC' | 'REP'

type Account = {
  id: string
  email: string
  displayName: string | null
  role: Role
  isActive: boolean
  mustChangePassword: boolean
  createdAt: string
}

const ROLES: Role[] = ['ADMIN', 'MANAGER', 'BDC', 'REP']

export function UserManagement() {
  const { session } = useAuthStore()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)

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
    if (!addValid) return
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
    setError(null)
    try {
      await mutate('userManagement.setRole', { userId, newRole: newRoleValue })
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'role change failed')
    }
  }

  async function toggleActive(userId: string, isActive: boolean) {
    setError(null)
    try {
      await mutate('userManagement.setActive', { userId, isActive })
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'status change failed')
    }
  }

  async function submitReset() {
    if (!resetTargetId || resetValue.length < 8) return
    setError(null)
    try {
      await mutate('userManagement.resetPassword', { userId: resetTargetId, newPassword: resetValue })
      closeReset()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'password reset failed')
    }
  }

  function closeReset() {
    setResetTargetId(null)
    setResetValue('')
  }

  async function issueTempPassword(account: Account) {
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
      setError(err instanceof Error ? err.message : 'could not issue a temporary password')
    }
  }

  function copyIssued() {
    navigator.clipboard.writeText(issuedPassword).catch(() => {})
    setIssuedCopied(true)
  }

  const onAddKeyDown = useSubmitOnEnter(createAccount, { disabled: !addValid })
  const onResetKeyDown = useSubmitOnEnter(submitReset, { disabled: resetValue.length < 8 })

  const resetTarget = accounts.find((a) => a.id === resetTargetId)

  return (
    <div className="ui-page">
      <div className="ui-toolbar">
        <h2>Users</h2>
        <span className="ui-toolbar-spacer" />
        <Button variant="primary" onClick={() => setAddOpen(true)}>
          Add account
        </Button>
      </div>

      {error && <p className="ui-error">{error}</p>}
      {loadError && (
        <p className="ui-error">
          Couldn't load the user list — check your connection.{' '}
          <button type="button" className="ui-linkbtn" onClick={refresh}>
            Retry
          </button>
        </p>
      )}

      <Table headers={['Name', 'Email', 'Role', 'Status', 'Actions']}>
        {accounts.map((a) => {
          const isSelf = a.id === session?.userId
          return (
            <tr key={a.id}>
              <td>
                {/* displayName only — never fall back to the email, which reads as a name */}
                {a.displayName ? a.displayName : <span className="ui-muted">Set name</span>}
              </td>
              <td>{a.email}</td>
              <td>
                <Select
                  value={a.role}
                  disabled={isSelf}
                  title={isSelf ? 'You cannot change your own role' : undefined}
                  onChange={(e) => changeRole(a.id, e.target.value as Role)}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </td>
              <td>
                <div className="ui-row">
                  <Badge tone={a.isActive ? 'ok' : 'danger'}>{a.isActive ? 'ACTIVE' : 'INACTIVE'}</Badge>
                  {a.mustChangePassword && <Badge tone="warn">TEMP PASSWORD</Badge>}
                </div>
              </td>
              <td>
                <div className="ui-row">
                  <Button size="sm" onClick={() => toggleActive(a.id, !a.isActive)}>
                    {a.isActive ? 'Deactivate' : 'Reactivate'}
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => issueTempPassword(a)}>
                    Reset password
                  </Button>
                  <Button size="sm" onClick={() => setResetTargetId(a.id)}>
                    Set manually
                  </Button>
                </div>
              </td>
            </tr>
          )
        })}
      </Table>

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
        <Field label="Initial password" hint="Minimum 8 characters.">
          <Input value={newPassword} onChange={(e) => setNewPassword(e.target.value)} onKeyDown={onAddKeyDown} />
        </Field>
      </Modal>

      <Modal
        open={!!resetTargetId}
        title={`Reset password — ${resetTarget?.displayName ?? resetTarget?.email ?? ''}`}
        onClose={closeReset}
        onSubmit={submitReset}
        submitDisabled={resetValue.length < 8}
      >
        <Field label="New password" hint="Minimum 8 characters.">
          <Input
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
