/**
 * Development fixture only. Creates a store, a policy, an open cycle and a handful of
 * accounts so the app is clickable on a fresh local database.
 *
 * Two things this deliberately refuses to do:
 *   - run against anything but a local database (see assertLocalDatabase). It used to
 *     issue one shared password to every account, which is the exact thing the project
 *     forbids; a stray `pnpm seed` against production was a real path to a guessable login.
 *   - run against an already-seeded database. `importRoster` throws when a store row
 *     exists, so seeding a real deployment first would strand it — the only recovery is
 *     wiping the database.
 *
 * For a real deployment use `pnpm --filter @phoneup/db import-roster` instead.
 */
import { randomUUID, scryptSync } from 'node:crypto'
import { generateTempPassword } from '@phoneup/core'
import { db, schema } from './client'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

function assertLocalDatabase(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed is a development fixture and refuses to run with NODE_ENV=production')
  }

  const raw = process.env.DATABASE_URL!
  let hostname: string
  try {
    hostname = new URL(raw).hostname
  } catch {
    throw new Error(`could not parse DATABASE_URL to verify it is local: ${raw}`)
  }

  if (!LOCAL_HOSTS.has(hostname)) {
    throw new Error(
      `seed refuses to run against a non-local database (host: ${hostname}). ` +
        'Use `pnpm --filter @phoneup/db import-roster` for a real deployment.',
    )
  }
}

function hashPassword(password: string): string {
  const salt = randomUUID()
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

async function seed() {
  assertLocalDatabase()

  const [existingStore] = await db.select().from(schema.store).limit(1)
  if (existingStore) {
    throw new Error(
      'A store row already exists — refusing to seed an already-initialised database. ' +
        'Drop and recreate the local database first if you want a clean fixture.',
    )
  }

  // Same rule as the roster importer: every account gets its own single-use password and
  // must replace it at first sign-in. No shared secret, not even in a dev fixture.
  const issued: Array<{ role: string; email: string; password: string }> = []

  async function createUser(email: string, role: 'ADMIN' | 'BDC' | 'REP', displayName?: string) {
    const password = generateTempPassword()
    const [user] = await db
      .insert(schema.appUser)
      .values({
        email,
        displayName,
        passwordHash: hashPassword(password),
        role,
        mustChangePassword: true,
      })
      .returning()
    issued.push({ role, email, password })
    return user
  }

  const [store] = await db
    .insert(schema.store)
    .values({ name: 'Main Store', rotationSalt: randomUUID(), settings: {} })
    .returning()

  for (let day = 0; day <= 6; day++) {
    await db.insert(schema.storeHours).values({
      storeId: store.id,
      dayOfWeek: day,
      openTime: day === 0 ? null : '09:00:00',
      closeTime: day === 0 ? null : '20:00:00',
      isClosed: day === 0,
    })
  }

  await createUser('admin@dealership.test', 'ADMIN')
  const bdcUser = await createUser('bdc@dealership.test', 'BDC')

  const [policy] = await db
    .insert(schema.workRequirementPolicy)
    .values({
      minCalls: 3,
      graceDaysAfterHire: 3,
      graceAfterAbsenceDays: 1,
      maxPriorWorkdayAge: 7,
      enforcementMode: 'SHADOW',
    })
    .returning()

  const today = new Date().toISOString().slice(0, 10)
  const repNames = ['Alex Rep', 'Bailey Rep', 'Casey Rep']
  const repIds: string[] = []

  for (const name of repNames) {
    const repUser = await createUser(
      `${name.split(' ')[0].toLowerCase()}@dealership.test`,
      'REP',
      name,
    )

    const [rep] = await db
      .insert(schema.salesRep)
      .values({ userId: repUser.id, displayName: name, hireDate: '2024-01-01' })
      .returning()

    await db.insert(schema.repShift).values({ repId: rep.id, businessDate: today, kind: 'WORK' })
    await db.insert(schema.repDailyStatus).values({
      repId: rep.id,
      businessDate: today,
      status: 'ELIGIBLE',
      decidedBy: 'SYSTEM',
    })
    repIds.push(rep.id)
  }

  const [cycle] = await db.insert(schema.rotationCycle).values({}).returning()
  await db.insert(schema.rrState).values({ currentCycleId: cycle.id, version: 0 })

  console.log('Seed complete:')
  console.log(`  store: ${store.id}`)
  console.log(`  bdc user id: ${bdcUser.id}`)
  console.log(`  reps: ${repIds.join(', ')}`)
  console.log(`  policy: ${policy.id}`)
  console.log(`  open cycle: ${cycle.id}`)

  console.log('\nEach account has its own temporary password and must change it at first sign-in:\n')
  const width = Math.max(...issued.map((i) => i.email.length))
  for (const i of issued) {
    console.log(`  ${i.role.padEnd(6)} ${i.email.padEnd(width)}  ${i.password}`)
  }
  console.log('\nOnly today\'s shifts exist. Run `pnpm --filter @phoneup/api materialize-shifts`')
  console.log('to generate the next 14 days, or eligibility writes CONFIGURATION_ERROR tomorrow.')

  process.exit(0)
}

seed().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
