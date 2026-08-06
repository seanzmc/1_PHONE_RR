import { sql, eq, and, desc, isNull, ne, lt } from 'drizzle-orm'
import type { DB } from '@phoneup/db'
import { schema } from '@phoneup/db'
import { publishAssignment } from '../realtime/bus'

const ADVISORY_LOCK_KEY = 42_100_1 // same key as assignLead — void changes ordering too (CLAUDE.md)

export type VoidLeadInput = {
  leadId: string
  reasonNote: string
  actorUserId: string
}

export type VoidLeadResult = {
  leadId: string
  repId: string | null
  alreadyVoided: boolean
  cycleReopened: boolean
}

/**
 * Undo an assignment so that the voided rep becomes next-up again.
 *
 * Mirrors assignLead: one pg_advisory_xact_lock for the whole ordering-changing
 * transaction, ledger stays append-only (a VOID event is appended, the ASSIGN
 * event is never mutated), and every derived projection the ranking reads is
 * rolled back in the same transaction:
 *
 *   - rr_cycle_assignments row deleted  -> rep is unserved in that cycle again
 *   - ups_mtd / ups_today decremented   -> rep has the lowest monthly load again
 *   - last_assigned_at restored         -> rep has the oldest last-assigned again
 *
 * Those three together are what make board.roster's next-up equal the rep whose
 * assignment was just undone.
 */
