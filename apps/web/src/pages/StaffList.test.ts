import { describe, it, expect } from 'vitest'
import { reconcileSelection, splitByNoOp, currentStatusOf } from './StaffList'

type Entry = Parameters<typeof splitByNoOp>[1][number]

function entry(over: Partial<Entry> & { repId: string }): Entry {
  return {
    displayName: over.repId,
    isEligible: true,
    monthlyLoad: 0,
    decidedBy: 'SYSTEM',
    ...over,
  }
}

describe('currentStatusOf', () => {
  it('maps a roster entry onto the shared no-op input', () => {
    expect(currentStatusOf(entry({ repId: 'a', isEligible: false, decidedBy: 'MANAGER_OVERRIDE' }))).toEqual({
      isEligible: false,
      decidedBy: 'MANAGER_OVERRIDE',
    })
  })

  it('carries a missing status row through as null', () => {
    expect(currentStatusOf(entry({ repId: 'a', decidedBy: null }))).toEqual({
      isEligible: true,
      decidedBy: null,
    })
  })
})

describe('reconcileSelection', () => {
  it('keeps ids that are still on the roster', () => {
    const roster = [entry({ repId: 'a' }), entry({ repId: 'b' })]
    expect(reconcileSelection(['a', 'b'], roster)).toEqual(['a', 'b'])
  })

  it('drops ids that vanished from a refreshed roster', () => {
    // The list refreshes on every board realtime event. A stale id left in the
    // selection would silently widen the next batch.
    const roster = [entry({ repId: 'a' })]
    expect(reconcileSelection(['a', 'gone'], roster)).toEqual(['a'])
  })

  it('returns an empty selection when the roster empties', () => {
    expect(reconcileSelection(['a', 'b'], [])).toEqual([])
  })
})

describe('splitByNoOp', () => {
  it('splits a deactivate into the reps it would change and the rest', () => {
    const { applied, skipped } = splitByNoOp('FORCE_INACTIVE', [
      entry({ repId: 'eligible' }),
      entry({ repId: 'alreadyOut', isEligible: false }),
      entry({ repId: 'alsoEligible' }),
    ])
    expect(applied.map((r) => r.repId)).toEqual(['eligible', 'alsoEligible'])
    expect(skipped.map((r) => r.repId)).toEqual(['alreadyOut'])
  })

  it('splits a reactivate the other way', () => {
    const { applied, skipped } = splitByNoOp('FORCE_ACTIVE', [
      entry({ repId: 'eligible' }),
      entry({ repId: 'out', isEligible: false }),
    ])
    expect(applied.map((r) => r.repId)).toEqual(['out'])
    expect(skipped.map((r) => r.repId)).toEqual(['eligible'])
  })

  it('only follows schedule for reps carrying a manager override', () => {
    const { applied, skipped } = splitByNoOp('FOLLOW_SCHEDULE', [
      entry({ repId: 'overridden', isEligible: false, decidedBy: 'MANAGER_OVERRIDE' }),
      entry({ repId: 'systemDecided', isEligible: false, decidedBy: 'SYSTEM' }),
      entry({ repId: 'noRow', decidedBy: null }),
    ])
    expect(applied.map((r) => r.repId)).toEqual(['overridden'])
    expect(skipped.map((r) => r.repId)).toEqual(['systemDecided', 'noRow'])
  })

  it('is non-leaky: every entry lands in exactly one side', () => {
    const entries = [
      entry({ repId: 'a' }),
      entry({ repId: 'b', isEligible: false }),
      entry({ repId: 'c', decidedBy: 'MANAGER_OVERRIDE' }),
    ]
    const { applied, skipped } = splitByNoOp('FORCE_INACTIVE', entries)
    expect(applied.length + skipped.length).toBe(entries.length)
  })
})
