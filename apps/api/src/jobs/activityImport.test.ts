import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq, and, inArray } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import {
  businessDateFromFilename,
  importDailyActivity,
  parseActivityCsv,
  setActivityMetric,
} from './activityImport'

const BUSINESS_DATE = '2026-07-28'

/** The two-header, BOM-prefixed, fully-quoted shape of the real export. */
function buildCsv(rows: Array<{ user: string; calls: number | string; sold: number | string }>): string {
  const band = ['', 'Opportunities', ...Array(6).fill(''), 'Appointments', ...Array(5).fill(''), 'Activity', ...Array(12).fill(''), 'Workplan', 'Performance', '', '']
  const headers = [
    'User', 'Total', 'Showroom', 'Phone', 'Internet', 'Campaign', 'Chat',
    'Created', 'Scheduled', 'Confirmed', 'Show', 'No Show', 'Cancelled',
    'Calls', 'Call Contacted', 'Text', 'Impersonated  Text', 'Email',
    'Impersonated Email', 'Chat', 'Personalized Video', 'Canned Video',
    'Live Room', 'Notes', 'Mentions', 'Completed Tasks', 'Sold',
    'Units Delivered', 'Deals Delivered',
  ]
  const quote = (cells: Array<string | number>) => cells.map((c) => `"${c}"`).join(',')

  const dataLines = rows.map((r) => {
    const cells: Array<string | number> = Array(29).fill('0')
    cells[0] = r.user
    cells[13] = r.calls
    cells[26] = r.sold
    return quote(cells)
  })

  // BOM on byte 0, CRLF line endings, exactly like the export
  return '\uFEFF' + [quote(band), quote(headers), ...dataLines].join('\r\n') + '\r\n'
}

let repA: any
let repB: any
let commaRep: any
let adminUserId: string
const stamp = Date.now()

beforeAll(async () => {
  const admin = await db.query.appUser.findFirst({ where: eq(schema.appUser.role, 'ADMIN') })
  adminUserId = admin!.id

  async function makeRep(displayName: string) {
    const [user] = await db
      .insert(schema.appUser)
      .values({ email: `act-${stamp}-${Math.random().toString(36).slice(2, 8)}@dealership.test`, passwordHash: 'x:y', role: 'REP' })
      .returning()
    const [rep] = await db
      .insert(schema.salesRep)
      .values({ userId: user.id, displayName, hireDate: '2020-01-01' })
      .returning()
    return rep
  }

  repA = await makeRep(`Activity Alpha ${stamp}`)
  repB = await makeRep(`Activity Beta ${stamp}`)
  commaRep = await makeRep(`Smith, Jr ${stamp}`)
})

beforeEach(async () => {
  await db
    .delete(schema.repDailyActivity)
    .where(inArray(schema.repDailyActivity.repId, [repA.id, repB.id, commaRep.id]))
})

describe('parseActivityCsv', () => {
  it('strips the BOM and skips BOTH header rows', () => {
    const rows = parseActivityCsv(buildCsv([{ user: 'Only Rep', calls: 7, sold: 2 }]))
    expect(rows.length).toBe(1)
    expect(rows[0]).toEqual({ userName: 'Only Rep', calls: 7, sold: 2 })
    // the literal header text must never survive as a data row
    expect(rows.some((r) => r.userName === 'User')).toBe(false)
  })

  it('reads quoted numbers from columns N (Calls) and AA (Sold)', () => {
    const rows = parseActivityCsv(buildCsv([{ user: 'Numbers Rep', calls: '12', sold: '3' }]))
    expect(rows[0].calls).toBe(12)
    expect(rows[0].sold).toBe(3)
  })

  it('survives a rep name containing a comma — the hand-rolled split could not', () => {
    const rows = parseActivityCsv(buildCsv([{ user: 'Smith, Jr', calls: 4, sold: 1 }]))
    expect(rows.length).toBe(1)
    expect(rows[0].userName).toBe('Smith, Jr')
    expect(rows[0].calls).toBe(4)
  })

  it('parses the real exported file with the documented column offsets', () => {
    // The real export contains live employee data and is intentionally NOT committed,
    // so this check runs when the file is present locally and skips in CI.
    const path = resolve(__dirname, '../../../../Standard-Daily Activity 2026-07-29.csv')
    if (!existsSync(path)) return

    const rows = parseActivityCsv(readFileSync(path, 'utf-8'))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].userName).toBe('Shannon Smith')
    expect(rows[0].calls).toBe(3)
    expect(rows.some((r) => r.sold > 0)).toBe(true)
    expect(rows.every((r) => Number.isFinite(r.calls) && Number.isFinite(r.sold))).toBe(true)
  })

  it('reads businessDate from the filename rather than inferring it from now()', () => {
    expect(businessDateFromFilename('Standard-Daily Activity 2026-07-29.csv')).toBe('2026-07-29')
    expect(businessDateFromFilename('no-date-here.csv')).toBeNull()
  })
})

