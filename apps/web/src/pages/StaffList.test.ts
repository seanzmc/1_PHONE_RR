import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useAuthStore } from '../state/authStore'
import * as StaffListModule from './StaffList'
import {
  RecurringDayOffEditor,
  StaffList,
  StaffStatusActions,
  beginLatestResponse,
  commitStaffListDaysOffSave,
  invalidatePendingResponses,
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
  staffTargetName,
} from './StaffList'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

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

describe('Staff List page guidance and sort semantics', () => {
  it('explains the page and empty bulk selection while exposing the active sort state', () => {
    const previousAuth = useAuthStore.getState()
    useAuthStore.setState({
      session: {
        userId: 'admin-1',
        role: 'ADMIN',
        email: 'admin@example.test',
        displayName: 'Admin',
        mustChangePassword: false,
      },
      loading: false,
      viewAsUserId: null,
    })

    try {
      const markup = renderToStaticMarkup(createElement(StaffList))

      expect(markup).toContain(
        'Manage rotation status, availability overrides, and one recurring day off for each rep.',
      )
      expect(markup).toContain(
        'Select reps with the checkboxes to reactivate or deactivate several at once.',
      )
      expect(markup).toContain(
        'Choose None or one recurring day off, Monday through Saturday. Changes are saved together.',
      )
      expect(markup).toContain('aria-sort="ascending"')
      expect(markup).toContain('aria-label="Sort by Rep"')
      expect(markup).toContain('<th><button type="button" class="ui-sortbtn" aria-label="Sort by Status"')
    } finally {
      useAuthStore.setState(previousAuth, true)
    }
  })
})

describe('Staff List row control targets', () => {
  it('uses the rep display name as the accessible target', () => {
    expect(staffTargetName(entry({ repId: 'rep-1', displayName: 'Taylor Reed' }))).toBe('Taylor Reed')
  })

  it('names each status action for its rep while preserving visible labels and no-op titles', () => {
    const markup = renderToStaticMarkup(
      createElement(StaffStatusActions, {
        entry: entry({ repId: 'rep-1', displayName: 'Taylor Reed' }),
        canOverride: true,
        onChoose: () => {},
      }),
    )

    expect(markup).toContain('aria-label="Reactivate Taylor Reed"')
    expect(markup).toContain('aria-label="Deactivate Taylor Reed"')
    expect(markup).toContain('title="Already active"')
    expect(markup).toContain('>Activate</button>')
    expect(markup).toContain('>Deactivate</button>')
  })
})

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

  it('submits only touched active rows that differ from the latest baseline', () => {
    const changesForTouched = changedDayOffRows as unknown as (
      baseline: Record<string, number[]>,
      draft: Record<string, number[]>,
      activeIds: string[],
      touchedIds: string[],
    ) => Array<{ repId: string; daysOfWeek: number[] }>

    expect(changesForTouched(
      { a: [2], untouched: [4], gone: [] },
      { a: [3], untouched: [5], gone: [1] },
      ['a', 'untouched'],
      ['a', 'gone'],
    )).toEqual([
      { repId: 'a', daysOfWeek: [3] },
    ])
  })

  it('preserves touched rows while untouched and newly active rows adopt remote saved values', () => {
    const reconcileTouched = reconcileDayOffDraft as unknown as (
      draft: Record<string, number[]>,
      saved: Record<string, number[]>,
      activeIds: string[],
      touchedIds: string[],
    ) => Record<string, number[]>

    expect(reconcileTouched(
      { touched: [3], untouched: [2], gone: [1] },
      { touched: [4], untouched: [5], added: [6] },
      ['touched', 'untouched', 'added'],
      ['touched', 'gone'],
    )).toEqual({
      touched: [3],
      untouched: [5],
      added: [6],
    })
  })

  it('does not enter edit while the latest day-off baseline is still loading', () => {
    const canEnter = (StaffListModule as unknown as {
      canEnterDayOffEdit?: (input: {
        canManageSchedule: boolean
        daysOffLoaded: boolean
        daysOffRefreshing: boolean
        savingDaysOff: boolean
      }) => boolean
    }).canEnterDayOffEdit

    expect(canEnter?.({
      canManageSchedule: true,
      daysOffLoaded: true,
      daysOffRefreshing: true,
      savingDaysOff: false,
    })).toBe(false)
    expect(canEnter?.({
      canManageSchedule: true,
      daysOffLoaded: true,
      daysOffRefreshing: false,
      savingDaysOff: false,
    })).toBe(true)
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

describe('latest Staff List response guard', () => {
  async function applyRefresh(
    generation: { current: number },
    response: Promise<string>,
    apply: (value: string) => void,
  ) {
    const isLatest = beginLatestResponse(generation)
    const value = await response
    if (isLatest()) apply(value)
  }

  it('does not let an older deferred refresh overwrite a newer refresh', async () => {
    const generation = { current: 0 }
    const older = deferred<string>()
    const newer = deferred<string>()
    let visible = 'initial'

    const olderWork = applyRefresh(generation, older.promise, (value) => { visible = value })
    const newerWork = applyRefresh(generation, newer.promise, (value) => { visible = value })
    newer.resolve('newer refresh')
    await newerWork
    older.resolve('older refresh')
    await olderWork

    expect(visible).toBe('newer refresh')
  })

  it('does not let a deferred pre-save refresh overwrite a successful save', async () => {
    const generation = { current: 0 }
    const pending = deferred<string>()
    let visible = 'initial'

    const pendingWork = applyRefresh(generation, pending.promise, (value) => { visible = value })
    invalidatePendingResponses(generation)
    visible = 'successful save'
    pending.resolve('pre-save refresh')
    await pendingWork

    expect(visible).toBe('successful save')
  })
})

describe('Staff List Save wiring', () => {
  it('uses the current authority refresh after Save resolves instead of the captured callback', async () => {
    const response = deferred<{
      changedRepIds: string[]
      daysOffByRep: Record<string, number[]>
    }>()
    const generation = { current: 4 }
    const events: string[] = []
    const adminRefresh = () => { events.push('stale admin refresh') }
    const viewAsRefresh = () => { events.push('current View-as refresh') }
    const currentRefresh = { current: adminRefresh }

    const saving = commitStaffListDaysOffSave({
      execute: () => response.promise,
      responseGeneration: generation,
      currentRefresh,
      applyResult: () => { events.push('apply response baseline') },
    })
    currentRefresh.current = viewAsRefresh
    response.resolve({ changedRepIds: ['rep-1'], daysOffByRep: { 'rep-1': [3] } })
    await saving

    expect(events).toEqual(['apply response baseline', 'current View-as refresh'])
    expect(generation.current).toBe(5)
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
