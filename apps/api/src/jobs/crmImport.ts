import { eq } from 'drizzle-orm'
import type { DB } from '@phoneup/db'
import { schema } from '@phoneup/db'

export type CrmImportResult = { inserted: number; unmatchedRows: number }

/**
 * Hand-rolled parser for the one known CRM export column shape
 * (rep_email, occurred_at, note) — no CSV library needed for a single fixed format.
 */
function parseCsvRows(csv: string): Array<{ repEmail: string; occurredAt: string; note: string }> {
  const lines = csv.trim().split('\n')
  const [, ...rows] = lines // skip header
  return rows
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [repEmail, occurredAt, ...noteParts] = line.split(',')
      return { repEmail: repEmail.trim(), occurredAt: occurredAt.trim(), note: noteParts.join(',').trim() }
    })
}

export async function parseCrmImport(db: DB, csv: string, businessDate: string): Promise<CrmImportResult> {
  const rows = parseCsvRows(csv)
  let inserted = 0
  let unmatchedRows = 0

  for (const row of rows) {
    const user = await db.query.appUser.findFirst({ where: eq(schema.appUser.email, row.repEmail) })
    const rep = user ? await db.query.salesRep.findFirst({ where: eq(schema.salesRep.userId, user.id) }) : null

    if (!rep) {
      unmatchedRows++
      continue
    }

    await db.insert(schema.leadActivity).values({
      repId: rep.id,
      noteBody: row.note || null,
      occurredAt: new Date(row.occurredAt),
      businessDate,
      entrySource: 'CRM_IMPORT',
    })
    inserted++
  }

  return { inserted, unmatchedRows }
}
