import { z } from 'zod'
import { and, desc, eq, gte, lt, or, sql, type SQL } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { publicProcedure, router } from '../trpc/router'
import { requirePerm } from '../trpc/requirePerm'

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12) return false
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= daysInMonth[month - 1]
}

const calendarDateSchema = z.string().refine(isCalendarDate, 'Expected a real calendar date in YYYY-MM-DD format')
const affectedSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('USER'), id: z.string().uuid() }),
  z.object({ kind: z.literal('REP'), id: z.string().uuid() }),
  z.object({ kind: z.literal('LEAD'), id: z.string().uuid() }),
])

const inputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
  action: z.string().min(1).optional(),
  actorUserId: z.string().uuid().optional(),
  affected: affectedSchema.optional(),
  fromDate: calendarDateSchema.optional(),
  toDate: calendarDateSchema.optional(),
}).superRefine((input, ctx) => {
  if (input.fromDate && input.toDate && input.fromDate > input.toDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['toDate'],
      message: 'To date must not be before from date',
    })
  }
})

const ACTION_LABELS: Record<string, string> = {
  'activity.import': 'Imported daily activity',
  'activity.metric.edit': 'Corrected activity metrics',
  'lead.assign': 'Assigned lead',
  'lead.note.set': 'Updated lead note',
  'lead.queue': 'Queued unassigned lead',
  'lead.reassign': 'Reassigned lead',
  'lead.skip': 'Skipped rep and passed lead',
  'lead.void': 'Voided lead',
  'policy.set': 'Updated activity policy',
  'rep.days_off.set': 'Changed recurring day off',
  'rep.override': 'Changed rep status',
  'user.changeOwnPassword': 'Changed own password',
  'user.create': 'Created account',
  'user.protectedWriteDenied': 'Denied change to protected account',
  'user.resetPassword': 'Reset account password',
  'user.setActive': 'Changed account access',
  'user.setRole': 'Changed account role',
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action
    .replace(/\./g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (letter) => letter.toUpperCase())
}

function labelledPeople(rows: Array<{ id: string; visibleLabel: string }>): Array<{ id: string; label: string }> {
  const labelCounts = new Map<string, number>()
  for (const row of rows) labelCounts.set(row.visibleLabel, (labelCounts.get(row.visibleLabel) ?? 0) + 1)

  return rows
    .map((row) => ({
      id: row.id,
      label: labelCounts.get(row.visibleLabel)! > 1
        ? `${row.visibleLabel} (${row.id.slice(-8)})`
        : row.visibleLabel,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id))
}

export const auditRouter = router({
  list: publicProcedure.use(requirePerm('audit.view')).input(inputSchema).query(async ({ input }) => {
    const conditions: SQL[] = []
    if (input.action) conditions.push(eq(schema.auditEvents.action, input.action))
    if (input.actorUserId) conditions.push(eq(schema.auditEvents.actorUserId, input.actorUserId))
    if (input.affected) {
      const entityIdMatches = eq(schema.auditEvents.entityId, input.affected.id)
      if (input.affected.kind === 'USER') {
        conditions.push(and(entityIdMatches, eq(schema.auditEvents.entityType, 'app_user'))!)
      } else if (input.affected.kind === 'LEAD') {
        conditions.push(and(entityIdMatches, eq(schema.auditEvents.entityType, 'lead'))!)
      } else {
        conditions.push(and(
          entityIdMatches,
          or(
            eq(schema.auditEvents.entityType, 'sales_rep'),
            eq(schema.auditEvents.entityType, 'rep_daily_status'),
            and(
              eq(schema.auditEvents.entityType, 'rep_daily_activity'),
              eq(schema.auditEvents.action, 'activity.metric.edit'),
            ),
          ),
        )!)
      }
    }
    if (input.fromDate) {
      conditions.push(gte(
        schema.auditEvents.createdAt,
        sql`${input.fromDate}::date::timestamp AT TIME ZONE 'America/New_York'`,
      ))
    }
    if (input.toDate) {
      conditions.push(lt(
        schema.auditEvents.createdAt,
        sql`(${input.toDate}::date + 1)::timestamp AT TIME ZONE 'America/New_York'`,
      ))
    }

    const rows = await db
      .select({ event: schema.auditEvents, actor: schema.appUser })
      .from(schema.auditEvents)
      .leftJoin(schema.appUser, eq(schema.auditEvents.actorUserId, schema.appUser.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(schema.auditEvents.createdAt), desc(schema.auditEvents.id))
      .limit(input.limit + 1)
      .offset(input.offset)

    const hasMore = rows.length > input.limit
    return {
      items: rows.slice(0, input.limit).map(({ event, actor }) => ({
        id: event.id,
        createdAt: event.createdAt.toISOString(),
        actor: actor ? { displayName: actor.displayName, email: actor.email } : null,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        before: event.before,
        after: event.after,
      })),
      hasMore,
    }
  }),

  filterOptions: publicProcedure.use(requirePerm('audit.view')).query(async () => {
    const [actionRows, actorRows, userRows, repRows] = await Promise.all([
      db.selectDistinct({ action: schema.auditEvents.action }).from(schema.auditEvents),
      db
        .selectDistinct({
          id: schema.auditEvents.actorUserId,
          displayName: schema.appUser.displayName,
          email: schema.appUser.email,
        })
        .from(schema.auditEvents)
        .leftJoin(schema.appUser, eq(schema.auditEvents.actorUserId, schema.appUser.id)),
      db.select({ id: schema.appUser.id, displayName: schema.appUser.displayName, email: schema.appUser.email })
        .from(schema.appUser),
      db.select({ id: schema.salesRep.id, displayName: schema.salesRep.displayName }).from(schema.salesRep),
    ])

    return {
      actions: actionRows
        .map(({ action }) => ({ value: action, label: actionLabel(action) }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) || a.value.localeCompare(b.value)),
      actors: labelledPeople(actorRows.map((actor) => ({
        id: actor.id,
        visibleLabel: actor.displayName ?? actor.email ?? actor.id,
      }))),
      users: labelledPeople(userRows.map((user) => ({
        id: user.id,
        visibleLabel: user.displayName ?? user.email,
      }))),
      reps: labelledPeople(repRows.map((rep) => ({ id: rep.id, visibleLabel: rep.displayName }))),
    }
  }),
})
