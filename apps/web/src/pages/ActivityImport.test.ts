import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  ActivityImportComplete,
  ActivityImportSummary,
  staffListFollowUp,
  type ImportResult,
} from './ActivityImport'

const result: ImportResult = {
  businessDate: '2026-08-06',
  rowsParsed: 8,
  repsMatched: 4,
  repsMissingFromFile: ['Taylor Morgan', 'Jordan Lee'],
  unmatchedNames: ['Tayler Morgan'],
  manualRowsPreserved: ['Alex Kim'],
  statusDate: '2026-08-07',
  minCallsRequired: 20,
  eligibleRepsCount: 2,
  eligibleReps: [],
  ineligibleReps: [],
  notEvaluatedReps: [{ repId: 'rep-sam', displayName: 'Sam Doe', reason: 'No prior shift' }],
  previewToken: 'token',
  decision: 'LOG_AND_DEACTIVATE',
  deactivatedCount: 2,
}

describe('Activity Import presentation', () => {
  it('explains missing, unmatched, and preserved rows separately with exact manager language', () => {
    const markup = renderToStaticMarkup(createElement(ActivityImportSummary, { summary: result, committed: true }))

    expect(markup).toContain('Reps missing from report')
    expect(markup).toContain('>No numbers found</span>')
    expect(markup).toContain(
      "This file had no activity numbers for these reps. The import records 0 unless a hand-entered correction already exists; correct their activity on the rep&#x27;s page if they worked:",
    )
    expect(markup).toContain('Taylor Morgan, Jordan Lee')
    expect(markup).toContain('Names not matched to staff')
    expect(markup).toContain('>Not imported</span>')
    expect(markup).toContain('These report names did not match a Staff List display name. Check the spelling:')
    expect(markup).toContain('Tayler Morgan')
    expect(markup).toContain('Hand-entered corrections kept')
    expect(markup).toContain('This file did not overwrite saved corrections for:')
    expect(markup).toContain('Alex Kim')
    expect(markup).toContain('Not evaluated')
    expect(markup).toContain('Sam Doe: No prior shift')
  })

  it('keeps each zero-result outcome as its own row with a dash', () => {
    const zeroResult = {
      ...result,
      repsMissingFromFile: [],
      unmatchedNames: [],
      manualRowsPreserved: [],
      notEvaluatedReps: [],
    }
    const markup = renderToStaticMarkup(createElement(ActivityImportSummary, { summary: zeroResult, committed: false }))

    for (const label of [
      'Reps missing from report',
      'Names not matched to staff',
      'Not evaluated',
      'Hand-entered corrections kept',
    ]) {
      expect(markup).toContain(label)
    }
    expect(markup.match(/>—<\/span>/g)).toHaveLength(4)
  })

  it('offers Staff List only after a committed nonzero deactivation and invokes it', () => {
    const onOpenStaff = vi.fn()
    const onReset = vi.fn()
    const markup = renderToStaticMarkup(
      createElement(ActivityImportComplete, { result, onOpenStaff, onReset }),
    )

    expect(markup).toContain('Suspensions run through Saturday. To reactivate someone early, open the Staff List.')
    expect(markup).toContain('>Open Staff List</button>')
    expect(markup).toContain('>Process another report</button>')
    staffListFollowUp(result, onOpenStaff)?.()
    expect(onOpenStaff).toHaveBeenCalledOnce()
    expect(onReset).not.toHaveBeenCalled()

    for (const hiddenResult of [
      { ...result, decision: 'LOG_ONLY' as const, deactivatedCount: 2 },
      { ...result, deactivatedCount: 0 },
    ]) {
      const hiddenMarkup = renderToStaticMarkup(
        createElement(ActivityImportComplete, { result: hiddenResult, onOpenStaff, onReset }),
      )
      expect(hiddenMarkup).not.toContain('Suspensions run through Saturday')
      expect(hiddenMarkup).not.toContain('Open Staff List')
      expect(hiddenMarkup).toContain('Process another report')
      expect(staffListFollowUp(hiddenResult, onOpenStaff)).toBeUndefined()
    }
  })
})