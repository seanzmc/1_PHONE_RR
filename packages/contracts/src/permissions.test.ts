import { describe, it, expect } from 'vitest'
import { hasPermission } from './permissions'

describe('hasPermission', () => {
  it('ADMIN has every permission', () => {
    const all = [
      'board.view', 'lead.assign', 'lead.skip', 'lead.void', 'lead.assign.override',
      'rep.override', 'schedule.manage', 'activity.self', 'reactivation.review',
      'reactivation.self', 'audit.view', 'user.manage', 'admin.*',
    ] as const
    for (const p of all) expect(hasPermission('ADMIN', p)).toBe(true)
  })

  it('MANAGER can override/reassign but not admin.*', () => {
    expect(hasPermission('MANAGER', 'lead.assign.override')).toBe(true)
    expect(hasPermission('MANAGER', 'rep.override')).toBe(true)
    expect(hasPermission('MANAGER', 'admin.*')).toBe(false)
  })

  it('MANAGER and ADMIN can manage user accounts, BDC and REP cannot', () => {
    expect(hasPermission('ADMIN', 'user.manage')).toBe(true)
    expect(hasPermission('MANAGER', 'user.manage')).toBe(true)
    expect(hasPermission('BDC', 'user.manage')).toBe(false)
    expect(hasPermission('REP', 'user.manage')).toBe(false)
  })

  it('BDC can assign, skip and void but not override or rep status', () => {
    expect(hasPermission('BDC', 'lead.assign')).toBe(true)
    expect(hasPermission('BDC', 'lead.skip')).toBe(true)
    expect(hasPermission('BDC', 'lead.void')).toBe(true)
    expect(hasPermission('BDC', 'lead.assign.override')).toBe(false)
    expect(hasPermission('BDC', 'rep.override')).toBe(false)
  })

  it('REP can only view board (self), log own activity, and self-reactivate', () => {
    expect(hasPermission('REP', 'activity.self')).toBe(true)
    expect(hasPermission('REP', 'reactivation.self')).toBe(true)
    expect(hasPermission('REP', 'lead.assign')).toBe(false)
    expect(hasPermission('REP', 'lead.skip')).toBe(false)
    expect(hasPermission('REP', 'reactivation.review')).toBe(false)
  })
})
