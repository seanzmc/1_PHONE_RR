import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AssignmentResult,
  canNavigateToRep,
  canOpenVoidShortcut,
  isAssignmentBusy,
} from './AssignmentDrawer'
import type { AssignResult } from './model'

const assignedResult: AssignResult = {
  leadId: 'lead-1',
  assignedRepId: 'rep-raul',
  queueSnapshot: [],
  duplicatePhone: false,
  customerName: 'Kev Tom',
  assignedAt: '2026-08-02T15:00:00.000Z',
}

describe('AssignmentDrawer', () => {
  it('renders a rep-first saved result and no clipboard affordance', () => {
    const html = renderToStaticMarkup(createElement(AssignmentResult, {
      result: assignedResult,
      repName: 'Raul Valle',
      phoneE164: '+13015550142',
      canSkip: true,
      canVoid: true,
      busy: false,
      skipEditorOpen: true,
      onSkip: () => {},
      onVoid: () => {},
    }, createElement('p', null, 'Inline Skip editor')))

    expect(html.indexOf('Raul Valle')).toBeLessThan(html.indexOf('Kev Tom'))
    expect(html).toContain('(301) 555-0142')
    expect(html).toContain('Inline Skip editor')
    expect(html).not.toContain('Void (Alt+V)')
    expect(html).not.toContain('Copy phone')
    expect(html).not.toContain('Alt+C')
  })

  it('treats every assignment mutation as close-blocking', () => {
    expect(isAssignmentBusy(true, false, false)).toBe(true)
    expect(isAssignmentBusy(false, true, false)).toBe(true)
    expect(isAssignmentBusy(false, false, true)).toBe(true)
    expect(isAssignmentBusy(false, false, false)).toBe(false)
  })

  it('does not open Void from Alt+V while a nested confirmation owns focus', () => {
    expect(canOpenVoidShortcut(false, false, false)).toBe(true)
    expect(canOpenVoidShortcut(false, true, false)).toBe(false)
    expect(canOpenVoidShortcut(false, false, true)).toBe(false)
    expect(canOpenVoidShortcut(false, false, false, true)).toBe(false)
    expect(canOpenVoidShortcut(true, false, false)).toBe(false)
  })

  it('keeps rep navigation unavailable while drawer closure needs confirmation', () => {
    expect(canNavigateToRep(false, false)).toBe(true)
    expect(canNavigateToRep(false, true)).toBe(false)
    expect(canNavigateToRep(true, false)).toBe(false)
  })
})
