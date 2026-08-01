import { describe, expect, it } from 'vitest'
import {
  changePasswordFields,
  VOLUNTARY_PASSWORD_SUCCESS,
} from './changePasswordLogic'

describe('ChangePassword', () => {
  it('removes the temporary-password field from forced first-login setup', () => {
    expect(changePasswordFields(true)).toEqual(['new', 'confirm'])
    expect(changePasswordFields(false)).toEqual(['current', 'new', 'confirm'])
  })

  it('defines visible voluntary success confirmation', () => {
    expect(VOLUNTARY_PASSWORD_SUCCESS).toBe('Password changed successfully.')
  })
})
