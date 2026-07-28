import { pgTable, uuid, text, integer, timestamp, jsonb } from 'drizzle-orm/pg-core'
import { salesRep } from './store'
import { lead } from './lead'

export const reactivationRequest = pgTable('reactivation_request', {
  id: uuid('id').primaryKey().defaultRandom(),
  repId: uuid('rep_id').notNull().references(() => salesRep.id),
  claimText: text('claim_text').notNull(),
  status: text('status', { enum: ['PENDING', 'APPROVED', 'DENIED'] }).notNull().default('PENDING'),
  reviewedBy: uuid('reviewed_by'),
  reviewReasonNote: text('review_reason_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
})

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorUserId: uuid('actor_user_id').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // append-only: UPDATE/DELETE revoked for the app role via raw SQL in migration, no hash-chain sealing at v1.
})

export const unassignedQueue = pgTable('unassigned_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  leadId: uuid('lead_id').notNull().references(() => lead.id),
  reason: text('reason').notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const dailyFacts = pgTable('daily_facts', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessDate: text('business_date').notNull(),
  repId: uuid('rep_id').references(() => salesRep.id),
  upsCount: integer('ups_count').notNull().default(0),
  skipsCount: integer('skips_count').notNull().default(0),
  overridesCount: integer('overrides_count').notNull().default(0),
  disqualifiedCount: integer('disqualified_count').notNull().default(0),
})
