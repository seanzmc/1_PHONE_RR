import { describe, expect, it } from 'vitest'
import {
  assignEnterAction,
  assignFormErrors,
  bucketRoster,
  canSubmitSkip,
  canSubmitWithRoster,
  formatAssignmentTime,
  formatPhone,
  hasAssignmentDraft,
  hasSkipDraft,
  resolveSkipReason,
  resultGuidance,
  shouldConfirmDrawerClose,
  sortServedForDisplay,
} from './model'

type Entry = Parameters<typeof bucketRoster>[0][number]

function entry(over: Partial<Entry> & { repId: string }): Entry {
  return {
    displayName: over.repId,
    isEligible: true,
    servedThisCycle: false,
    monthlyLoad: 0,
    lastAssignedAt: null,
    rotationSeed: 0,
    decidedBy: null,
    servedAt: null,
    skippedThisCycle: false,
    ...over,
  }
}

describe('bucketRoster', () => {
  it('puts the first eligible unserved rep in Next Up and the rest On Deck', () => {
    const { nextUp, onDeck } = bucketRoster([entry({ repId: 'a' }), entry({ repId: 'b' }), entry({ repId: 'c' })])
    expect(nextUp?.repId).toBe('a')
    expect(onDeck.map((row) => row.repId)).toEqual(['b', 'c'])
  })

  it('keeps served reps OUT of On Deck — the leak this replaces', () => {
    const { nextUp, onDeck, served } = bucketRoster([
      entry({ repId: 'unserved' }),
      entry({ repId: 'alreadyServed', servedThisCycle: true, monthlyLoad: 3 }),
    ])
    expect(nextUp?.repId).toBe('unserved')
    expect(onDeck).toEqual([])
    expect(served.map((row) => row.repId)).toEqual(['alreadyServed'])
    expect(served[0].monthlyLoad).toBe(3)
  })

  it('is non-leaky: every rep lands in exactly one bucket', () => {
    const roster = [
      entry({ repId: 'a' }),
      entry({ repId: 'b' }),
      entry({ repId: 'c', servedThisCycle: true }),
      entry({ repId: 'd', isEligible: false, ineligibleReason: 'day off' }),
      entry({ repId: 'e', isEligible: false, servedThisCycle: true, ineligibleReason: 'WEEK_DQ' }),
    ]
    const { nextUp, onDeck, served, unavailable } = bucketRoster(roster)
    const ids = [
      ...(nextUp ? [nextUp.repId] : []),
      ...onDeck.map((row) => row.repId),
      ...served.map((row) => row.repId),
      ...unavailable.map((row) => row.repId),
    ]
    expect(ids.length).toBe(roster.length)
    expect(new Set(ids).size).toBe(roster.length)
  })

  it('an ineligible rep is Unavailable even if they were served this cycle', () => {
    const { served, unavailable } = bucketRoster([
      entry({ repId: 'dq', isEligible: false, servedThisCycle: true, ineligibleReason: 'WEEK_DQ' }),
    ])
    expect(served).toEqual([])
    expect(unavailable.map((row) => row.repId)).toEqual(['dq'])
  })

  it('handles an all-served cycle with no Next Up', () => {
    const { nextUp, onDeck, served } = bucketRoster([
      entry({ repId: 'a', servedThisCycle: true }),
      entry({ repId: 'b', servedThisCycle: true }),
    ])
    expect(nextUp).toBeNull()
    expect(onDeck).toEqual([])
    expect(served.length).toBe(2)
  })
})

describe('sortServedForDisplay', () => {
  it('puts skipped reps first, then keeps each served subgroup chronological', () => {
    const served = sortServedForDisplay([
      entry({ repId: 'normal-late', servedThisCycle: true, servedAt: '2026-08-01T14:00:00Z' }),
      entry({ repId: 'skipped-late', servedThisCycle: true, skippedThisCycle: true, servedAt: '2026-08-01T13:00:00Z' }),
      entry({ repId: 'normal-early', servedThisCycle: true, servedAt: '2026-08-01T12:00:00Z' }),
      entry({ repId: 'skipped-early', servedThisCycle: true, skippedThisCycle: true, servedAt: '2026-08-01T11:00:00Z' }),
    ])
    expect(served.map((row) => row.repId)).toEqual(['skipped-early', 'skipped-late', 'normal-early', 'normal-late'])
  })
})

