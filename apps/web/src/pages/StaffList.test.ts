import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  RecurringDayOffEditor,
  reconcileSelection,
  splitByNoOp,
  currentStatusOf,
  reasonNoteFor,
  selectedDayOff,
  dayOffPayload,
  dayOffDisplay,
  changedDayOffRows,
  reconcileDayOffDraft,
  sortRoster,
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

describe('days-off draft helpers', () => {
  it('displays no, one, and ambiguous saved days', () => {
    expect(dayOffDisplay([])).toBe('None')
    expect(dayOffDisplay([3])).toBe('Wed')
    expect(dayOffDisplay([4, 5])).toBe('Thu, Fri — needs correction')
  })

  it('returns only active rows whose draft differs from the baseline', () => {
    expect(changedDayOffRows({ a: [2], b: [] }, { a: [3], b: [] }, ['a', 'b'])).toEqual([
      { repId: 'a', daysOfWeek: [3] },
    ])
  })

  it('keeps active drafts and initializes newly active reps from saved days', () => {
    expect(reconcileDayOffDraft({ a: [3], gone: [2] }, { a: [2], added: [] }, ['a', 'added'])).toEqual({
      a: [3],
      added: [],
    })
  })
})

describe('RecurringDayOffEditor', () => {
  it('renders a compact saved value without edit controls in view mode', () => {
    const markup = renderToStaticMarkup(
      createElement(RecurringDayOffEditor, {
        repId: 'rep-1',
        displayName: 'Taylor Reed',
        days: [3],
        editing: false,
        onChange: () => {},
      }),
    )

    expect(markup).toContain('Wed')
    expect(markup).not.toContain('type="radio"')
  })

  it('renders one accessible seven-choice radio group in edit mode', () => {
    const markup = renderToStaticMarkup(
      createElement(RecurringDayOffEditor, {
        repId: 'rep-1',
        displayName: 'Taylor Reed',
        days: [3],
        editing: true,
        onChange: () => {},
      }),
    )

    expect(markup.match(/type="radio"/g)).toHaveLength(7)
    expect(markup).toContain('role="radiogroup"')
    expect(markup).toContain('aria-label="Recurring day off for Taylor Reed"')
  })

  it('surfaces ambiguous saved values truthfully in view mode', () => {
    const markup = renderToStaticMarkup(
      createElement(RecurringDayOffEditor, {
        repId: 'rep-1',
        displayName: 'Taylor Reed',
        days: [4, 5],
        editing: false,
        onChange: () => {},
      }),
    )

    expect(markup).toContain('Thu, Fri — needs correction')
  })
})

describe('sortRoster', () => {
  const rows = [
    entry({ repId: 'zed', displayName: 'Zed', monthlyLoad: 2, isEligible: false }),
    entry({ repId: 'amy', displayName: 'Amy', monthlyLoad: 8, isEligible: true }),
    entry({ repId: 'bob', displayName: 'Bob', monthlyLoad: 1, isEligible: true }),
  ]

  it('sorts by rep name in either direction without mutating the source', () => {
    expect(sortRoster(rows, 'name', 'asc').map((row) => row.repId)).toEqual(['amy', 'bob', 'zed'])
    expect(sortRoster(rows, 'name', 'desc').map((row) => row.repId)).toEqual(['zed', 'bob', 'amy'])
    expect(rows.map((row) => row.repId)).toEqual(['zed', 'amy', 'bob'])
  })

  it('sorts by rotation status and ups', () => {
    expect(sortRoster(rows, 'status', 'asc').map((row) => row.repId)).toEqual(['amy', 'bob', 'zed'])
    expect(sortRoster(rows, 'ups', 'desc').map((row) => row.repId)).toEqual(['amy', 'zed', 'bob'])
  })
})
