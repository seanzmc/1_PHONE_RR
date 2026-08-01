import { describe, expect, it } from 'vitest'
import { skipLeadInputSchema } from './schemas'

describe('skipLeadInputSchema', () => {
  const input = {
    leadId: '11111111-1111-4111-8111-111111111111',
    expectedRepId: '22222222-2222-4222-8222-222222222222',
    reasonNote: 'Rep stepped away from the floor',
    idempotencyKey: '33333333-3333-4333-8333-333333333333',
  }

  it('requires the current rep, a reason and an idempotency key for a deliberate skip', () => {
    expect(skipLeadInputSchema.safeParse(input).success).toBe(true)
    expect(skipLeadInputSchema.safeParse({ ...input, reasonNote: '   ' }).success).toBe(false)
    expect(skipLeadInputSchema.safeParse({ ...input, expectedRepId: undefined }).success).toBe(false)
    expect(skipLeadInputSchema.safeParse({ ...input, idempotencyKey: 'not-a-uuid' }).success).toBe(false)
  })
})
