import { describe, expect, it } from 'vitest'
import { loginErrorCopy } from './Login'

describe('loginErrorCopy', () => {
  it('turns invalid credentials into actionable support guidance', () => {
    expect(loginErrorCopy('invalid credentials')).toBe(
      'Email or password didn’t match — passwords are case-sensitive.',
    )
  })

  it('pluralizes throttle windows in plain language', () => {
    expect(loginErrorCopy('too many failed attempts — try again in 1 minute(s)')).toBe(
      'Too many failed attempts — try again in about 1 minute.',
    )
    expect(loginErrorCopy('too many failed attempts — try again in 3 minute(s)')).toBe(
      'Too many failed attempts — try again in about 3 minutes.',
    )
  })

  it('hides an unknown server message', () => {
    expect(loginErrorCopy('service unavailable')).toBe('We couldn’t sign you in. Try again.')
  })
})
