import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import * as AuditLogModule from './AuditLog'

const { formatAuditValue, summarizeAuditChanges } = AuditLogModule

describe('formatAuditValue', () => {
  it('formats creation, removal, unexpected null, and JSON states readably', () => {
    expect(formatAuditValue(null, { status: 'ASSIGNED' }, 'before')).toBe('Record did not exist')
    expect(formatAuditValue(null, { status: 'ASSIGNED' }, 'after')).toBe('Record no longer exists')
    expect(formatAuditValue(null)).toBe('No state recorded')
    expect(formatAuditValue({ status: 'ELIGIBLE' })).toBe('{\n  "status": "ELIGIBLE"\n}')
  })
})

describe('audit event presentation', () => {
  it('turns machine action names into readable activity labels', () => {
    const formatAuditAction = (AuditLogModule as any).formatAuditAction
    expect(formatAuditAction).toBeTypeOf('function')
    expect(formatAuditAction('activity.metric.edit')).toBe('Corrected activity metrics')
    expect(formatAuditAction('rep.override')).toBe('Changed rep status')
    expect(formatAuditAction('lead.assign')).toBe('Assigned lead')
    expect(formatAuditAction('lead.queue')).toBe('Queued unassigned lead')
    expect(formatAuditAction('future.someAction')).toBe('Future some Action')
  })

  it('names a manual skip as a lead pass, not an automatic status skip', () => {
    const formatAuditAction = (AuditLogModule as any).formatAuditAction
    expect(formatAuditAction('lead.skip')).toBe('Skipped rep and passed lead')
  })

  it('labels a denied protected-account write instead of falling back to the raw action name', () => {
    const formatAuditAction = (AuditLogModule as any).formatAuditAction
    expect(formatAuditAction('user.protectedWriteDenied')).toBe('Denied change to protected account')
  })

  it('summarizes changed fields without making raw JSON the primary view', () => {
    expect(summarizeAuditChanges).toBeTypeOf('function')
    expect(
      summarizeAuditChanges(
        { status: 'ELIGIBLE', reason: null },
        { status: 'INELIGIBLE', reason: 'Manager override' },
      ),
    ).toEqual(['Status: Eligible → Ineligible', 'Reason: Not set → Manager override'])
  })

  it('summarizes record creation, removal, and a missing field naturally', () => {
    expect(summarizeAuditChanges(null, { status: 'ASSIGNED', assignedRepId: null })).toEqual([
      'Created with 2 recorded fields',
    ])
    expect(summarizeAuditChanges({ status: 'ASSIGNED' }, null)).toEqual(['Record removed'])
    expect(summarizeAuditChanges({ reason: 'Review' }, {})).toEqual(['Reason: Review → Not set'])
    expect(summarizeAuditChanges('unexpected', { status: 'ASSIGNED' })).toEqual([
      'Technical details changed',
    ])
  })
})

describe('audit filters', () => {
  it('builds the exact committed API input and retains it for pagination', () => {
    const filters: AuditLogModule.AuditFilters = {
      action: 'lead.assign',
      actorUserId: '11111111-1111-4111-8111-111111111111',
      affectedKind: 'LEAD',
      affectedId: '22222222-2222-4222-8222-222222222222',
      fromDate: '2026-08-01',
      toDate: '2026-08-04',
    }
    expect(AuditLogModule.buildAuditListInput(filters, 50)).toEqual({
      limit: 50,
      offset: 50,
      action: 'lead.assign',
      actorUserId: '11111111-1111-4111-8111-111111111111',
      affected: { kind: 'LEAD', id: '22222222-2222-4222-8222-222222222222' },
      fromDate: '2026-08-01',
      toDate: '2026-08-04',
    })
  })

  it('omits an incomplete affected selection', () => {
    expect(AuditLogModule.buildAuditListInput({
      ...AuditLogModule.EMPTY_AUDIT_FILTERS,
      affectedKind: 'REP',
    }, 0)).toEqual({ limit: 50, offset: 0 })
  })

  it('renders explicitly labelled responsive controls and the live update status', () => {
    const markup = renderToStaticMarkup(createElement(AuditLogModule.AuditLog))
    expect(markup).toContain('Filter audit events')
    expect(markup).toContain('Action type<select')
    expect(markup).toContain('Actor<select')
    expect(markup).toContain('Affected kind<select')
    expect(markup).toContain('From date<input')
    expect(markup).toContain('To date<input')
    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).toContain('>Apply filters</button>')
    expect(markup).toContain('>Clear filters</button>')
  })
})
