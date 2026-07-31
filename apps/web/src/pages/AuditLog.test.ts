import { describe, expect, it } from 'vitest'
import { formatAuditValue } from './AuditLog'

describe('formatAuditValue', () => {
  it('formats absent values and JSON values readably', () => {
    expect(formatAuditValue(null)).toBe('—')
    expect(formatAuditValue({ status: 'ELIGIBLE' })).toBe('{\n  "status": "ELIGIBLE"\n}')
  })
})
