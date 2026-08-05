import { pgTable, uuid, text, integer, timestamp, jsonb, unique } from 'drizzle-orm/pg-core'
import { salesRep } from './store'
import { lead } from './lead'

export const rotationCycle = pgTable('rotation_cycle', {
  id: uuid('id').primaryKey().defaultRandom(),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  // partial unique index `one_open_cycle` (store_id WHERE closed_at IS NULL) added by hand in migration SQL
})

export const rrCycleAssignments = pgTable('rr_cycle_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  cycleId: uuid('cycle_id').notNull().references(() => rotationCycle.id),
  repId: uuid('rep_id').notNull().references(() => salesRep.id),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
})

export const rrState = pgTable('rr_state', {
  id: uuid('id').primaryKey().defaultRandom(),
  currentCycleId: uuid('current_cycle_id').references(() => rotationCycle.id),
  version: integer('version').notNull().default(0),
})

export const assignmentEvents = pgTable('assignment_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  leadId: uuid('lead_id').references(() => lead.id),
  repId: uuid('rep_id').references(() => salesRep.id),
  eventType: text('event_type', {
    enum: ['ASSIGN', 'QUEUE', 'SKIP', 'VOID', 'REASSIGN_OUT', 'REASSIGN_IN', 'BALANCE_CREDIT'],
  }).notNull(),
  cycleNo: uuid('cycle_no').notNull().references(() => rotationCycle.id),
  creditDelta: integer('credit_delta').notNull().default(0),
  queueSnapshot: jsonb('queue_snapshot').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // append-only: UPDATE/DELETE revoked for the app role via raw SQL in migration, no hash-chain.
})

export const repMonthCounters = pgTable('rep_month_counters', {
  id: uuid('id').primaryKey().defaultRandom(),
  repId: uuid('rep_id').notNull().references(() => salesRep.id),
  periodKey: text('period_key').notNull(),
  upsMtd: integer('ups_mtd').notNull().default(0),
  chargedSkipsMtd: integer('charged_skips_mtd').notNull().default(0),
  creditMtd: integer('credit_mtd').notNull().default(0),
  upsToday: integer('ups_today').notNull().default(0),
  lastAssignedAt: timestamp('last_assigned_at', { withTimezone: true }),
}, (table) => ({
  repPeriodUnique: unique('rep_month_counters_rep_period_unique').on(table.repId, table.periodKey),
}))
