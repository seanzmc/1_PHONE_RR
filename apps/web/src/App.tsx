import { useEffect, useRef, useState } from 'react'
import { useAuthStore } from './state/authStore'
import { Login } from './pages/Login'
import { AssignScreen } from './pages/AssignScreen'
import { StaffList } from './pages/StaffList'
import { Dashboard } from './pages/Dashboard'
import { UserManagement } from './pages/UserManagement'
import { RepDetail } from './pages/RepDetail'
import { ActivityImport } from './pages/ActivityImport'
import { ChangePassword } from './pages/ChangePassword'
import { AuditLog } from './pages/AuditLog'
import { Button, Card, Select } from './ui'

export type Page = 'assign' | 'staff' | 'dashboard' | 'users' | 'audit' | 'me' | 'rep' | 'import' | 'password'

export function repBackPage(origin: Page | null, canAssign: boolean): Page {
  if (origin && origin !== 'rep' && origin !== 'password') return origin
  return canAssign ? 'assign' : 'me'
}

export function bootstrapRecoveryVisible(hasSession: boolean, bootstrapError: string | null): boolean {
  return !hasSession && bootstrapError !== null
}

export function focusPageHeading(main: HTMLElement | null): void {
  const heading = main?.querySelector<HTMLElement>('h1, h2')
  if (!heading) return
  heading.tabIndex = -1
  heading.focus()
}

function App() {
  const {
    session,
    loading,
    bootstrapError,
    refresh,
    logout,
    hasPermission,
    viewAsProfiles,
    viewAsUserId,
    selectedViewAs,
    loadViewAsProfiles,
    setViewAsUserId,
  } = useAuthStore()
  const [page, setPage] = useState<Page>('assign')
  const [openRepId, setOpenRepId] = useState<string | null>(null)
  const [repOriginPage, setRepOriginPage] = useState<Page | null>(null)
  const mainRef = useRef<HTMLElement>(null)
  const canAssign = hasPermission('lead.assign')
  const activePage: Page = page === 'assign' && !canAssign ? 'me' : page

  useEffect(() => {
    refresh().catch(() => {})
  }, [refresh])

  useEffect(() => {
    if (session?.role === 'ADMIN') loadViewAsProfiles().catch(() => {})
  }, [session?.role, session?.userId, loadViewAsProfiles])

  useEffect(() => {
    focusPageHeading(mainRef.current)
  }, [activePage, bootstrapError, loading, openRepId, session?.userId])

  if (loading) return <main ref={mainRef} className="ui-page"><h1 className="ui-sr-only">PhoneUp Round-Robin</h1><p>Loading…</p></main>
  if (bootstrapRecoveryVisible(!!session, bootstrapError)) {
    return (
      <main ref={mainRef} className="ui-page ui-login">
        <h1>PhoneUp Round-Robin</h1>
        <Card className="ui-stack">
          <p className="ui-error" role="alert">
            {bootstrapError}
          </p>
          <Button variant="primary" block onClick={() => refresh().catch(() => {})}>
            Retry
          </Button>
        </Card>
      </main>
    )
  }
  if (!session) return <main ref={mainRef}><Login /></main>

  // A temporary password blocks every other route server-side, so gate the whole app
  // rather than render screens that would only return PASSWORD_CHANGE_REQUIRED.
  if (session.mustChangePassword) return <main ref={mainRef}><ChangePassword forced /></main>

  const viewedProfile = selectedViewAs()
  const isRealAdmin = session.role === 'ADMIN'

  function openRep(repId: string) {
    setRepOriginPage(activePage)
    setOpenRepId(repId)
    setPage('rep')
  }

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
        {hasPermission('audit.view') && (
          <Button
            variant="ghost"
            aria-current={activePage === 'audit' ? 'page' : undefined}
            onClick={() => setPage('audit')}
          >
            Audit Log
          </Button>
        )}

        <span className="ui-toolbar-spacer" />

        {/* ADMIN-only, server-enforced real-profile view-as. */}
        {isRealAdmin && (
          <label className="ui-row">
            <span className="ui-hint">View as</span>
            <Select
              value={viewAsUserId ?? session.userId}
              onChange={(e) => {
                const target = e.target.value
                const profile = viewAsProfiles.find((candidate) => candidate.userId === target)
                setViewAsUserId(target)
                setPage(profile?.role === 'REP' ? 'me' : 'assign')
              }}
            >
              {viewAsProfiles.map((profile) => (
                <option key={profile.userId} value={profile.userId}>
                  {profile.displayName ?? profile.email} — {profile.role}
                </option>
              ))}
            </Select>
          </label>
        )}

        <details className="ui-profile-menu">
          <summary>
            {session.displayName ?? session.email} ({session.role})
          </summary>
          <div className="ui-profile-menu-panel">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setViewAsUserId(null)
                setPage('password')
              }}
            >
              Change password
            </Button>
            <Button size="sm" variant="ghost" onClick={() => logout()}>
              Log out
            </Button>
          </div>
        </details>
      </nav>

      {viewedProfile && (
        <div className="ui-banner">
          <strong>Viewing as {viewedProfile.displayName ?? viewedProfile.email}</strong>
          <span>
            Real {viewedProfile.role} permissions and self-scoped data are active. View-as is read-only.
          </span>
          <span className="ui-toolbar-spacer" />
          <Button
            size="sm"
            onClick={() => {
              setViewAsUserId(null)
              setPage('assign')
            }}
          >
            Exit
          </Button>
        </div>
      )}

      <main ref={mainRef}>
        {activePage === 'assign' && <AssignScreen onOpenRep={openRep} />}
        {activePage === 'staff' && <StaffList onOpenRep={openRep} />}
        {activePage === 'dashboard' && <Dashboard onOpenRep={openRep} />}
        {activePage === 'users' && <UserManagement />}
        {activePage === 'audit' && <AuditLog />}
        {activePage === 'import' && <ActivityImport />}
        {activePage === 'me' && <RepDetail />}
        {activePage === 'password' && (
          <ChangePassword onDone={() => setPage(canAssign ? 'assign' : 'me')} />
        )}
        {activePage === 'rep' && openRepId && (
          <RepDetail repId={openRepId} onBack={() => setPage(repBackPage(repOriginPage, canAssign))} />
        )}
      </main>
    </div>
  )
}

export default App
