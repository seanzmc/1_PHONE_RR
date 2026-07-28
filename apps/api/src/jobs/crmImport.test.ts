import { describe, it, expect, beforeAll } from 'vitest'
import { eq, and } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { parseCrmImport } from './crmImport'

describe('parseCrmImport', () => {
  let repEmail: string
  const businessDate = '2026-02-02'

  beforeAll(async () => {
    const [user] = await db
      .insert(schema.appUser)
      .values({ email: `crm-import-${Date.now()}@dealership.test`, passwordHash: 'x:y', role: 'REP' })
      .returning()
    repEmail = user.email
    await db.insert(schema.salesRep).values({ userId: user.id, displayName: 'CRM Import Rep', hireDate: '2020-01-01' })
  })

  it('inserts one lead_activity row per matched CSV row, entry_source CRM_IMPORT', async () => {
    const csv = [
      'rep_email,occurred_at,note',
      `${repEmail},2026-02-02T14:00:00Z,call 1`,
      `${repEmail},2026-02-02T15:00:00Z,call 2`,
      `unknown@dealership.test,2026-02-02T16:00:00Z,unmatched`,
    ].join('\n')

    const result = await parseCrmImport(db, csv, businessDate)
    expect(result.inserted).toBe(2)
    expect(result.unmatchedRows).toBe(1)

    const rep = await db.query.salesRep.findFirst({
      where: eq(schema.salesRep.userId, (await db.query.appUser.findFirst({ where: eq(schema.appUser.email, repEmail) }))!.id),
    })
    const rows = await db.query.leadActivity.findMany({
      where: and(eq(schema.leadActivity.repId, rep!.id), eq(schema.leadActivity.businessDate, businessDate)),
    })
    expect(rows.length).toBe(2)
    expect(rows.every((r: any) => r.entrySource === 'CRM_IMPORT')).toBe(true)
  })
})
