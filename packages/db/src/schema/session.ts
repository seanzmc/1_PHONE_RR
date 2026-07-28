import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'
import { appUser } from './store'

export const session = pgTable('session', {
  id: text('id').primaryKey(), // random session token, stored directly (not hashed — httpOnly + short TTL is enough at this scale)
  userId: uuid('user_id').notNull().references(() => appUser.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})
