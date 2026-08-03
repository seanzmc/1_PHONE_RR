import { describe, expect, it } from 'vitest'
import { bulkSetDaysOffInputSchema } from './schemas'

const repA = '11111111-1111-4111-8111-111111111111'
const repB = '22222222-2222-4222-8222-222222222222'

describe('bulkSetDaysOffInputSchema', () => {
  it('accepts complete values for multiple unique reps', () => {
    expect(bulkSetDaysOffInputSchema.safeParse({
      changes: [{ repId: repA, daysOfWeek: [3] }, { repId: repB, daysOfWeek: [] }],
    }).success).toBe(true)
  })

  it('rejects duplicate reps, empty/oversized batches, invalid ids, and invalid weekdays', () => {
    expect(bulkSetDaysOffInputSchema.safeParse({ changes: [] }).success).toBe(false)
    expect(bulkSetDaysOffInputSchema.safeParse({ changes: [
      { repId: repA, daysOfWeek: [2] }, { repId: repA, daysOfWeek: [3] },
    ] }).success).toBe(false)
    expect(bulkSetDaysOffInputSchema.safeParse({ changes: [{ repId: 'bad', daysOfWeek: [2] }] }).success).toBe(false)
    expect(bulkSetDaysOffInputSchema.safeParse({ changes: [{ repId: repA, daysOfWeek: [7] }] }).success).toBe(false)
    expect(bulkSetDaysOffInputSchema.safeParse({ changes: Array.from({ length: 201 }, (_, i) => ({
      repId: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, daysOfWeek: [],
    })) }).success).toBe(false)
  })
})
