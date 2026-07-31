import { describe, expect, it } from 'vitest'
import { isOverrideNoOp, noOpReason } from '@phoneup/core/override-no-op'

describe('browser-safe core entrypoint', () => {
  it('exposes status override helpers without loading server-only exports', () => {
    expect(isOverrideNoOp('FORCE_ACTIVE', { isEligible: true, decidedBy: 'MANAGER_OVERRIDE' })).toBe(true)
    expect(noOpReason('FORCE_ACTIVE')).toContain('active')
  })
})