describe('importDailyActivity', () => {
  it('writes one aggregate row per matched rep for the given business date', async () => {
    const csv = buildCsv([
      { user: repA.displayName, calls: 11, sold: 1 },
      { user: repB.displayName, calls: 2, sold: 0 },
    ])
    const summary = await importDailyActivity(db, csv, BUSINESS_DATE)

    expect(summary.repsMatched).toBe(2)
    expect(summary.businessDate).toBe(BUSINESS_DATE)

    const rowA = await db.query.repDailyActivity.findFirst({
      where: and(
        eq(schema.repDailyActivity.repId, repA.id),
        eq(schema.repDailyActivity.businessDate, BUSINESS_DATE),
      ),
    })
    expect(rowA?.calls).toBe(11)
    expect(rowA?.sold).toBe(1)
    expect(rowA?.source).toBe('IMPORT')
  })

  it('matches on display name case- and whitespace-insensitively', async () => {
    const csv = buildCsv([{ user: `  ${repA.displayName.toUpperCase()}  `, calls: 9, sold: 0 }])
    const summary = await importDailyActivity(db, csv, BUSINESS_DATE)
    expect(summary.repsMatched).toBe(1)
    expect(summary.unmatchedNames).toEqual([])
  })

  it('reports an unmatched name instead of guessing at a rep', async () => {
    const csv = buildCsv([
      { user: repA.displayName, calls: 5, sold: 0 },
      { user: 'Nobody By That Name', calls: 40, sold: 9 },
    ])
    const summary = await importDailyActivity(db, csv, BUSINESS_DATE)
    expect(summary.unmatchedNames).toContain('Nobody By That Name')
    expect(summary.repsMatched).toBe(1)

    // and nothing was written for the unmatched name
    const all = await db.query.repDailyActivity.findMany({
      where: eq(schema.repDailyActivity.businessDate, BUSINESS_DATE),
    })
    expect(all.every((r: any) => r.calls !== 40)).toBe(true)
  })

  it('is idempotent: re-importing the same day overwrites and never duplicates', async () => {
    await importDailyActivity(db, buildCsv([{ user: repA.displayName, calls: 5, sold: 1 }]), BUSINESS_DATE)
    await importDailyActivity(db, buildCsv([{ user: repA.displayName, calls: 8, sold: 2 }]), BUSINESS_DATE)

    const rows = await db.query.repDailyActivity.findMany({
      where: and(
        eq(schema.repDailyActivity.repId, repA.id),
        eq(schema.repDailyActivity.businessDate, BUSINESS_DATE),
      ),
    })
    expect(rows.length).toBe(1) // overwrite, not append — this is what keeps SUM(sold) honest
    expect(rows[0].calls).toBe(8)
    expect(rows[0].sold).toBe(2)
  })

  it('re-import preserves a MANUAL correction and reports it as skipped', async () => {
    await importDailyActivity(db, buildCsv([{ user: repA.displayName, calls: 5, sold: 0 }]), BUSINESS_DATE)
    await setActivityMetric(db, {
      repId: repA.id,
      businessDate: BUSINESS_DATE,
      calls: 12,
      reasonNote: 'CRM undercounted; verified in phone log',
      actorUserId: adminUserId,
    })

    const summary = await importDailyActivity(
      db,
      buildCsv([{ user: repA.displayName, calls: 5, sold: 0 }]),
      BUSINESS_DATE,
    )

    expect(summary.manualRowsPreserved).toContain(repA.displayName)
    const row = await db.query.repDailyActivity.findFirst({
      where: and(
        eq(schema.repDailyActivity.repId, repA.id),
        eq(schema.repDailyActivity.businessDate, BUSINESS_DATE),
      ),
    })
    expect(row?.calls).toBe(12) // the manager's number survived
    expect(row?.source).toBe('MANUAL')
  })

  it('reports roster reps absent from the file — they register 0 calls, a real signal', async () => {
    const summary = await importDailyActivity(
      db,
      buildCsv([{ user: repA.displayName, calls: 10, sold: 0 }]),
      BUSINESS_DATE,
    )
    expect(summary.repsMissingFromFile).toContain(repB.displayName)

    // absent means no row, which eligibility reads as 0 — not as missing data
    const rowB = await db.query.repDailyActivity.findFirst({
      where: and(
        eq(schema.repDailyActivity.repId, repB.id),
        eq(schema.repDailyActivity.businessDate, BUSINESS_DATE),
      ),
    })
    expect(rowB).toBeUndefined()
  })

  it('matches a rep whose name contains a comma', async () => {
    const summary = await importDailyActivity(
      db,
      buildCsv([{ user: commaRep.displayName, calls: 6, sold: 0 }]),
      BUSINESS_DATE,
    )
    expect(summary.unmatchedNames).toEqual([])
    const row = await db.query.repDailyActivity.findFirst({
      where: and(
        eq(schema.repDailyActivity.repId, commaRep.id),
        eq(schema.repDailyActivity.businessDate, BUSINESS_DATE),
      ),
    })
    expect(row?.calls).toBe(6)
  })

  it('audit-logs one activity.import event carrying the summary counts', async () => {
    await importDailyActivity(db, buildCsv([{ user: repA.displayName, calls: 3, sold: 0 }]), BUSINESS_DATE, {
      actorUserId: adminUserId,
    })
    const events = await db.query.auditEvents.findMany({
      where: eq(schema.auditEvents.action, 'activity.import'),
    })
    expect(events.length).toBeGreaterThan(0)
    const latest = events[events.length - 1]
    expect((latest.after as any).businessDate).toBe(BUSINESS_DATE)
    expect((latest.after as any).repsMatched).toBeGreaterThan(0)
  })
})

