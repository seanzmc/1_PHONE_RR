import { describe, it, expect } from 'vitest'
import { hasPermission } from './permissions'

describe('hasPermission', () => {
  it('ADMIN has every permission', () => {
    const all = [
      'board.view', 'lead.assign', 'lead.void', 'lead.assign.override',
      'rep.override', 'schedule.manage', 'activity.self', 'reactivation.review',
      'reactivation.self', 'audit.view', 'admin.*',
    ] as const
    for (const p of all) expect(hasPermission('ADMIN', p)).toBe(true)
  })

  it('MANAGER can override/reassign but not admin.*', () => {
    expect(hasPermission('MANAGER', 'lead.assign.override')).toBe(true)
    expect(hasPermission('MANAGER', 'rep.override')).toBe(true)
    expect(hasPermission('MANAGER', 'admin.*')).toBe(false)
  })

  it('BDC can assign/void but not override or rep status', () => {
    expect(hasPermission('BDC', 'lead.assign')).toBe(true)
    expect(hasPermission('BDC', 'lead.void')).toBe(true)
    expect(hasPermission('BDC', 'lead.assign.override')).toBe(false)
    expect(hasPermission('BDC', 'rep.override')).toBe(false)
  })

  it('REP can only view board (self), log own activity, and self-reactivate', () => {
    expect(hasPermission('REP', 'activity.self')).toBe(true)
    expect(hasPermission('REP', 'reactivation.self')).toBe(true)
    expect(hasPermission('REP', 'lead.assign')).toBe(false)
    expect(hasPermission('REP', 'reactivation.review')).toBe(false)
  })
})
