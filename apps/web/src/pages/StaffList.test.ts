import { describe, it, expect } from 'vitest'
import {
  reconcileSelection,
  splitByNoOp,
  currentStatusOf,
  reasonNoteFor,
  selectedDayOff,
  dayOffPayload,
} from './StaffList'

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

describe('reasonNoteFor', () => {
  // Regression: reasonNote used to be derived from pendingStatus alone, which is always
  // null while the bulk modal is open (it drives bulkStatus instead). Every non-OTHER
  // preset resolved to '', and the server's z.string().min(1) rejected the mutation.
  it('resolves a non-OTHER preset for the bulk modal (bulkStatus, pendingStatus null)', () => {
    expect(reasonNoteFor('FORCE_INACTIVE', 'PTO', '')).toBe('PTO')
  })

  it('resolves a non-OTHER preset for the per-row modal', () => {
    expect(reasonNoteFor('FORCE_ACTIVE', 'ABSENCE_RESOLVED', '')).toBe('Absence resolved')
  })

  it('uses the typed note for OTHER regardless of target', () => {
    expect(reasonNoteFor('FORCE_INACTIVE', 'OTHER', 'left early')).toBe('left early')
    expect(reasonNoteFor(null, 'OTHER', 'left early')).toBe('left early')
  })

  it('is empty when no modal is open', () => {
    expect(reasonNoteFor(null, 'PTO', '')).toBe('')
  })

  it('is empty when no reason is chosen yet', () => {
    expect(reasonNoteFor('FORCE_INACTIVE', '', '')).toBe('')
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

describe('selectedDayOff', () => {
  it('is null when a rep has no recurring day off', () => {
    expect(selectedDayOff([])).toBe(null)
  })

  it('is the day when a rep has exactly one', () => {
    expect(selectedDayOff([3])).toBe(3)
  })

  it('is AMBIGUOUS when a rep somehow has more than one', () => {
    // Legacy rows, or a direct database write. Rendering one of them would show a
    // schedule the database does not hold and let a stray click discard the other.
    expect(selectedDayOff([4, 5])).toBe('AMBIGUOUS')
  })
})

describe('dayOffPayload', () => {
  it('sends an empty array for None', () => {
    expect(dayOffPayload(null)).toEqual([])
  })

  it('sends a one-element array for a weekday', () => {
    expect(dayOffPayload(3)).toEqual([3])
  })
})
