import { useState } from 'react'
import { useAuthStore } from '../state/authStore'
import { authErrorCopy } from '../lib/authErrors'
import { PasswordInput } from '../ui/PasswordInput'
import { Button, Card, Field } from '../ui'
import {
  clearResetTokenFromUrl,
  requestAnotherReset,
  resetPasswordValidation,
} from './resetPasswordLogic'

export function ResetPassword({
  token,
  onDone,
  onRequestNew,
}: {
  token: string
  onDone: () => void
  onRequestNew: () => void
}) {
  const completePasswordReset = useAuthStore((state) => state.completePasswordReset)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [complete, setComplete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const validation = resetPasswordValidation(newPassword, confirmPassword)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!validation.valid) return
    setBusy(true)
    setError(null)
    try {
      await completePasswordReset(token, newPassword)
      clearResetTokenFromUrl()
      setNewPassword('')
      setConfirmPassword('')
      setComplete(true)
    } catch (resetError) {
      setError(authErrorCopy(resetError, 'complete_reset'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ui-page ui-login">
      <h1>Choose a new password</h1>
      <Card className="ui-stack">
        {complete ? (
          <>
            <p role="status" aria-live="polite">Your password has been reset.</p>
            <Button variant="primary" block onClick={onDone}>Return to login</Button>
          </>
        ) : (
          <form onSubmit={submit} className="ui-stack">
            <p className="ui-hint">This link works once and expires 30 minutes after it was sent.</p>
            <Field
              label="New password"
              hint="At least 8 characters."
              error={validation.tooShort ? 'Must be at least 8 characters' : null}
            >
              <PasswordInput
                label="New password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
                autoFocus
              />
            </Field>
            <Field
              label="Confirm new password"
              error={validation.mismatch ? 'Passwords don’t match' : null}
            >
              <PasswordInput
                label="Confirm new password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
              />
            </Field>
            {error && (
              <div className="ui-stack" role="alert">
                <p className="ui-error">{error}</p>
                <button
                  type="button"
                  className="ui-linkbtn"
                  onClick={() => requestAnotherReset(window.history, onRequestNew)}
                >
                  Request a new reset link
                </button>
              </div>
            )}
            <Button type="submit" variant="primary" block disabled={!validation.valid || busy}>
              {busy ? 'Saving…' : 'Reset password'}
            </Button>
          </form>
        )}
      </Card>
    </div>
  )
}
