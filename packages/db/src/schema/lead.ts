import { pgTable, uuid, text, boolean, timestamp } from 'drizzle-orm/pg-core'
import { salesRep } from './store'

export const customer = pgTable('customer', {
  id: uuid('id').primaryKey().defaultRandom(),
  fullName: text('full_name').notNull(),
  phoneE164: text('phone_e164').notNull().unique(),
  // phone_digits is a GENERATED ALWAYS AS column added by hand in the migration SQL
  // (Drizzle's DSL can't express generated columns) — declared as plain text here
  // so typed reads see it; drizzle-kit must not be allowed to "fix" it back to non-generated.
  phoneDigits: text('phone_digits'),
  doNotCall: boolean('do_not_call').notNull().default(false),
})

export const lead = pgTable('lead', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').notNull().references(() => customer.id),
  assignedRepId: uuid('assigned_rep_id').references(() => salesRep.id),
  status: text('status', { enum: ['ASSIGNED', 'UNASSIGNED', 'VOID'] }).notNull(),
  businessDate: text('business_date').notNull(),
  periodKey: text('period_key').notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const leadActivity = pgTable('lead_activity', {
  id: uuid('id').primaryKey().defaultRandom(),
  repId: uuid('rep_id').notNull().references(() => salesRep.id),
  leadId: uuid('lead_id').references(() => lead.id),
  noteBody: text('note_body'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  businessDate: text('business_date').notNull(),
  entrySource: text('entry_source', { enum: ['CRM_IMPORT'] }).notNull().default('CRM_IMPORT'),
})
