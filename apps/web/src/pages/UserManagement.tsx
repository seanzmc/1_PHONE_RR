import { useEffect, useState } from 'react'
import { mutate, query } from '../lib/api'

type Role = 'ADMIN' | 'MANAGER' | 'BDC' | 'REP'

type Account = {
  id: string
  email: string
  displayName: string | null
  role: Role
  isActive: boolean
  createdAt: string
}

const ROLES: Role[] = ['ADMIN', 'MANAGER', 'BDC', 'REP']

export function UserManagement() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [error, setError] = useState<string | null>(null)

  const [newEmail, setNewEmail] = useState('')
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState<Role>('BDC')
  const [newPassword, setNewPassword] = useState('')

  const [resetTargetId, setResetTargetId] = useState<string | null>(null)
  const [resetValue, setResetValue] = useState('')

  function refresh() {
    query<Account[]>('userManagement.list').then(setAccounts).catch(() => {})
  }

  useEffect(refresh, [])

  async function createAccount() {
    setError(null)
    try {
      await mutate('userManagement.create', {
        email: newEmail,
        displayName: newName,
        role: newRole,
        password: newPassword,
      })
      setNewEmail('')
      setNewName('')
      setNewRole('BDC')
      setNewPassword('')
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'create failed')
    }
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
    if (!resetTargetId || !resetValue) return
    setError(null)
    try {
      await mutate('userManagement.resetPassword', { userId: resetTargetId, newPassword: resetValue })
      setResetTargetId(null)
      setResetValue('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'password reset failed')
    }
  }

  return (
    <div style={{ padding: 24 }}>
      <h2>Users</h2>
      {error && <p style={{ color: 'red' }}>{error}</p>}

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Name</th>
            <th style={{ textAlign: 'left' }}>Email</th>
            <th style={{ textAlign: 'left' }}>Role</th>
            <th style={{ textAlign: 'left' }}>Status</th>
            <th style={{ textAlign: 'left' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.id}>
              <td>{a.displayName ?? a.email}</td>
              <td>{a.email}</td>
              <td>
                <select value={a.role} onChange={(e) => changeRole(a.id, e.target.value as Role)}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </td>
              <td>{a.isActive ? 'ACTIVE' : 'INACTIVE'}</td>
              <td>
                <button onClick={() => toggleActive(a.id, !a.isActive)} style={{ marginRight: 8 }}>
                  {a.isActive ? 'Deactivate' : 'Reactivate'}
                </button>
                <button onClick={() => setResetTargetId(a.id)}>Reset password</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {resetTargetId && (
        <div style={{ marginTop: 16, border: '1px solid #ccc', padding: 12, maxWidth: 400 }}>
          <p>
            New password for{' '}
            <strong>{accounts.find((a) => a.id === resetTargetId)?.displayName ?? resetTargetId}</strong>
          </p>
          <input
            type="text"
            value={resetValue}
            onChange={(e) => setResetValue(e.target.value)}
            placeholder="new password (min 8 chars)"
            style={{ width: '100%' }}
          />
          <div style={{ marginTop: 8 }}>
            <button onClick={submitReset} disabled={resetValue.length < 8}>
              Confirm
            </button>
            <button onClick={() => setResetTargetId(null)} style={{ marginLeft: 8 }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 24, border: '1px solid #ccc', padding: 12, maxWidth: 400 }}>
        <h3>Add account</h3>
        <input
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder="email"
          style={{ width: '100%', marginBottom: 8 }}
        />
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="display name"
          style={{ width: '100%', marginBottom: 8 }}
        />
        <select value={newRole} onChange={(e) => setNewRole(e.target.value as Role)} style={{ marginBottom: 8 }}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="initial password (min 8 chars)"
          style={{ width: '100%', marginBottom: 8 }}
        />
        <button onClick={createAccount} disabled={!newEmail || !newName || newPassword.length < 8}>
          Create
        </button>
      </div>
    </div>
  )
}
