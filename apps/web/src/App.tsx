import { useEffect, useState } from 'react'
import { hasPermission } from '@phoneup/contracts'
import { useAuthStore } from './state/authStore'
import { Login } from './pages/Login'
import { AssignScreen } from './pages/AssignScreen'
import { StaffList } from './pages/StaffList'
import { Dashboard } from './pages/Dashboard'
import { UserManagement } from './pages/UserManagement'

type Page = 'assign' | 'staff' | 'dashboard' | 'users'

function App() {
  const { session, loading, refresh, logout } = useAuthStore()
  const [page, setPage] = useState<Page>('assign')

  useEffect(() => {
    refresh()
  }, [refresh])

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>
  if (!session) return <Login />

  return (
    <div>
      <nav style={{ display: 'flex', gap: 12, padding: 12, borderBottom: '1px solid #ccc' }}>
        <button onClick={() => setPage('assign')}>Assign</button>
        {(session.role === 'MANAGER' || session.role === 'ADMIN') && (
          <>
            <button onClick={() => setPage('staff')}>Staff List</button>
            <button onClick={() => setPage('dashboard')}>Dashboard</button>
          </>
        )}
        {hasPermission(session.role, 'user.manage') && <button onClick={() => setPage('users')}>Users</button>}
        <span style={{ marginLeft: 'auto' }}>
          {session.email} ({session.role})
        </span>
        <button onClick={() => logout()}>Log out</button>
      </nav>

      {page === 'assign' && <AssignScreen />}
      {page === 'staff' && <StaffList />}
      {page === 'dashboard' && <Dashboard />}
      {page === 'users' && <UserManagement />}
    </div>
  )
}

export default App