export async function voidLead(db: DB, input: VoidLeadInput): Promise<VoidLeadResult> {
  const result = await db.transaction(async (tx) => {
    // 1. advisory lock — same key, same scope as assignLead
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)

    const lead = await tx.query.lead.findFirst({ where: eq(schema.lead.id, input.leadId) })
    if (!lead) throw new Error(`lead ${input.leadId} not found`)

    // 2. idempotent: a second void of the same lead is a no-op, not a double decrement
    const existingVoid = await tx.query.assignmentEvents.findFirst({
      where: and(
        eq(schema.assignmentEvents.leadId, lead.id),
        eq(schema.assignmentEvents.eventType, 'VOID'),
      ),
    })
    if (existingVoid || lead.status === 'VOID') {
      return { leadId: lead.id, repId: lead.assignedRepId, alreadyVoided: true, cycleReopened: false }
    }

    // 3. locate the ASSIGN event so we know which cycle consumed this rep
    const assignEvent = await tx.query.assignmentEvents.findFirst({
      where: and(
        eq(schema.assignmentEvents.leadId, lead.id),
        eq(schema.assignmentEvents.eventType, 'ASSIGN'),
      ),
    })
    if (!assignEvent) {
      // never assigned (queued unassigned) — just mark VOID, no rotation state to unwind
      await tx.update(schema.lead).set({ status: 'VOID' }).where(eq(schema.lead.id, lead.id))
      await tx
        .update(schema.unassignedQueue)
        .set({ resolvedAt: new Date() })
        .where(eq(schema.unassignedQueue.leadId, lead.id))
      await writeAudit(tx, input, lead, null)
      return { leadId: lead.id, repId: null, alreadyVoided: false, cycleReopened: false }
    }

    const repId = assignEvent.repId
    const cycleId = assignEvent.cycleNo

    // 4. free the rep's slot in that cycle — this is what puts them back at the top
    if (repId) {
      await tx
        .delete(schema.rrCycleAssignments)
        .where(
          and(eq(schema.rrCycleAssignments.cycleId, cycleId), eq(schema.rrCycleAssignments.repId, repId)),
        )
    }

    // 5. cycle-close edge: if this assign was the one that closed the cycle, reopen it and
    //    drop the empty cycle that was opened in its place. Without this, an undo silently
    //    jumps a whole rotation. Only the still-empty successor is removed — once real
    //    assignments have landed in the new cycle the rotation has genuinely moved on.
    let cycleReopened = false
    const cycle = await tx.query.rotationCycle.findFirst({ where: eq(schema.rotationCycle.id, cycleId) })
    if (cycle?.closedAt) {
      const openCycle = await tx.query.rotationCycle.findFirst({
        where: isNull(schema.rotationCycle.closedAt),
      })
      if (openCycle && openCycle.id !== cycleId) {
        const openCycleUsed = await tx.query.rrCycleAssignments.findFirst({
          where: eq(schema.rrCycleAssignments.cycleId, openCycle.id),
        })
        const consumingOpenCycleEvent = await tx.query.assignmentEvents.findFirst({
          where: and(
            eq(schema.assignmentEvents.cycleNo, openCycle.id),
            ne(schema.assignmentEvents.eventType, 'QUEUE'),
          ),
        })
        if (!openCycleUsed && !consumingOpenCycleEvent) {
          const queueEvent = await tx.query.assignmentEvents.findFirst({
            where: and(
              eq(schema.assignmentEvents.cycleNo, openCycle.id),
              eq(schema.assignmentEvents.eventType, 'QUEUE'),
            ),
          })

          // Retire the successor FIRST — the `one_open_cycle` unique index allows only
          // one closed_at IS NULL row. A truly empty cycle can be deleted. A queue-only
          // cycle must be retained because its append-only QUEUE event has a required FK.
          if (queueEvent) {
            await tx
              .update(schema.rotationCycle)
              .set({ closedAt: new Date() })
              .where(eq(schema.rotationCycle.id, openCycle.id))
          } else {
            await tx.delete(schema.rotationCycle).where(eq(schema.rotationCycle.id, openCycle.id))
          }
          await tx
            .update(schema.rotationCycle)
            .set({ closedAt: null })
            .where(eq(schema.rotationCycle.id, cycleId))
          cycleReopened = true
        }
      }
    }

    // 6. roll the month counters back, and restore last_assigned_at from this rep's
    //    previous surviving ASSIGN (null when this was their first of the period).
    if (repId) {
      const priorAssign = await tx.query.assignmentEvents.findFirst({
        where: and(
          eq(schema.assignmentEvents.repId, repId),
          eq(schema.assignmentEvents.eventType, 'ASSIGN'),
          ne(schema.assignmentEvents.id, assignEvent.id),
          lt(schema.assignmentEvents.createdAt, assignEvent.createdAt),
        ),
        orderBy: [desc(schema.assignmentEvents.createdAt)],
      })

      await tx
        .update(schema.repMonthCounters)
        .set({
          upsMtd: sql`greatest(${schema.repMonthCounters.upsMtd} - 1, 0)`,
          upsToday: sql`greatest(${schema.repMonthCounters.upsToday} - 1, 0)`,
          lastAssignedAt: priorAssign?.createdAt ?? null,
        })
        .where(
          and(
            eq(schema.repMonthCounters.repId, repId),
            eq(schema.repMonthCounters.periodKey, lead.periodKey),
          ),
        )
    }

    // 7. lead + append-only ledger event
    await tx.update(schema.lead).set({ status: 'VOID' }).where(eq(schema.lead.id, lead.id))
    await tx.insert(schema.assignmentEvents).values({
      leadId: lead.id,
      repId,
      eventType: 'VOID',
      cycleNo: cycleId,
      creditDelta: -1,
      queueSnapshot: [],
      idempotencyKey: `void-${lead.id}`,
    })

    await writeAudit(tx, input, lead, repId)

    return { leadId: lead.id, repId, alreadyVoided: false, cycleReopened }
  })

  // 8. publish AFTER commit, never inside the transaction (same rule as assignLead)
  publishAssignment({ type: 'VOID', ...result })
  return result
}

async function writeAudit(
  tx: any,
  input: VoidLeadInput,
  lead: { id: string; assignedRepId: string | null; status: string },
  repId: string | null,
): Promise<void> {
  await tx.insert(schema.auditEvents).values({
    actorUserId: input.actorUserId,
    action: 'lead.void',
    entityType: 'lead',
    entityId: lead.id,
    before: { status: lead.status, assignedRepId: lead.assignedRepId },
    after: { status: 'VOID', repId, reasonNote: input.reasonNote },
  })
}
