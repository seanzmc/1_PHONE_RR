import { useState } from 'react'
import { useAuthStore } from '../state/authStore'
import { Button, Card, Field, Input } from '../ui'
import { PasswordInput } from '../ui/PasswordInput'
import { authErrorCopy } from '../lib/authErrors'

export function loginErrorCopy(message: string): string {
  return authErrorCopy(new Error(message), 'login')
}

export function Login({ onForgotPassword }: { onForgotPassword?: () => void }) {
  const login = useAuthStore((s) => s.login)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await login(email, password)
    } catch (err) {
      setError(loginErrorCopy(err instanceof Error ? err.message : 'login failed'))
    }
  }

  return (
    <div className="ui-page ui-login">
      <h1>PhoneUp Round-Robin</h1>
      <p className="ui-muted">
        First time signing in? Use the temporary password you were given — you’ll choose your own right after.
      </p>
      <Card>
        <form onSubmit={handleSubmit} className="ui-stack">
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              autoFocus
            />
          </Field>
          <Field label="Password">
            <PasswordInput
              label="Login password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          {error && <p className="ui-error" role="alert">{error}</p>}
          <Button type="submit" variant="primary" block>
            Log in
          </Button>
          {onForgotPassword && (
            <button type="button" className="ui-linkbtn" onClick={onForgotPassword}>
              Forgot password?
            </button>
          )}
        </form>
      </Card>
    </div>
  )
}
