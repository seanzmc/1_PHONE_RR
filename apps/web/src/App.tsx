import { useEffect, useRef, useState } from 'react'
import type { Role } from '@phoneup/contracts'
import { useAuthStore } from './state/authStore'
import { Login } from './pages/Login'
import { StaffList } from './pages/StaffList'
import { Dashboard } from './pages/Dashboard'
import { UserManagement } from './pages/UserManagement'
import { RepDetail } from './pages/RepDetail'
import { ActivityImport } from './pages/ActivityImport'
import { ChangePassword } from './pages/ChangePassword'
import { AuditLog } from './pages/AuditLog'
import { PasswordRecovery } from './pages/PasswordRecovery'
import { ResetPassword } from './pages/ResetPassword'
import { resetTokenFromLocation } from './lib/publicAuth'
import { Button, Card, Select } from './ui'
import { AssignmentDrawer } from './pages/assignment/AssignmentDrawer'
import type { AssignmentDrawerProps } from './pages/assignment/AssignmentDrawer'

export type Page = 'staff' | 'dashboard' | 'users' | 'audit' | 'me' | 'rep' | 'import' | 'password'
export type PublicAuthPage = 'login' | 'recovery' | 'reset'

export function landingPage(role: Role): Page {
  return role === 'REP' ? 'me' : 'dashboard'
}

export function canOpenAssignmentDrawer(canAssign: boolean, viewAsUserId: string | null): boolean {
  return canAssign && viewAsUserId === null
}

