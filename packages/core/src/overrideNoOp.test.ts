import { describe, it, expect } from 'vitest'
import { isOverrideNoOp, noOpReason, type CurrentRepStatus } from './overrideNoOp'

const eligible: CurrentRepStatus = { isEligible: true, decidedBy: 'SYSTEM' }
const ineligibleBySystem: CurrentRepStatus = { isEligible: false, decidedBy: 'SYSTEM' }
const ineligibleByManager: CurrentRepStatus = { isEligible: false, decidedBy: 'MANAGER_OVERRIDE' }
const eligibleByManager: CurrentRepStatus = { isEligible: true, decidedBy: 'MANAGER_OVERRIDE' }
const noRow: CurrentRepStatus = { isEligible: false, decidedBy: null }

describe('isOverrideNoOp', () => {
  it('cannot reactivate a rep who is already eligible', () => {
    expect(isOverrideNoOp('FORCE_ACTIVE', eligible)).toBe(true)
    expect(isOverrideNoOp('FORCE_ACTIVE', eligibleByManager)).toBe(true)
  })

  it('can reactivate a rep who is ineligible, whoever decided it', () => {
    expect(isOverrideNoOp('FORCE_ACTIVE', ineligibleBySystem)).toBe(false)
    expect(isOverrideNoOp('FORCE_ACTIVE', ineligibleByManager)).toBe(false)
  })

  it('cannot deactivate a rep who already reads as ineligible', () => {
    // Including a rep who is only out because it is their scheduled day off: the
    // rule is on the visible status, so they are suspended the next day they are in.
    expect(isOverrideNoOp('FORCE_INACTIVE', ineligibleBySystem)).toBe(true)
    expect(isOverrideNoOp('FORCE_INACTIVE', ineligibleByManager)).toBe(true)
  })

  it('can deactivate an eligible rep', () => {
    expect(isOverrideNoOp('FORCE_INACTIVE', eligible)).toBe(false)
  })

  it('can only follow schedule when there is a manager override to release', () => {
    expect(isOverrideNoOp('FOLLOW_SCHEDULE', ineligibleByManager)).toBe(false)
    expect(isOverrideNoOp('FOLLOW_SCHEDULE', eligibleByManager)).toBe(false)
    expect(isOverrideNoOp('FOLLOW_SCHEDULE', eligible)).toBe(true)
    expect(isOverrideNoOp('FOLLOW_SCHEDULE', ineligibleBySystem)).toBe(true)
  })

  it('treats a rep with no status row as ineligible, matching what the board shows', () => {
    expect(isOverrideNoOp('FORCE_ACTIVE', noRow)).toBe(false)
    expect(isOverrideNoOp('FORCE_INACTIVE', noRow)).toBe(true)
    expect(isOverrideNoOp('FOLLOW_SCHEDULE', noRow)).toBe(true)
  })
})

describe('noOpReason', () => {
  it('explains each disabled button', () => {
    expect(noOpReason('FORCE_ACTIVE')).toBe('Already active')
    expect(noOpReason('FORCE_INACTIVE')).toBe('Already inactive')
    expect(noOpReason('FOLLOW_SCHEDULE')).toBe('No manager override to release')
  })
})
