import { describe, expect, it, vi } from 'vitest'
import {
  clearResetTokenFromUrl,
  requestAnotherReset,
  resetPasswordValidation,
} from './resetPasswordLogic'

describe('ResetPassword', () => {
  it('validates minimum length and confirmation', () => {
    expect(resetPasswordValidation('', '')).toEqual({ valid: false, tooShort: false, mismatch: false })
    expect(resetPasswordValidation('short', 'short')).toEqual({ valid: false, tooShort: true, mismatch: false })
    expect(resetPasswordValidation('longEnough9', 'different9')).toEqual({ valid: false, tooShort: false, mismatch: true })
    expect(resetPasswordValidation('longEnough9', 'longEnough9')).toEqual({ valid: true, tooShort: false, mismatch: false })
  })

  it('removes the reset token from browser history after success', () => {
    const history = { replaceState: vi.fn() }

    clearResetTokenFromUrl(history)

    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/')
  })

  it('removes an invalid token before opening the request screen', () => {
    const history = { replaceState: vi.fn() }
    const openRecovery = vi.fn()

    requestAnotherReset(history, openRecovery)

    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/')
    expect(openRecovery).toHaveBeenCalledOnce()
  })
})
