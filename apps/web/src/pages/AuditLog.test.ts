import { describe, expect, it } from 'vitest'
import * as AuditLogModule from './AuditLog'

const { formatAuditValue } = AuditLogModule

describe('formatAuditValue', () => {
  it('formats absent values and JSON values readably', () => {
    expect(formatAuditValue(null)).toBe('—')
    expect(formatAuditValue({ status: 'ELIGIBLE' })).toBe('{\n  "status": "ELIGIBLE"\n}')
  })
})

describe('audit event presentation', () => {
  it('turns machine action names into readable activity labels', () => {
    const formatAuditAction = (AuditLogModule as any).formatAuditAction
    expect(formatAuditAction).toBeTypeOf('function')
    expect(formatAuditAction('activity.metric.edit')).toBe('Corrected activity metrics')
    expect(formatAuditAction('rep.override')).toBe('Changed rep status')
  })

  it('summarizes changed fields without making raw JSON the primary view', () => {
    const summarizeAuditChanges = (AuditLogModule as any).summarizeAuditChanges
    expect(summarizeAuditChanges).toBeTypeOf('function')
    expect(
      summarizeAuditChanges(
        { status: 'ELIGIBLE', reason: null },
        { status: 'INELIGIBLE', reason: 'Manager override' },
      ),
    ).toEqual(['Status: Eligible → Ineligible', 'Reason: Not set → Manager override'])
  })
})
