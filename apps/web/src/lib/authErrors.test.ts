import { describe, expect, it } from 'vitest'
import { authErrorCopy } from './authErrors'

describe('authErrorCopy', () => {
  it('translates login credential and throttle failures', () => {
    expect(authErrorCopy(new Error('invalid credentials'), 'login')).toBe(
      'Email or password didn’t match — passwords are case-sensitive.',
    )
    expect(
      authErrorCopy(new Error('too many failed attempts — try again in 1 minute(s)'), 'login'),
    ).toBe('Too many failed attempts — try again in about 1 minute.')
    expect(
      authErrorCopy(new Error('too many failed attempts — try again in 3 minute(s)'), 'login'),
    ).toBe('Too many failed attempts — try again in about 3 minutes.')
  })

  it('translates current-password and reset-link failures', () => {
    expect(authErrorCopy(new Error('current password is incorrect'), 'change_password')).toBe(
      'Your current password is incorrect. Try again.',
    )
    expect(authErrorCopy(new Error('CURRENT_PASSWORD_REQUIRED'), 'change_password')).toBe(
      'Enter your current password to make this change.',
    )
    expect(authErrorCopy(new Error('RESET_LINK_INVALID_OR_EXPIRED'), 'complete_reset')).toBe(
      'This reset link is invalid, expired, or already used. Request a new link.',
    )
  })

  it('translates recovery throttling and connection failures', () => {
    expect(
      authErrorCopy(
        new Error('Too many password reset requests — try again in 15 minute(s)'),
        'request_reset',
      ),
    ).toBe('Too many reset requests — try again in about 15 minutes.')
    expect(authErrorCopy(new TypeError('Failed to fetch'), 'request_reset')).toBe(
      'Couldn’t contact PhoneUp. Check your connection and try again.',
    )
  })

  it('never exposes unknown server details', () => {
    expect(
      authErrorCopy(new Error('database host secret.internal refused'), 'complete_reset'),
    ).toBe('We couldn’t reset your password. Request a new link and try again.')
    expect(authErrorCopy(new Error('sql exploded'), 'manager_reset')).toBe(
      'We couldn’t update that password. Try again.',
    )
  })
})
