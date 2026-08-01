import { describe, expect, it } from 'vitest'
import { PASSWORD_RECOVERY_SUCCESS } from './PasswordRecovery'

describe('PasswordRecovery', () => {
  it('uses generic success copy that does not reveal account eligibility', () => {
    expect(PASSWORD_RECOVERY_SUCCESS).toBe(
      'If that email belongs to an active PhoneUp account, a reset link is on its way.',
    )
    expect(PASSWORD_RECOVERY_SUCCESS).not.toMatch(/found|registered|exists/i)
  })
})
