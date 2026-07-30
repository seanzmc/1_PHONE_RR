import { pgTable, uuid, text, integer, timestamp, unique, smallint } from 'drizzle-orm/pg-core'
import { salesRep } from './store'

export const workRequirementPolicy = pgTable('work_requirement_policy', {
  id: uuid('id').primaryKey().defaultRandom(),
  minCalls: integer('min_calls').notNull(),
  graceDaysAfterHire: integer('grace_days_after_hire').notNull().default(0),
  graceAfterAbsenceDays: integer('grace_after_absence_days').notNull().default(0),
  maxPriorWorkdayAge: integer('max_prior_workday_age').notNull().default(7),
  enforcementMode: text('enforcement_mode', { enum: ['SHADOW', 'ENFORCE'] }).notNull().default('SHADOW'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const eligibilitySnapshot = pgTable('eligibility_snapshot', {
  id: uuid('id').primaryKey().defaultRandom(),
  repId: uuid('rep_id').notNull().references(() => salesRep.id),
  businessDate: text('business_date').notNull(),
  evaluatedPriorWorkday: text('evaluated_prior_workday'),
  callsFound: integer('calls_found').notNull().default(0),
  minCallsRequired: integer('min_calls_required').notNull(),
  wouldBeStatus: text('would_be_status', { enum: ['ELIGIBLE', 'INELIGIBLE', 'CONFIGURATION_ERROR'] }).notNull(),
  reason: text('reason'),
  policyId: uuid('policy_id').notNull().references(() => workRequirementPolicy.id),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const repDailyStatus = pgTable('rep_daily_status', {
  id: uuid('id').primaryKey().defaultRandom(),
  repId: uuid('rep_id').notNull().references(() => salesRep.id),
  businessDate: text('business_date').notNull(),
  status: text('status', { enum: ['ELIGIBLE', 'INELIGIBLE', 'CONFIGURATION_ERROR'] }).notNull(),
  reason: text('reason'),
  decidedBy: text('decided_by', { enum: ['SYSTEM', 'MANAGER_OVERRIDE'] }).notNull().default('SYSTEM'),
  dailyCap: integer('daily_cap'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  repDateUnique: unique('rep_daily_status_rep_date_unique').on(table.repId, table.businessDate),
}))

export const statusOverride = pgTable('status_override', {
  id: uuid('id').primaryKey().defaultRandom(),
  repId: uuid('rep_id').notNull().references(() => salesRep.id),
  status: text('status', { enum: ['FORCE_ACTIVE', 'FORCE_INACTIVE', 'FOLLOW_SCHEDULE'] }).notNull(),
  reasonCode: text('reason_code').notNull(),
  reasonNote: text('reason_note').notNull(),
  actorUserId: uuid('actor_user_id').notNull(),
  businessDate: text('business_date').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * One row per rep per business date — the aggregate the CRM "Standard-Daily Activity"
 * export actually produces (design pass §H). Replaces per-call `lead_activity` rows as
 * the eligibility input; `lead_activity` remains for optional note context only.
 *
 * `source` guards manager corrections: a re-import overwrites 'IMPORT' rows and skips
 * 'MANUAL' ones, and the unique (rep_id, business_date) key + upsert is what keeps
 * SUM(sold) over a period honest under repeated imports.
 */
export const repDailyActivity = pgTable('rep_daily_activity', {
  id: uuid('id').primaryKey().defaultRandom(),
  repId: uuid('rep_id').notNull().references(() => salesRep.id),
  businessDate: text('business_date').notNull(), // YYYY-MM-DD
  calls: integer('calls').notNull().default(0),
  sold: integer('sold').notNull().default(0),
  source: text('source', { enum: ['IMPORT', 'MANUAL'] }).notNull().default('IMPORT'),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  repDateUnique: unique('rep_daily_activity_rep_date_unique').on(table.repId, table.businessDate),
}))

/**
 * Recurring weekly day off (design pass §I). A table, not a column: a rep can have
 * more than one, and an array column can't be joined cleanly.
 * 0=Sunday..6=Saturday, matching store_hours.day_of_week.
 */
export const repRecurringDayOff = pgTable('rep_recurring_day_off', {
  id: uuid('id').primaryKey().defaultRandom(),
  repId: uuid('rep_id').notNull().references(() => salesRep.id),
  dayOfWeek: smallint('day_of_week').notNull(),
}, (table) => ({
  repDayUnique: unique('rep_recurring_day_off_rep_day_unique').on(table.repId, table.dayOfWeek),
}))