describe('assignFormErrors', () => {
  it('requires a non-blank customer name', () => {
    expect(assignFormErrors('', '5551234567').name).toBeTruthy()
    expect(assignFormErrors('   ', '5551234567').name).toBeTruthy()
    expect(assignFormErrors('Jane Doe', '5551234567').name).toBeUndefined()
  })

  it('accepts 10 digits, or 11 starting with 1 — the shapes toE164 can normalize', () => {
    expect(assignFormErrors('Jane', '5551234567').phone).toBeUndefined()
    expect(assignFormErrors('Jane', '(555) 123-4567').phone).toBeUndefined()
    expect(assignFormErrors('Jane', '15551234567').phone).toBeUndefined()
    expect(assignFormErrors('Jane', '+1 (555) 123-4567').phone).toBeUndefined()
  })

  it('rejects anything else before it can become a server-side Zod blob', () => {
    expect(assignFormErrors('Jane', '').phone).toBeTruthy()
    expect(assignFormErrors('Jane', '555123456').phone).toBeTruthy()
    expect(assignFormErrors('Jane', '25551234567').phone).toBeTruthy()
  })
})

describe('assignEnterAction', () => {
  it('steps through name, phone and notes before assigning', () => {
    expect(assignEnterAction('name')).toBe('phone')
    expect(assignEnterAction('phone')).toBe('notes')
    expect(assignEnterAction('notes')).toBe('assign')
  })
})

describe('canSubmitWithRoster', () => {
  it('blocks assignment until the first roster request succeeds', () => {
    expect(canSubmitWithRoster(true, false)).toBe(false)
    expect(canSubmitWithRoster(true, true)).toBe(true)
    expect(canSubmitWithRoster(false, true)).toBe(false)
  })

  it('blocks repeated submissions while an assignment is in flight', () => {
    expect(canSubmitWithRoster(true, true, true)).toBe(false)
    expect(canSubmitWithRoster(true, true, false)).toBe(true)
  })

  it('blocks assignment while an admin is viewing another profile', () => {
    expect(canSubmitWithRoster(true, true, false, true)).toBe(false)
  })
})

describe('skip confirmation guard', () => {
  it('requires a reason and blocks repeated submissions while one skip is in flight', () => {
    expect(canSubmitSkip('', false, false)).toBe(false)
    expect(canSubmitSkip('   ', false, false)).toBe(false)
    expect(canSubmitSkip('Rep stepped away', true, false)).toBe(false)
    expect(canSubmitSkip('Rep stepped away', false, true)).toBe(false)
    expect(canSubmitSkip('Rep stepped away', false, false)).toBe(true)
  })
})

describe('skip reason', () => {
  it('requires detail only for Other skip reasons', () => {
    expect(resolveSkipReason('Rep unavailable', '')).toBe('Rep unavailable')
    expect(resolveSkipReason('Other', '')).toBeNull()
    expect(resolveSkipReason('Other', 'Rep is in training')).toBe('Other: Rep is in training')
  })
})

describe('drawer draft guards', () => {
  it('treats only non-whitespace assignment input as a draft', () => {
    expect(hasAssignmentDraft('   ', '\n', '\t')).toBe(false)
    expect(hasAssignmentDraft('Kev Tom', '', '')).toBe(true)
    expect(hasAssignmentDraft('', '3015550142', '')).toBe(true)
    expect(hasAssignmentDraft('', '', 'Call after 3')).toBe(true)
  })

  it('protects only a started inline Skip editor', () => {
    expect(hasSkipDraft(false, 'Rep unavailable', 'detail')).toBe(false)
    expect(hasSkipDraft(true, null, '   ')).toBe(false)
    expect(hasSkipDraft(true, 'Rep unavailable', '')).toBe(true)
    expect(hasSkipDraft(true, null, 'Rep is in training')).toBe(true)
  })

  it('does not warn for a saved result unless a Skip draft is active', () => {
    expect(shouldConfirmDrawerClose({
      formActive: false,
      name: 'already submitted',
      phone: '3015550142',
      notes: 'already submitted',
      skipOpen: false,
      skipPreset: null,
      skipOtherDetail: '',
    })).toBe(false)
  })
})

describe('assignment result guidance', () => {
  it('shows the authoritative Eastern assignment time', () => {
    expect(formatAssignmentTime('2026-08-01T14:05:00.000Z')).toBe('10:05 AM')
  })

  it('formats the customer phone for the confirmation without copying it', () => {
    expect(formatPhone('+13015550142')).toBe('(301) 555-0142')
  })

  it('gives an actionable duplicate-number next step', () => {
    expect(resultGuidance({ assignedRepId: 'rep-1', duplicatePhone: true })).toContain(
      'Confirm the customer details and tell the rep this may be a duplicate before continuing.',
    )
  })

  it('explains that an unassigned lead was preserved and what to do next', () => {
    expect(resultGuidance({ assignedRepId: null, duplicatePhone: false })).toContain(
      'The lead is saved in the unassigned queue. Keep the customer on the line and contact a Manager.',
    )
  })
})
