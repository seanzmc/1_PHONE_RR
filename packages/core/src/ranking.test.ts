import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { rankReps, type RepRankInput } from './ranking'

function rep(overrides: Partial<RepRankInput>): RepRankInput {
  return {
    repId: 'r0',
    isEligible: true,
    servedThisCycle: false,
    monthlyLoad: 0,
    lastAssignedAt: null,
    rotationSeed: 0,
    ...overrides,
  }
}

describe('rankReps', () => {
  it('puts eligible reps before ineligible regardless of other fields', () => {
    const out = rankReps([
      rep({ repId: 'a', isEligible: false, monthlyLoad: 0 }),
      rep({ repId: 'b', isEligible: true, monthlyLoad: 99 }),
    ])
    expect(out.map((r) => r.repId)).toEqual(['b', 'a'])
  })

  it('within eligibility tier, unserved-this-cycle ranks before served', () => {
    const out = rankReps([
      rep({ repId: 'a', servedThisCycle: true }),
      rep({ repId: 'b', servedThisCycle: false }),
    ])
    expect(out.map((r) => r.repId)).toEqual(['b', 'a'])
  })

  it('uses the preceding served order before monthly load when a new cycle opens', () => {
    const out = rankReps([
      rep({ repId: 'first-served', priorCycleOrder: 0, monthlyLoad: 99 }),
      rep({ repId: 'second-served', priorCycleOrder: 1, monthlyLoad: 0 }),
    ])
    expect(out.map((r) => r.repId)).toEqual(['first-served', 'second-served'])
  })

  it('ranks a rep with no preceding position ahead of one that has one', () => {
    // Out sick / reactivated / newly hired / voided: they never took a turn last cycle,
    // so they take the next one. Ranking them last would be permanent.
    const out = rankReps([
      rep({ repId: 'served-first-last-cycle', priorCycleOrder: 0, monthlyLoad: 0 }),
      rep({ repId: 'missed-last-cycle', monthlyLoad: 99 }),
    ])
    expect(out.map((r) => r.repId)).toEqual(['missed-last-cycle', 'served-first-last-cycle'])
  })

  it('then by lower monthly load when there is no preceding served order', () => {
    const out = rankReps([
      rep({ repId: 'a', monthlyLoad: 5 }),
      rep({ repId: 'b', monthlyLoad: 2 }),
    ])
    expect(out.map((r) => r.repId)).toEqual(['b', 'a'])
  })

  it('then by earlier / null lastAssignedAt (null = never assigned = first)', () => {
    const out = rankReps([
      rep({ repId: 'a', lastAssignedAt: '2026-01-10T00:00:00Z' }),
      rep({ repId: 'b', lastAssignedAt: null }),
    ])
    expect(out.map((r) => r.repId)).toEqual(['b', 'a'])
  })

  it('then by rotationSeed, then repId as final tiebreak', () => {
    const out = rankReps([
      rep({ repId: 'b', rotationSeed: 1 }),
      rep({ repId: 'a', rotationSeed: 1 }),
    ])
    expect(out.map((r) => r.repId)).toEqual(['a', 'b'])
  })

  it('is deterministic regardless of input order', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            repId: fc.string({ minLength: 1 }),
            isEligible: fc.boolean(),
            servedThisCycle: fc.boolean(),
            monthlyLoad: fc.integer({ min: 0, max: 50 }),
            lastAssignedAt: fc.option(fc.constant('2026-01-01T00:00:00Z'), { nil: null }),
            rotationSeed: fc.integer({ min: 0, max: 10 }),
          }),
          { minLength: 2, maxLength: 8 },
        ),
        (reps) => {
          const uniqueIds = reps.map((r, i) => ({ ...r, repId: `${r.repId}-${i}` }))
          const a = rankReps(uniqueIds)
          const b = rankReps([...uniqueIds].reverse())
          expect(a.map((r) => r.repId)).toEqual(b.map((r) => r.repId))
        },
      ),
    )
  })
})