describe('setActivityMetric', () => {
  it('writes MANUAL and audit-logs before/after values', async () => {
    await importDailyActivity(db, buildCsv([{ user: repA.displayName, calls: 4, sold: 1 }]), BUSINESS_DATE)
    await setActivityMetric(db, {
      repId: repA.id,
      businessDate: BUSINESS_DATE,
      calls: 10,
      sold: 2,
      reasonNote: 'corrected from CRM export',
      actorUserId: adminUserId,
    })

    const row = await db.query.repDailyActivity.findFirst({
      where: and(
        eq(schema.repDailyActivity.repId, repA.id),
        eq(schema.repDailyActivity.businessDate, BUSINESS_DATE),
      ),
    })
    expect(row?.calls).toBe(10)
    expect(row?.sold).toBe(2)
    expect(row?.source).toBe('MANUAL')

    const events = await db.query.auditEvents.findMany({
      where: eq(schema.auditEvents.action, 'activity.metric.edit'),
    })
    const latest = events[events.length - 1]
    expect((latest.before as any).calls).toBe(4)
    expect((latest.after as any).calls).toBe(10)
    expect((latest.after as any).reasonNote).toBeTruthy()
  })

  it('creates a MANUAL row when no import row exists for that date', async () => {
    await setActivityMetric(db, {
      repId: repB.id,
      businessDate: BUSINESS_DATE,
      calls: 7,
      reasonNote: 'rep was on a spiff day, logged by hand',
      actorUserId: adminUserId,
    })
    const row = await db.query.repDailyActivity.findFirst({
      where: and(
        eq(schema.repDailyActivity.repId, repB.id),
        eq(schema.repDailyActivity.businessDate, BUSINESS_DATE),
      ),
    })
    expect(row?.calls).toBe(7)
    expect(row?.sold).toBe(0)
    expect(row?.source).toBe('MANUAL')
  })
})
