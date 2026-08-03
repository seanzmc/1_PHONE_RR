import { describe, expect, it } from 'vitest'
import { managerStatusBlocksSystemWrite, managerStatusSkipsActivityEvaluation } from './statusAuthority'

describe('manager/system status authority', () => {
  const active = { status: 'ELIGIBLE', decidedBy: 'MANAGER_OVERRIDE' } as const
  const inactive = { status: 'INELIGIBLE', decidedBy: 'MANAGER_OVERRIDE' } as const

  it('allows failing evidence to replace manager-active', () => {
    expect(managerStatusBlocksSystemWrite(active, 'INELIGIBLE', 'ACTIVITY')).toBe(false)
    expect(managerStatusSkipsActivityEvaluation(active)).toBe(false)
  })

  it('does not let passing activity or non-activity writes replace manager-active', () => {
    expect(managerStatusBlocksSystemWrite(active, 'ELIGIBLE', 'ACTIVITY')).toBe(true)
    expect(managerStatusBlocksSystemWrite(active, 'INELIGIBLE', 'OTHER')).toBe(true)
  })

  it('never lets system evaluation reactivate manager-inactive', () => {
    expect(managerStatusBlocksSystemWrite(inactive, 'ELIGIBLE', 'ACTIVITY')).toBe(true)
    expect(managerStatusBlocksSystemWrite(inactive, 'INELIGIBLE', 'ACTIVITY')).toBe(true)
    expect(managerStatusSkipsActivityEvaluation(inactive)).toBe(true)
  })

  it('does not block rows decided by SYSTEM or missing rows', () => {
    expect(managerStatusBlocksSystemWrite({ status: 'ELIGIBLE', decidedBy: 'SYSTEM' }, 'INELIGIBLE', 'ACTIVITY')).toBe(false)
    expect(managerStatusBlocksSystemWrite(undefined, 'INELIGIBLE', 'ACTIVITY')).toBe(false)
  })
})
