import { describe, expect, it } from 'vitest'
import {
  activityImportPreviewInputSchema,
  activityImportCommitInputSchema,
  setMetricInputSchema,
} from './schemas'

const base = {
  csv: 'report contents',
  businessDate: '2026-07-29',
}

describe('activity import decision schemas', () => {
  it('preview accepts only the report and its explicit business date', () => {
    expect(activityImportPreviewInputSchema.parse(base)).toEqual(base)
    expect(() =>
      activityImportPreviewInputSchema.parse({ csv: '', businessDate: '07/29/2026' }),
    ).toThrow()
    expect(() =>
      activityImportPreviewInputSchema.parse({ csv: 'report', businessDate: '2026-02-31' }),
    ).toThrow()
  })

  it('commit allows exactly the two explicit save decisions', () => {
    const commitBase = {
      ...base,
      statusDate: '2026-07-30',
      previewToken: 'a'.repeat(128),
    }
    expect(
      activityImportCommitInputSchema.parse({ ...commitBase, decision: 'LOG_ONLY' }).decision,
    ).toBe('LOG_ONLY')
    expect(
      activityImportCommitInputSchema.parse({ ...commitBase, decision: 'LOG_AND_DEACTIVATE' }).decision,
    ).toBe('LOG_AND_DEACTIVATE')
    expect(() =>
      activityImportCommitInputSchema.parse({ ...commitBase, decision: 'CANCEL' }),
    ).toThrow()
    expect(() =>
      activityImportCommitInputSchema.parse({
        ...commitBase,
        previewToken: `${commitBase.previewToken}\n`,
        decision: 'LOG_ONLY',
      }),
    ).toThrow()
  })

  it('keeps manual activity corrections within the PostgreSQL integer range', () => {
    const correction = {
      repId: '00000000-0000-4000-8000-000000000001',
      businessDate: '2026-07-29',
      reasonNote: 'verified correction',
    }
    expect(setMetricInputSchema.parse({ ...correction, calls: 2_147_483_647 }).calls).toBe(2_147_483_647)
    expect(() => setMetricInputSchema.parse({ ...correction, calls: 2_147_483_648 })).toThrow()
    expect(() => setMetricInputSchema.parse({ ...correction, sold: 2_147_483_648 })).toThrow()
  })
})
