import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RosterPanel } from './RosterPanel'
import type { RosterEntry } from './model'

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

function renderRoster(over: Partial<Parameters<typeof RosterPanel>[0]> = {}) {
  return renderToStaticMarkup(createElement(RosterPanel, {
    roster: [],
    hasLoadedRoster: true,
    loadError: false,
    onRetry: () => {},
    ...over,
  }))
}

describe('RosterPanel', () => {
  it('uses one Served This Round bucket with badge-only skipped identification', () => {
    const html = renderRoster({
      roster: [
        entry({ repId: 'normal', displayName: 'Normal Rep', servedThisCycle: true, servedAt: '2026-08-01T12:00:00Z' }),
        entry({ repId: 'skipped', displayName: 'Skipped Rep', servedThisCycle: true, skippedThisCycle: true, servedAt: '2026-08-01T13:00:00Z' }),
      ],
    })

    expect(html.match(/Served This Round/g)).toHaveLength(1)
    expect(html.indexOf('Skipped Rep')).toBeLessThan(html.indexOf('Normal Rep'))
    expect(html).toContain('Skipped</span>')
    expect(html).not.toContain('skip reason')
  })

  it('keeps Next Up drill-down, On Deck numbering, and unavailable reasons', () => {
    const html = renderRoster({
      roster: [
        entry({ repId: 'next', displayName: 'Next Rep' }),
        entry({ repId: 'deck', displayName: 'On Deck Rep' }),
        entry({ repId: 'away', displayName: 'Away Rep', isEligible: false, ineligibleReason: 'Day off' }),
      ],
      onOpenRep: () => {},
    })

    expect(html).toContain('<button')
    expect(html).toContain('Next Rep')
    expect(html).toContain('>2</span>')
    expect(html).toContain('On Deck Rep')
    expect(html).toContain('Day off')
  })

  it('distinguishes loading, stale last-good data, and total load failure with Retry', () => {
    expect(renderRoster({ hasLoadedRoster: false, loadError: false })).toContain('Loading roster…')
    expect(renderRoster({ roster: [entry({ repId: 'known' })], loadError: true })).toContain('refresh — showing the last good roster.')
    expect(renderRoster({ hasLoadedRoster: false, loadError: true })).toContain('load the roster — check your connection.')

    const stale = renderRoster({ roster: [entry({ repId: 'known' })], loadError: true })
    const failed = renderRoster({ hasLoadedRoster: false, loadError: true })
    expect(stale).toContain('Retry')
    expect(failed).toContain('Retry')
  })
})
