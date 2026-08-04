import { pgTable, uuid, text, boolean, integer, timestamp, jsonb, smallint, time } from 'drizzle-orm/pg-core'

export const store = pgTable('store', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  rotationSalt: text('rotation_salt').notNull(),
  settings: jsonb('settings').notNull().default({}),
})

export const storeHours = pgTable('store_hours', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').notNull().references(() => store.id),
  dayOfWeek: smallint('day_of_week').notNull(), // 0=Sunday .. 6=Saturday
  openTime: time('open_time'),
  closeTime: time('close_time'),
  isClosed: boolean('is_closed').notNull().default(false),
})

export const storeClosure = pgTable('store_closure', {
  id: uuid('id').primaryKey().defaultRandom(),
  storeId: uuid('store_id').notNull().references(() => store.id),
  closureDate: text('closure_date').notNull(), // YYYY-MM-DD business date
  reason: text('reason'),
})

export const appUser = pgTable('app_user', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  displayName: text('display_name'),
  passwordHash: text('password_hash').notNull(),
  totpSecret: text('totp_secret'),
  role: text('role', { enum: ['ADMIN', 'MANAGER', 'BDC', 'REP'] }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  // Forces a password change before the account can do anything else. Set on any
  // admin-issued temporary password and cleared only by the user choosing their own.
  // Enforced server-side in requirePerm, not just in the UI.
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  // The owner/break-glass account. A protected row cannot be modified or deleted by any
  // other user through the app, and is filtered out of the Users list. Enforced in three
  // places: the domain functions in apps/api/src/domain/userManagement.ts, the
  // protect_app_user Postgres trigger, and userManagement.list. Settable ONLY by the
  // protect-account script — a flag the app can set is a flag an ADMIN session can clear.
  isProtected: boolean('is_protected').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const passwordResetToken = pgTable('password_reset_token', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => appUser.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const salesRep = pgTable('sales_rep', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => appUser.id),
  displayName: text('display_name').notNull(),
  weight: integer('weight').notNull().default(1), // stored as integer*100; UI defaults 1.00, no UI at v1
  isHouseAccount: boolean('is_house_account').notNull().default(false),
  hireDate: text('hire_date').notNull(), // YYYY-MM-DD
})

export const repShift = pgTable('rep_shift', {
  id: uuid('id').primaryKey().defaultRandom(),
  repId: uuid('rep_id').notNull().references(() => salesRep.id),
  businessDate: text('business_date').notNull(), // YYYY-MM-DD
  kind: text('kind', { enum: ['WORK', 'OFF', 'PTO', 'SICK', 'TRAINING', 'SUSPENDED'] }).notNull(),
})