export function repBackPage(origin: Page | null, role: Role): Page {
  if (origin && origin !== 'rep' && origin !== 'password') return origin
  return landingPage(role)
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

export function AssignmentDrawerMount(props: AssignmentDrawerProps) {
  if (!props.open) return null
  return <AssignmentDrawer {...props} />
}

export type AssignmentTriggerFocusRestorerProps = {
  open: boolean
  triggerRef: Readonly<{ current: HTMLElement | null }>
}

export function AssignmentTriggerFocusRestorer({ open, triggerRef }: AssignmentTriggerFocusRestorerProps) {
  const wasOpen = useRef(open)

  useEffect(() => {
    const justClosed = wasOpen.current && !open
    wasOpen.current = open
    if (!justClosed) return

    const target = triggerRef.current
    if (!target || target.isConnected === false || target.closest('[inert]')) return
    target.focus()
  }, [open, triggerRef])

  return null
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
  const [page, setPage] = useState<Page>('dashboard')
  const [resetToken] = useState(() =>
    typeof window === 'undefined' ? null : resetTokenFromLocation(window.location.search),
  )
  const [publicAuthPage, setPublicAuthPage] = useState<PublicAuthPage>(() =>
    resetTokenFromLocation(typeof window === 'undefined' ? '' : window.location.search) ? 'reset' : 'login',
  )
  const [openRepId, setOpenRepId] = useState<string | null>(null)
  const [repOriginPage, setRepOriginPage] = useState<Page | null>(null)
  const [assignmentDrawerOpen, setAssignmentDrawerOpen] = useState(false)
  const assignmentTriggerRef = useRef<HTMLButtonElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const viewedProfile = selectedViewAs()
  const sessionRole = session?.role
  const sessionUserId = session?.userId
  const effectiveRole = viewedProfile?.role ?? session?.role ?? null
  const canAssign = hasPermission('lead.assign')
  const activePage = page

  useEffect(() => {
    refresh().catch(() => {})
  }, [refresh])

  useEffect(() => {
    if (session?.role === 'ADMIN') loadViewAsProfiles().catch(() => {})
  }, [session?.role, session?.userId, loadViewAsProfiles])

  useEffect(() => {
    if (sessionRole) setPage(landingPage(sessionRole))
  }, [sessionRole, sessionUserId])

  useEffect(() => {
    focusPageHeading(mainRef.current)
  }, [activePage, bootstrapError, loading, openRepId, publicAuthPage, session?.userId])

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
  if (publicAuthPage === 'reset' && resetToken) {
    return (
      <main ref={mainRef}>
        <ResetPassword
          token={resetToken}
          onDone={() => setPublicAuthPage('login')}
          onRequestNew={() => setPublicAuthPage('recovery')}
        />
      </main>
    )
  }
  if (!session) {
    return (
      <main ref={mainRef}>
        {publicAuthPage === 'recovery' ? (
          <PasswordRecovery onBack={() => setPublicAuthPage('login')} />
        ) : (
          <Login onForgotPassword={() => setPublicAuthPage('recovery')} />
        )}
      </main>
    )
  }

  // A temporary password blocks every other route server-side, so gate the whole app
  // rather than render screens that would only return PASSWORD_CHANGE_REQUIRED.
  if (session.mustChangePassword) return <main ref={mainRef}><ChangePassword forced /></main>

  const isRealAdmin = session.role === 'ADMIN'
  const viewAsRoles = ['REP', 'BDC', 'MANAGER', 'ADMIN'] as const

  function openRep(repId: string) {
    setRepOriginPage(activePage)
    setOpenRepId(repId)
    setPage('rep')
  }

  function openRepFromAssignmentDrawer(repId: string) {
    assignmentTriggerRef.current = null
    setAssignmentDrawerOpen(false)
    openRep(repId)
  }

  return (
    <div>
      <div inert={assignmentDrawerOpen}>
      <nav className="ui-nav">
        <span className="ui-nav-brand">PhoneUp</span>

        {canOpenAssignmentDrawer(canAssign, viewAsUserId) && (
          <Button
            variant="primary"
            onClick={(event) => {
              assignmentTriggerRef.current = event.currentTarget
              setAssignmentDrawerOpen(true)
            }}
          >
            Assign Lead
          </Button>
        )}
        {effectiveRole === 'REP' && (
          <Button
            variant="ghost"
            aria-current={activePage === 'me' ? 'page' : undefined}
            onClick={() => setPage('me')}
          >
            My Dashboard
          </Button>
        )}
        {hasPermission('rep.override') && (
          <Button
            variant="ghost"
            aria-current={activePage === 'staff' ? 'page' : undefined}
            onClick={() => setPage('staff')}
          >
            Staff List
          </Button>
        )}
        {effectiveRole !== 'REP' && hasPermission('board.view') && (
          <Button
            variant="ghost"
            aria-current={activePage === 'dashboard' ? 'page' : undefined}
            onClick={() => setPage('dashboard')}
          >
            Team Dashboard
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
                setPage(landingPage(profile?.role ?? session.role))
              }}
            >
              {viewAsRoles.map((role) => {
                const profiles = viewAsProfiles.filter((profile) => profile.role === role)
                if (profiles.length === 0) return null
                return (
                  <optgroup key={role} label={role}>
                    {profiles.map((profile) => (
                      <option key={profile.userId} value={profile.userId}>
                        {profile.displayName ?? profile.email}
                      </option>
                    ))}
                  </optgroup>
                )
              })}
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
              setPage(landingPage(session.role))
            }}
          >
            Exit
          </Button>
        </div>
      )}

      <main ref={mainRef}>
        {activePage === 'staff' && <StaffList onOpenRep={openRep} />}
        {activePage === 'dashboard' && <Dashboard onOpenRep={openRep} />}
        {activePage === 'users' && <UserManagement />}
        {activePage === 'audit' && <AuditLog />}
        {activePage === 'import' && <ActivityImport />}
        {activePage === 'me' && <RepDetail />}
        {activePage === 'password' && (
          <ChangePassword onDone={() => setPage(landingPage(effectiveRole ?? session.role))} />
        )}
        {activePage === 'rep' && openRepId && (
          <RepDetail repId={openRepId} onBack={() => setPage(repBackPage(repOriginPage, effectiveRole ?? session.role))} />
        )}
      </main>
      </div>
      <AssignmentTriggerFocusRestorer open={assignmentDrawerOpen} triggerRef={assignmentTriggerRef} />
      <AssignmentDrawerMount
        open={assignmentDrawerOpen}
        onClose={() => setAssignmentDrawerOpen(false)}
        onOpenRep={openRepFromAssignmentDrawer}
      />
    </div>
  )
}

export default App
