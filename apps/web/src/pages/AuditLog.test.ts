import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import * as AuditLogModule from './AuditLog'

const { AuditEventCard, formatAuditValue, summarizeAuditChanges } = AuditLogModule

const ASSIGNED_REP_ID = '11111111-1111-4111-8111-111111111111'
const REASSIGNED_REP_ID = '22222222-2222-4222-8222-222222222222'
const UNAVAILABLE_REP_ID = '33333333-3333-4333-8333-333333333333'

function renderEvent(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(createElement(AuditEventCard, {
    item: {
      id: 'event-1',
      createdAt: '2026-08-07T12:00:00.000Z',
      actor: { displayName: 'Morgan Manager', email: 'manager@example.com' },
      action: 'lead.reassign',
      entityType: 'lead',
      entityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      entityDisplay: { kind: 'Lead', label: 'Jordan Customer · (555) 123-4567' },
      referenceLabels: {
        [ASSIGNED_REP_ID]: 'Alex Lee · alex@example.com',
        [REASSIGNED_REP_ID]: 'Alex Lee · alex.duplicate@example.com',
      },
      before: { assignedRepId: ASSIGNED_REP_ID, skippedRepId: null },
      after: { assignedRepId: REASSIGNED_REP_ID, skippedRepId: UNAVAILABLE_REP_ID },
      ...overrides,
    },
  }))
}

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

  it('uses field-specific labels and resolves UUID values without guessing unavailable records', () => {
    expect(summarizeAuditChanges(
      { assignedRepId: ASSIGNED_REP_ID, skippedRepId: null, repId: null },
      { assignedRepId: REASSIGNED_REP_ID, skippedRepId: UNAVAILABLE_REP_ID, repId: ASSIGNED_REP_ID },
      {
        [ASSIGNED_REP_ID]: 'Alex Lee · alex@example.com',
        [REASSIGNED_REP_ID]: 'Alex Lee · alex.duplicate@example.com',
      },
    )).toEqual([
      'Assigned rep: Alex Lee · alex@example.com → Alex Lee · alex.duplicate@example.com',
      'Skipped rep: Not set → Record unavailable',
      'Rep: Not set → Alex Lee · alex@example.com',
    ])
  })

  it('keeps ordinary non-UUID summary values and the three-change limit', () => {
    expect(summarizeAuditChanges(
      { status: 'ELIGIBLE', reason: null, calls: 1, sold: 0 },
      { status: 'INELIGIBLE', reason: 'Review', calls: 2, sold: 1 },
      {},
    )).toEqual([
      'Status: Eligible → Ineligible',
      'Reason: Not set → Review',
      'Calls: 1 → 2',
      '+1 more changes',
    ])
  })

  it('renders readable and unavailable identities without front-facing UUIDs', () => {
    const entityId = '44444444-4444-4444-8444-444444444444'
    const cases = [
      ['app_user', 'Account', 'Sean Admin · sean@example.com'],
      ['lead', 'Lead', 'Jordan Customer · (555) 123-4567'],
      ['sales_rep', 'Rep', 'Taylor Morgan · taylor@example.com'],
      ['rep_daily_activity', 'Activity import', '2026-08-06'],
      ['work_requirement_policy', 'Activity policy', 'Call requirement settings'],
      ['future_record', 'Future record', 'Record unavailable'],
    ]

    for (const [entityType, kind, label] of cases) {
      const markup = renderEvent({ entityType, entityId, entityDisplay: { kind, label }, before: null, after: {} })
      const normalCard = markup.slice(0, markup.indexOf('<details'))
      expect(normalCard).toContain(`${kind} · ${label}`)
      expect(normalCard).not.toContain(entityId)
    }
  })

  it('keeps exact raw identity and unsanitized payloads in Technical details only', () => {
    const markup = renderEvent()
    const normalCard = markup.slice(0, markup.indexOf('<details'))
    const technicalDetails = markup.slice(markup.indexOf('<details'))

    expect(normalCard).not.toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(normalCard).not.toContain(ASSIGNED_REP_ID)
    expect(normalCard).not.toContain(REASSIGNED_REP_ID)
    expect(normalCard).not.toContain(UNAVAILABLE_REP_ID)
    expect(normalCard).toContain('Assigned rep: Alex Lee · alex@example.com → Alex Lee · alex.duplicate@example.com')
    expect(normalCard).toContain('Skipped rep: Not set → Record unavailable')
    expect(technicalDetails).toContain('Entity type')
    expect(technicalDetails).toContain('lead')
    expect(technicalDetails).toContain('Entity ID')
    expect(technicalDetails).toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(technicalDetails).toContain(`&quot;assignedRepId&quot;: &quot;${ASSIGNED_REP_ID}&quot;`)
    expect(technicalDetails).toContain(`&quot;assignedRepId&quot;: &quot;${REASSIGNED_REP_ID}&quot;`)
    expect(technicalDetails).toContain(`&quot;skippedRepId&quot;: &quot;${UNAVAILABLE_REP_ID}&quot;`)
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
