import { useState } from 'react'
import { useAuthStore } from '../state/authStore'
import { authErrorCopy } from '../lib/authErrors'
import { Button, Card, Field, Input } from '../ui'

export const PASSWORD_RECOVERY_SUCCESS =
  'If that email belongs to an active PhoneUp account, a reset link is on its way.'

export function PasswordRecovery({ onBack }: { onBack: () => void }) {
  const requestPasswordReset = useAuthStore((state) => state.requestPasswordReset)
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!email.trim()) return
    setBusy(true)
    setError(null)
    try {
      await requestPasswordReset(email)
      setSent(true)
    } catch (requestError) {
      setError(authErrorCopy(requestError, 'request_reset'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ui-page ui-login">
      <h1>Reset your password</h1>
      <Card className="ui-stack">
        {sent ? (
          <>
            <p role="status" aria-live="polite">{PASSWORD_RECOVERY_SUCCESS}</p>
            <p className="ui-hint">The link expires after 30 minutes and works only once.</p>
            <Button variant="primary" block onClick={onBack}>Return to login</Button>
            <button
              type="button"
              className="ui-linkbtn"
              onClick={() => {
                setSent(false)
                setError(null)
              }}
            >
              Send another link
            </button>
          </>
        ) : (
          <form onSubmit={submit} className="ui-stack">
            <p className="ui-hint">
              Enter the email on your active PhoneUp account. If it is eligible, we’ll email a
              single-use reset link.
            </p>
            <Field label="Email">
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                autoFocus
              />
            </Field>
            {error && <p className="ui-error" role="alert">{error}</p>}
            <Button type="submit" variant="primary" block disabled={!email.trim() || busy}>
              {busy ? 'Sending…' : 'Email reset link'}
            </Button>
            <button type="button" className="ui-linkbtn" onClick={onBack}>Return to login</button>
          </form>
        )}
      </Card>
    </div>
  )
}
