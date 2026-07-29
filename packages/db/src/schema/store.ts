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
