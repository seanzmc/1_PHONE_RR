import { useState } from 'react'
import { useAuthStore } from '../state/authStore'
import { Button, Card, Field, Input } from '../ui'

export function loginErrorCopy(message: string): string {
  if (/invalid credentials/i.test(message)) {
    return "Email or password didn’t match — passwords are case-sensitive. Forgot it? A manager can reset it from the Users page."
  }
  const throttle = message.match(/too many failed attempts.*?(\d+) minute/i)
  if (throttle) {
    const minutes = Number(throttle[1])
    return `Too many failed attempts — try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
  }
  return message
}

export function Login() {
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
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          {error && <p className="ui-error" role="alert">{error}</p>}
          <Button type="submit" variant="primary" block>
            Log in
          </Button>
        </form>
      </Card>
    </div>
  )
}
