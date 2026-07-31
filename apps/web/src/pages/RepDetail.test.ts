import { describe, it, expect } from 'vitest'
import { formatStatusReason, todayStatusMessage } from './RepDetail'

describe('formatStatusReason', () => {
  it('labels bare shift-kind reasons', () => {
    expect(formatStatusReason('off')).toBe('Scheduled day off')
    expect(formatStatusReason('pto')).toBe('PTO day')
    expect(formatStatusReason('sick')).toBe('Sick day')
  })

  it('translates the WEEK_DQ prefix but keeps the numbers', () => {
    expect(formatStatusReason('WEEK_DQ: 3 calls on 2026-07-30, 10 required')).toBe(
      'Below the call minimum: 3 calls on 2026-07-30, 10 required',
    )
  })

  it('capitalizes anything else without mangling it', () => {
    expect(formatStatusReason('no schedule found for today')).toBe('No schedule found for today')
  })
})

describe('todayStatusMessage', () => {
  it('tells an eligible rep they are in the rotation', () => {
    expect(todayStatusMessage({ isEligible: true, reason: null }, true)).toContain("You're in today's rotation")
    expect(todayStatusMessage({ isEligible: true, reason: null }, false)).toContain("In today's rotation")
  })

  it('points a suspended rep at their manager and names Saturday', () => {
    const msg = todayStatusMessage(
      { isEligible: false, reason: 'WEEK_DQ: 3 calls on 2026-07-30, 10 required' },
      true,
    )
    expect(msg).toContain('suspended through Saturday')
    expect(msg).toContain('Talk to your manager')
  })

  it('points a manager at the Staff List instead', () => {
    const msg = todayStatusMessage(
      { isEligible: false, reason: 'WEEK_DQ: 3 calls on 2026-07-30, 10 required' },
      false,
    )
    expect(msg).toContain('Staff List')
  })

  it('keeps non-DQ absences informational — no false alarm, no Saturday line', () => {
    const msg = todayStatusMessage({ isEligible: false, reason: 'off' }, true)
    expect(msg).toBe('Scheduled day off.')
    expect(msg).not.toContain('Saturday')
  })

  it('has a fallback when no status row exists for today', () => {
    expect(todayStatusMessage({ isEligible: false, reason: null }, true)).toBe('Not evaluated for today yet.')
  })
})
