import { useEffect, useState } from 'react'
import type { Role } from '@phoneup/contracts'
import { useAuthStore } from './state/authStore'
import { Login } from './pages/Login'
import { AssignScreen } from './pages/AssignScreen'
import { StaffList } from './pages/StaffList'
import { Dashboard } from './pages/Dashboard'
import { UserManagement } from './pages/UserManagement'
import { RepDetail } from './pages/RepDetail'
import { ActivityImport } from './pages/ActivityImport'
import { Button, Select } from './ui'

type Page = 'assign' | 'staff' | 'dashboard' | 'users' | 'me' | 'rep' | 'import'

const VIEW_AS_ROLES: Role[] = ['ADMIN', 'MANAGER', 'BDC', 'REP']

function App() {
  const { session, loading, refresh, logout, hasPermission, viewAsRole, setViewAsRole, effectiveRole } =
    useAuthStore()
  const [page, setPage] = useState<Page>('assign')
  const [openRepId, setOpenRepId] = useState<string | null>(null)

  useEffect(() => {
    refresh()
  }, [refresh])

  if (loading) return <div className="ui-page">Loading…</div>
  if (!session) return <Login />

  const role = effectiveRole()
  const isRealAdmin = session.role === 'ADMIN'

  function openRep(repId: string) {
    setOpenRepId(repId)
    setPage('rep')
  }

  // Reps have no assign screen; land them on their own dashboard instead.
  const canAssign = hasPermission('lead.assign')
  const activePage: Page = page === 'assign' && !canAssign ? 'me' : page

  return (
    <div>
      <nav className="ui-nav">
        <span className="ui-nav-brand">PhoneUp</span>

        {canAssign && (
          <Button
            variant="ghost"
            aria-current={activePage === 'assign' ? 'page' : undefined}
            onClick={() => setPage('assign')}
          >
            Assign
          </Button>
        )}
        <Button
          variant="ghost"
          aria-current={activePage === 'me' ? 'page' : undefined}
          onClick={() => setPage('me')}
        >
          My Dashboard
        </Button>
        {hasPermission('rep.override') && (
          <Button
            variant="ghost"
            aria-current={activePage === 'staff' ? 'page' : undefined}
            onClick={() => setPage('staff')}
          >
            Staff List
          </Button>
        )}
        {hasPermission('audit.view') && (
          <Button
            variant="ghost"
            aria-current={activePage === 'dashboard' ? 'page' : undefined}
            onClick={() => setPage('dashboard')}
          >
            Dashboard
          </Button>
        )}
        {hasPermission('activity.import') && (
          <Button
            variant="ghost"
            aria-current={activePage === 'import' ? 'page' : undefined}
            onClick={() => setPage('import')}
          >
            Import Activity
          </Button>
        )}
        {hasPermission('user.manage') && (
          <Button
            variant="ghost"
            aria-current={activePage === 'users' ? 'page' : undefined}
            onClick={() => setPage('users')}
          >
            Users
          </Button>
        )}

        <span className="ui-toolbar-spacer" />

        {/* §G admin view-as — CLIENT-ONLY layout preview, see the banner copy below */}
        {isRealAdmin && (
          <label className="ui-row">
            <span className="ui-hint">View as</span>
            <Select
              value={viewAsRole ?? session.role}
              onChange={(e) => setViewAsRole(e.target.value as Role)}
            >
              {VIEW_AS_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </label>
        )}

        <span className="ui-hint">
          {session.displayName ?? session.email} ({role})
        </span>
        <Button onClick={() => logout()}>Log out</Button>
      </nav>

      {viewAsRole && (
        <div className="ui-banner">
          <strong>Viewing as {viewAsRole}</strong>
          <span>
            Layout preview only — your real {session.role} permissions still apply, so screens that
            are not role-filtered still show {session.role} data.
          </span>
          <span className="ui-toolbar-spacer" />
          <Button size="sm" onClick={() => setViewAsRole(null)}>
            Exit
          </Button>
        </div>
      )}

      {activePage === 'assign' && <AssignScreen onOpenRep={openRep} />}
      {activePage === 'staff' && <StaffList onOpenRep={openRep} />}
      {activePage === 'dashboard' && <Dashboard onOpenRep={openRep} />}
      {activePage === 'users' && <UserManagement />}
      {activePage === 'import' && <ActivityImport />}
      {activePage === 'me' && <RepDetail />}
      {activePage === 'rep' && openRepId && (
        <RepDetail repId={openRepId} onBack={() => setPage(canAssign ? 'assign' : 'me')} />
      )}
    </div>
  )
}

export default App
