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
const ADVISORY_LOCK_KEY = 42_100_1
const MIN_MATCH_RATE = 0.5
const MAX_POSTGRES_INTEGER = 2_147_483_647

export type ParsedActivityRow = { userName: string; calls: number; sold: number }

export type ImportSummary = {
  businessDate: string
  rowsParsed: number
  repsMatched: number
  /** Roster reps with no file row — they register 0 unless a MANUAL correction is preserved. */
  repsMissingFromFile: string[]
  /** Names in the file that match no rep — reported, never guessed at. */
  unmatchedNames: string[]
  /** Reps whose row was already MANUAL, so the import left the manager's value alone. */
  manualRowsPreserved: string[]
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function indexRosterByNormalizedName<T extends { id: string; displayName: string }>(
  reps: T[],
): Map<string, T[]> {
  const index = new Map<string, T[]>()
  for (const rep of reps) {
    const key = normalizeName(rep.displayName)
    const matches = index.get(key) ?? []
    matches.push(rep)
    index.set(key, matches)
  }
  return index
}

export function findUniqueRosterRep<T extends { displayName: string }>(
  index: Map<string, T[]>,
  userName: string,
): T | undefined {
  const matches = index.get(normalizeName(userName)) ?? []
  if (matches.length > 1) {
    throw new Error(
      `ambiguous roster display names for "${userName}": ${matches.map((rep) => `"${rep.displayName}"`).join(', ')}`,
    )
  }
  return matches[0]
}

function toNonNegativeInt(raw: string | undefined, label: string, rowNumber: number): number {
  const value = (raw ?? '').trim()
  if (!/^\d+$/.test(value)) {
    throw new Error(`row ${rowNumber}: invalid ${label} value "${value}"; expected a non-negative integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > MAX_POSTGRES_INTEGER) {
    throw new Error(`row ${rowNumber}: invalid ${label} value "${value}"; integer is too large`)
  }
  return parsed
}

export function assertActivityMatchQuality(rowsParsed: number, repsMatched: number): void {
  const matchRate = rowsParsed === 0 ? 0 : repsMatched / rowsParsed
  if (repsMatched === 0 || matchRate < MIN_MATCH_RATE) {
    throw new Error(
      `activity report match rate is too low: ${repsMatched}/${rowsParsed} rows matched; expected at least ${MIN_MATCH_RATE * 100}%`,
    )
  }
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

  if (records.length < 2) {
    throw new Error('activity report must contain the CRM group header and column header rows')
  }
  const headers = records[1]
  const requiredHeaders = [
    { index: COL_USER, column: 'A', expected: 'User' },
    { index: COL_CALLS, column: 'N', expected: 'Calls' },
    { index: COL_SOLD, column: 'AA', expected: 'Sold' },
  ]
  for (const header of requiredHeaders) {
    const actual = (headers[header.index] ?? '').trim()
    if (actual.toLowerCase() !== header.expected.toLowerCase()) {
      throw new Error(
        `expected column ${header.column} to be "${header.expected}", found "${actual || '(missing)'}"`,
      )
    }
  }

  // row 1 = merged group band, row 2 = real column names, data starts at row 3
  const dataRows = records.slice(2)
  const seenNames = new Set<string>()

  return dataRows.map((cols, index) => {
    const rowNumber = index + 3
    if (cols.length <= COL_SOLD) {
      throw new Error(`row ${rowNumber}: expected at least ${COL_SOLD + 1} columns, found ${cols.length}`)
    }
    const userName = (cols[COL_USER] ?? '').trim()
    if (!userName) throw new Error(`row ${rowNumber}: User is required`)
    const normalized = normalizeName(userName)
    if (seenNames.has(normalized)) {
      throw new Error(`row ${rowNumber}: duplicate User "${userName}"`)
    }
    seenNames.add(normalized)
    return {
      userName,
      calls: toNonNegativeInt(cols[COL_CALLS], 'Calls', rowNumber),
      sold: toNonNegativeInt(cols[COL_SOLD], 'Sold', rowNumber),
    }
  })
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
  if (rows.length === 0) throw new Error('the report contains no activity data rows')

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)

    const reps = await tx.select().from(schema.salesRep)
    const repsByName = indexRosterByNormalizedName(reps)
    const existing = await tx.query.repDailyActivity.findMany({
      where: eq(schema.repDailyActivity.businessDate, businessDate),
    })
    const existingByRep = new Map(existing.map((entry: any) => [entry.repId, entry]))
    const incomingByRep = new Map<string, ParsedActivityRow>()
    const unmatchedNames: string[] = []
    const matchedRepIds = new Set<string>()

    for (const row of rows) {
      const rep = findUniqueRosterRep(repsByName, row.userName)
      if (!rep) {
        // no fuzzy matching — an unmatched name is reported, never guessed
        unmatchedNames.push(row.userName)
        continue
      }
      matchedRepIds.add(rep.id)
      incomingByRep.set(rep.id, row)
    }
    assertActivityMatchQuality(rows.length, matchedRepIds.size)

    const manualRowsPreserved: string[] = []
    for (const rep of reps) {
      const prior = existingByRep.get(rep.id) as any
      if (prior?.source === 'MANUAL') {
        manualRowsPreserved.push(rep.displayName)
        continue
      }
      const incoming = incomingByRep.get(rep.id)
      const calls = incoming?.calls ?? 0
      const sold = incoming?.sold ?? 0
      await tx
        .insert(schema.repDailyActivity)
        .values({ repId: rep.id, businessDate, calls, sold, source: 'IMPORT', importedAt: new Date() })
        .onConflictDoUpdate({
          target: [schema.repDailyActivity.repId, schema.repDailyActivity.businessDate],
          set: { calls, sold, source: 'IMPORT', importedAt: new Date() },
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
      await tx.insert(schema.auditEvents).values({
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
  })
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
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)

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
