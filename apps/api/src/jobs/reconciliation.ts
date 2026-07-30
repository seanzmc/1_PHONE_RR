import { eq, and, sql } from 'drizzle-orm'
import cron from 'node-cron'
import type { DB } from '@phoneup/db'
import { schema } from '@phoneup/db'

export type Mismatch = { repId: string; periodKey: string; expected: number; actual: number }
export type ReconcileResult = { mismatches: Mismatch[] }

/**
 * Sums credit_delta rather than counting ASSIGN rows.
 *
 * The ledger is append-only, so a void does not remove its ASSIGN event — it appends a VOID
 * carrying credit_delta -1, and voidLead decrements the counter to match. Counting ASSIGN
 * rows therefore reported a permanent phantom mismatch for every lead ever voided, which
 * trains the operator to ignore the one alarm that means the numbers cannot be trusted.
 * credit_delta is the field the ledger keeps for exactly this sum.
 */
export async function reconcile(db: DB): Promise<ReconcileResult> {
  const expectedRows = await db
    .select({
      repId: schema.assignmentEvents.repId,
      periodKey: sql<string>`substring(${schema.lead.businessDate} from 1 for 7)`,
      expected: sql<number>`coalesce(sum(${schema.assignmentEvents.creditDelta}), 0)::int`,
    })
    .from(schema.assignmentEvents)
    .innerJoin(schema.lead, eq(schema.lead.id, schema.assignmentEvents.leadId))
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
