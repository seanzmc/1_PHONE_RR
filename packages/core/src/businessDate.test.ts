import { describe, it, expect } from 'vitest'
import { businessDate, periodKey } from './businessDate'

describe('businessDate', () => {
  it('returns the NY local calendar date for a UTC instant', () => {
    // 2026-01-15 04:30 UTC = 2026-01-14 23:30 EST
    expect(businessDate(new Date('2026-01-15T04:30:00Z'))).toBe('2026-01-14')
  })
  it('rolls to the next day right after local midnight', () => {
    // 2026-01-15 05:30 UTC = 2026-01-15 00:30 EST
    expect(businessDate(new Date('2026-01-15T05:30:00Z'))).toBe('2026-01-15')
  })
  it('handles DST spring-forward day (2026-03-08) without shifting a full day', () => {
    expect(businessDate(new Date('2026-03-08T12:00:00Z'))).toBe('2026-03-08')
  })
})

describe('periodKey', () => {
  it('derives YYYY-MM from a business date', () => {
    expect(periodKey('2026-01-14')).toBe('2026-01')
  })
})
