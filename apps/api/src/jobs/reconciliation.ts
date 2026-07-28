import { eq, and, sql } from 'drizzle-orm'
import cron from 'node-cron'
import type { DB } from '@phoneup/db'
import { schema } from '@phoneup/db'

export type Mismatch = { repId: string; periodKey: string; expected: number; actual: number }
export type ReconcileResult = { mismatches: Mismatch[] }

export async function reconcile(db: DB): Promise<ReconcileResult> {
  const expectedRows = await db
    .select({
      repId: schema.assignmentEvents.repId,
      periodKey: sql<string>`substring(${schema.lead.businessDate} from 1 for 7)`,
      expected: sql<number>`count(*)::int`,
    })
    .from(schema.assignmentEvents)
    .innerJoin(schema.lead, eq(schema.lead.id, schema.assignmentEvents.leadId))
    .where(eq(schema.assignmentEvents.eventType, 'ASSIGN'))
    .groupBy(schema.assignmentEvents.repId, sql`substring(${schema.lead.businessDate} from 1 for 7)`)

  const counters = await db.select().from(schema.repMonthCounters)
  const counterByKey = new Map(counters.map((c: any) => [`${c.repId}:${c.periodKey}`, c.upsMtd]))

  const mismatches: Mismatch[] = []
  for (const row of expectedRows) {
    if (!row.repId) continue
    const key = `${row.repId}:${row.periodKey}`
    const actual = counterByKey.get(key) ?? 0
    if (actual !== row.expected) {
      mismatches.push({ repId: row.repId, periodKey: row.periodKey, expected: row.expected, actual })
    }
  }

  if (mismatches.length > 0) {
    console.error('reconciliation mismatch detected — ledger vs rep_month_counters drift', mismatches)
  }

  return { mismatches }
}

export function scheduleReconciliationJob(db: DB): void {
  cron.schedule('0 2 * * *', () => reconcile(db), { timezone: 'America/New_York' })
}
