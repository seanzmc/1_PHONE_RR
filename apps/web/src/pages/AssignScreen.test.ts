import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import * as AssignScreenModule from './AssignScreen'
import type { RosterEntry } from './assignment/model'

function entry(over: Partial<RosterEntry> & { repId: string }): RosterEntry {
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

describe('RosterRepName', () => {
  it('renders the Next Up rep as the same drill-down button used by every other roster bucket', () => {
    const RosterRepName = (AssignScreenModule as any).RosterRepName
    expect(RosterRepName).toBeTypeOf('function')
    const html = renderToStaticMarkup(
      createElement(RosterRepName, {
        entry: entry({ repId: 'david', displayName: 'David Johnson' }),
        onOpenRep: () => {},
      }),
    )
    expect(html).toContain('<button')
    expect(html).toContain('David Johnson')
  })
})
