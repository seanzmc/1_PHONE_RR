import { randomUUID, scryptSync } from 'node:crypto'
import { db, schema } from './client'

function hashPassword(password: string): string {
  const salt = randomUUID()
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

async function seed() {
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

  const [adminUser] = await db
    .insert(schema.appUser)
    .values({
      email: 'admin@dealership.test',
      passwordHash: hashPassword('changeme'),
      role: 'ADMIN',
    })
    .returning()

  const [bdcUser] = await db
    .insert(schema.appUser)
    .values({
      email: 'bdc@dealership.test',
      passwordHash: hashPassword('changeme'),
      role: 'BDC',
    })
    .returning()

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
    const [repUser] = await db
      .insert(schema.appUser)
      .values({
        email: `${name.split(' ')[0].toLowerCase()}@dealership.test`,
        passwordHash: hashPassword('changeme'),
        role: 'REP',
      })
      .returning()

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
  console.log(`  admin user: admin@dealership.test / changeme`)
  console.log(`  bdc user (seed-bdc-user id): ${bdcUser.id}`)
  console.log(`  reps: ${repIds.join(', ')}`)
  console.log(`  policy: ${policy.id}`)
  console.log(`  open cycle: ${cycle.id}`)

  process.exit(0)
}

seed().catch((err) => {
  console.error(err)
  process.exit(1)
})
