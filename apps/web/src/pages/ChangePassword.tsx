import { useState } from 'react'
import { useAuthStore } from '../state/authStore'
import { authErrorCopy } from '../lib/authErrors'
import { PasswordInput } from '../ui/PasswordInput'
import { Button, Card, Field } from '../ui'
import { VOLUNTARY_PASSWORD_SUCCESS } from './changePasswordLogic'

/**
 * Forced password change (and the voluntary one).
 *
 * Shown as a full-screen gate whenever the session carries mustChangePassword, because
 * the server refuses every other route in that state — showing the app behind it would
 * just produce errors. `forced` only changes the copy; the enforcement is server-side.
 */
export function ChangePassword({ forced = false, onDone }: { forced?: boolean; onDone?: () => void }) {
  const { session, changePassword, logout } = useAuthStore()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const tooShort = newPassword.length > 0 && newPassword.length < 8
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword
  const valid =
    (forced || !!currentPassword) && newPassword.length >= 8 && newPassword === confirmPassword

  async function submit(e?: React.FormEvent) {
    e?.preventDefault()
    if (!valid) return
    setBusy(true)
    setError(null)
    setSuccess(null)
    try {
      await changePassword(forced ? undefined : currentPassword, newPassword)
      if (forced) {
        onDone?.()
      } else {
        setCurrentPassword('')
        setNewPassword('')
        setConfirmPassword('')
        setSuccess(VOLUNTARY_PASSWORD_SUCCESS)
      }
    } catch (err) {
      setError(authErrorCopy(err, 'change_password'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ui-page ui-login">
      <h1>{forced ? 'Choose a password' : 'Change password'}</h1>
      <Card className="ui-stack">
        {forced && (
          <p className="ui-hint">
            You're signed in with a temporary password. Pick your own before continuing — nothing
            else will work until you do.
          </p>
        )}
        <form onSubmit={submit} className="ui-stack">
          {!forced && (
            <Field label="Current password">
              <PasswordInput
                label="Current password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoFocus
                autoComplete="current-password"
              />
            </Field>
          )}
          <Field
            label="New password"
            hint="At least 8 characters."
            error={tooShort ? 'Must be at least 8 characters' : null}
          >
            <PasswordInput
              label="New password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              autoFocus={forced}
            />
          </Field>
          <Field label="Confirm new password" error={mismatch ? "Passwords don't match" : null}>
            <PasswordInput
              label="Confirm new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />
          </Field>

          {error && <p className="ui-error" role="alert">{error}</p>}
          {success && <p role="status" aria-live="polite">{success}</p>}

          <Button type="submit" variant="primary" block disabled={!valid || busy}>
            {busy ? 'Saving…' : 'Save password'}
          </Button>
          {success && onDone && (
            <Button type="button" block onClick={onDone}>Return to PhoneUp</Button>
          )}
        </form>

        <p className="ui-hint">
          Signed in as {session?.displayName ?? session?.email}.{' '}
          <button type="button" className="ui-linkbtn" onClick={() => logout()}>
            Sign out
          </button>
        </p>
      </Card>
    </div>
  )
}
