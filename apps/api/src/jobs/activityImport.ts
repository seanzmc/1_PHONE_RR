import { parse } from 'csv-parse/sync'
import { eq, and, sql } from 'drizzle-orm'
import type { DB } from '@phoneup/db'
import { schema } from '@phoneup/db'

/**
 * Importer for the CRM "Standard-Daily Activity" export (design pass §H).
 *
 * The real export is an AGGREGATE-PER-REP report, not one row per call:
 *   - UTF-8 BOM on byte 0
 *   - TWO header rows: row 1 is a merged group band (Opportunities/Appointments/
 *     Activity/Workplan/Performance), row 2 is the real column names; data starts row 3
 *   - every field is quoted, numbers included ("3"), so it needs real quote-aware parsing
 *   - match key is column A `User` = display name (NOT email)
 *   - column N  `Calls` -> daily metric
 *   - column AA `Sold`  -> that day's sales count
 */

const COL_USER = 0
const COL_CALLS = 13 // column N
const COL_SOLD = 26 // column AA

export type ParsedActivityRow = { userName: string; calls: number; sold: number }

export type ImportSummary = {
  businessDate: string
  rowsParsed: number
  repsMatched: number
  /** Roster reps with no row in the file at all — they register 0 calls, a real signal. */
  repsMissingFromFile: string[]
  /** Names in the file that match no rep — reported, never guessed at. */
  unmatchedNames: string[]
  /** Reps whose row was already MANUAL, so the import left the manager's value alone. */
  manualRowsPreserved: string[]
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

function toInt(raw: string | undefined): number {
  const n = Number.parseInt((raw ?? '').trim(), 10)
  return Number.isFinite(n) ? n : 0
}

/**
 * Parse the export into aggregate rows. Strips the BOM, skips BOTH header rows, and
 * uses a real CSV parser — a hand-rolled `split(',')` cannot survive a quoted rep name
 * containing a comma ("Smith, Jr").
 */
export function parseActivityCsv(csv: string): ParsedActivityRow[] {
  const withoutBom = csv.replace(/^\uFEFF/, '')

  const records: string[][] = parse(withoutBom, {
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
  })

  // row 1 = merged group band, row 2 = real column names, data starts at row 3
  const dataRows = records.slice(2)

  return dataRows
    .map((cols) => ({
      userName: (cols[COL_USER] ?? '').trim(),
      calls: toInt(cols[COL_CALLS]),
      sold: toInt(cols[COL_SOLD]),
    }))
    .filter((row) => row.userName.length > 0)
}

/** Pull the report date out of a filename like `Standard-Daily Activity 2026-07-29.csv`. */
export function businessDateFromFilename(filename: string): string | null {
  const match = filename.match(/(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : null
}

/**
 * Import one day's aggregate activity.
 *
 * `businessDate` is ALWAYS passed in explicitly (normally the prior day — the report is
 * yesterday's activity imported this morning). It is never inferred from `new Date()`
 * inside the parser.
 *
 * Idempotent per (rep, business_date): upsert on the unique key, so re-importing the same
 * day overwrites IMPORT values and never duplicates. A row already marked MANUAL is left
 * untouched and reported as preserved.
 */
export async function importDailyActivity(
  db: DB,
  csv: string,
  businessDate: string,
  opts: { actorUserId?: string } = {},
): Promise<ImportSummary> {
  const rows = parseActivityCsv(csv)

  const reps = await db.select().from(schema.salesRep)
  const repByName = new Map(reps.map((r: any) => [normalizeName(r.displayName), r]))

  const existing = await db.query.repDailyActivity.findMany({
    where: eq(schema.repDailyActivity.businessDate, businessDate),
  })
  const existingByRep = new Map(existing.map((e: any) => [e.repId, e]))

  const unmatchedNames: string[] = []
  const manualRowsPreserved: string[] = []
  const matchedRepIds = new Set<string>()

  for (const row of rows) {
    const rep = repByName.get(normalizeName(row.userName))
    if (!rep) {
      // no fuzzy matching — an unmatched name is reported, never guessed
      unmatchedNames.push(row.userName)
      continue
    }
    matchedRepIds.add(rep.id)

    const prior = existingByRep.get(rep.id)
    if (prior?.source === 'MANUAL') {
      // a manager already corrected this day — a re-import must not clobber it
      manualRowsPreserved.push(rep.displayName)
      continue
    }

    await db
      .insert(schema.repDailyActivity)
      .values({
        repId: rep.id,
        businessDate,
        calls: row.calls,
        sold: row.sold,
        source: 'IMPORT',
        importedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.repDailyActivity.repId, schema.repDailyActivity.businessDate],
        set: { calls: row.calls, sold: row.sold, source: 'IMPORT', importedAt: new Date() },
        // never overwrite a manual correction, even if the pre-read raced
        setWhere: sql`${schema.repDailyActivity.source} <> 'MANUAL'`,
      })
  }

  const repsMissingFromFile = reps
    .filter((r: any) => !matchedRepIds.has(r.id))
    .map((r: any) => r.displayName)

  const summary: ImportSummary = {
    businessDate,
    rowsParsed: rows.length,
    repsMatched: matchedRepIds.size,
    repsMissingFromFile,
    unmatchedNames,
    manualRowsPreserved,
  }

  if (opts.actorUserId) {
    await db.insert(schema.auditEvents).values({
      actorUserId: opts.actorUserId,
      action: 'activity.import',
      entityType: 'rep_daily_activity',
      entityId: reps[0]?.id ?? '00000000-0000-0000-0000-000000000000',
      before: null,
      after: {
        businessDate: summary.businessDate,
        rowsParsed: summary.rowsParsed,
        repsMatched: summary.repsMatched,
        repsMissingFromFile: summary.repsMissingFromFile.length,
        unmatchedNames: summary.unmatchedNames,
        manualRowsPreserved: summary.manualRowsPreserved,
      },
    })
  }

  return summary
}

/**
 * Manager/admin correction of an imported metric (design pass §J).
 * Writes source='MANUAL' so a later re-import will not clobber it.
 */
export async function setActivityMetric(
  db: DB,
  input: {
    repId: string
    businessDate: string
    calls?: number
    sold?: number
    reasonNote: string
    actorUserId: string
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const before = await tx.query.repDailyActivity.findFirst({
      where: and(
        eq(schema.repDailyActivity.repId, input.repId),
        eq(schema.repDailyActivity.businessDate, input.businessDate),
      ),
    })

    const calls = input.calls ?? before?.calls ?? 0
    const sold = input.sold ?? before?.sold ?? 0

    if (before) {
      await tx
        .update(schema.repDailyActivity)
        .set({ calls, sold, source: 'MANUAL' })
        .where(eq(schema.repDailyActivity.id, before.id))
    } else {
      await tx
        .insert(schema.repDailyActivity)
        .values({ repId: input.repId, businessDate: input.businessDate, calls, sold, source: 'MANUAL' })
    }

    await tx.insert(schema.auditEvents).values({
      actorUserId: input.actorUserId,
      action: 'activity.metric.edit',
      entityType: 'rep_daily_activity',
      entityId: input.repId,
      before: before ? { calls: before.calls, sold: before.sold, source: before.source } : null,
      after: { businessDate: input.businessDate, calls, sold, source: 'MANUAL', reasonNote: input.reasonNote },
    })
  })
}
