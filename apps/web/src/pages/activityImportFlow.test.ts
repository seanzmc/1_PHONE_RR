import { describe, expect, it } from 'vitest'
import {
  activityImportFileSizeAllowed,
  decisionActions,
  priorEasternBusinessDate,
  progressForPhase,
} from './activityImportFlow'

describe('activity import UI flow', () => {
  it('presents all three outcomes explicitly after preview', () => {
    expect(decisionActions(23)).toEqual([
      { id: 'LOG_AND_DEACTIVATE', label: 'Yes — log numbers & deactivate 23' },
      { id: 'LOG_ONLY', label: 'No — log numbers only' },
      { id: 'CANCEL', label: 'Cancel entire import' },
    ])
  })

  it('uses indeterminate progress only while the server is doing opaque work', () => {
    expect(progressForPhase('reading')).toMatchObject({ value: 15, label: 'Reading report…' })
    expect(progressForPhase('previewing')).toEqual({
      value: undefined,
      label: 'Matching reps and calculating eligibility…',
    })
    expect(progressForPhase('decision')).toMatchObject({ value: 100 })
    expect(progressForPhase('committing', 'LOG_ONLY')).toEqual({
      value: undefined,
      label: 'Saving activity numbers…',
    })
    expect(progressForPhase('committing', 'LOG_AND_DEACTIVATE')).toEqual({
      value: undefined,
      label: 'Saving activity and applying deactivations…',
    })
    expect(progressForPhase('done')).toMatchObject({ value: 100, label: 'Complete' })
  })

  it('calculates the prior Eastern date without reparsing it in the browser timezone', () => {
    // 02:30 UTC is still 10:30 PM on July 29 in New York. The prior report date is July 28,
    // regardless of whether the browser itself is in Pacific, Eastern, or another timezone.
    expect(priorEasternBusinessDate(new Date('2026-07-30T02:30:00Z'))).toBe('2026-07-28')
    expect(priorEasternBusinessDate(new Date('2026-07-30T04:30:00Z'))).toBe('2026-07-29')
  })

  it('rejects an oversized report before the browser reads it', () => {
    expect(activityImportFileSizeAllowed(5_000_000)).toBe(true)
    expect(activityImportFileSizeAllowed(5_000_001)).toBe(false)
  })
})
