import { describe, it, expect } from 'vitest'
import { assignFormErrors, bucketRoster } from './AssignScreen'

type Entry = Parameters<typeof bucketRoster>[0][number]

function entry(over: Partial<Entry> & { repId: string }): Entry {
  return {
    displayName: over.repId,
    isEligible: true,
    servedThisCycle: false,
    monthlyLoad: 0,
    ...over,
  }
}

describe('bucketRoster', () => {
  it('puts the first eligible unserved rep in Next Up and the rest On Deck', () => {
    const { nextUp, onDeck } = bucketRoster([
      entry({ repId: 'a' }),
      entry({ repId: 'b' }),
      entry({ repId: 'c' }),
    ])
    expect(nextUp?.repId).toBe('a')
    expect(onDeck.map((r) => r.repId)).toEqual(['b', 'c'])
  })

  it('keeps served reps OUT of On Deck — the leak this replaces', () => {
    const { nextUp, onDeck, served } = bucketRoster([
      entry({ repId: 'unserved' }),
      entry({ repId: 'alreadyServed', servedThisCycle: true, monthlyLoad: 3 }),
    ])
    expect(nextUp?.repId).toBe('unserved')
    expect(onDeck).toEqual([])
    expect(served.map((r) => r.repId)).toEqual(['alreadyServed'])
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
      ...onDeck.map((r) => r.repId),
      ...served.map((r) => r.repId),
      ...unavailable.map((r) => r.repId),
    ]
    expect(ids.length).toBe(roster.length)
    expect(new Set(ids).size).toBe(roster.length)
  })

  it('an ineligible rep is Unavailable even if they were served this cycle', () => {
    const { served, unavailable } = bucketRoster([
      entry({ repId: 'dq', isEligible: false, servedThisCycle: true, ineligibleReason: 'WEEK_DQ' }),
    ])
    expect(served).toEqual([])
    expect(unavailable.map((r) => r.repId)).toEqual(['dq'])
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
