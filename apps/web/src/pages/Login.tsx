import { useState } from 'react'
import { useAuthStore } from '../state/authStore'
import { Button, Card, Field, Input } from '../ui'

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
      setError(err instanceof Error ? err.message : 'login failed')
    }
  }

  return (
    <div className="ui-page ui-login">
      <h1>PhoneUp Round-Robin</h1>
      <Card>
        <form onSubmit={handleSubmit} className="ui-stack">
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <Field label="Password">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
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
