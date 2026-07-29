import { randomUUID, scryptSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { db, schema } from './client'

const ADMIN_EMAIL = 'seanzmc9613@gmail.com'
const TEMP_PASSWORD = 'changeme'

const ROLE_MAP = {
  Sales: 'REP',
  BDC: 'BDC',
  Manager: 'MANAGER',
} as const

type TsvRole = keyof typeof ROLE_MAP

function hashPassword(password: string): string {
  const salt = randomUUID()
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function parseRoster(tsv: string): Array<{ name: string; email: string; role: TsvRole }> {
  const lines = tsv.split('\n').filter((line) => line.trim().length > 0)
  const [, ...rows] = lines // skip header

  return rows.map((line, i) => {
    const [name, email, role] = line.split('\t')
    if (!name || !email || !role) {
      throw new Error(`Row ${i + 2}: expected "Name\\tEmail\\tRole", got: ${JSON.stringify(line)}`)
    }
    if (!(role in ROLE_MAP)) {
      throw new Error(`Row ${i + 2}: unknown role "${role}" (expected Sales, BDC, or Manager)`)
    }
    return { name, email, role: role as TsvRole }
  })
}

async function importRoster() {
  const tsvPath = resolve(process.cwd(), process.argv[2] ?? './Name Email Role.tsv')
  const tsv = readFileSync(tsvPath, 'utf-8')
  const rows = parseRoster(tsv)
  const today = new Date().toISOString().slice(0, 10)

  const counts = { REP: 0, BDC: 0, MANAGER: 0 }

  await db.transaction(async (tx) => {
    const [existingStore] = await tx.select().from(schema.store).limit(1)
    if (existingStore) {
      throw new Error(
        'A store row already exists — refusing to import into an already-seeded database. ' +
          'This guard prevents a duplicate/partial import. If this is intentional, clear the target DB first.',
      )
    }

    const [store] = await tx
      .insert(schema.store)
      .values({ name: 'Main Store', rotationSalt: randomUUID(), settings: {} })
      .returning()

    for (let day = 0; day <= 6; day++) {
      await tx.insert(schema.storeHours).values({
        storeId: store.id,
        dayOfWeek: day,
        openTime: day === 0 ? null : '09:00:00',
        closeTime: day === 0 ? null : '20:00:00',
        isClosed: day === 0,
      })
    }

    await tx.insert(schema.workRequirementPolicy).values({
      minCalls: 3,
      graceDaysAfterHire: 3,
      graceAfterAbsenceDays: 1,
      maxPriorWorkdayAge: 7,
      enforcementMode: 'SHADOW',
    })

    await tx.insert(schema.appUser).values({
      email: ADMIN_EMAIL,
      passwordHash: hashPassword(TEMP_PASSWORD),
      role: 'ADMIN',
    })

    for (const row of rows) {
      const appRole = ROLE_MAP[row.role]
      const [user] = await tx
        .insert(schema.appUser)
        .values({
          email: row.email,
          passwordHash: hashPassword(TEMP_PASSWORD),
          role: appRole,
        })
        .returning()

      counts[appRole]++

      if (appRole === 'REP') {
        const [rep] = await tx
          .insert(schema.salesRep)
          .values({ userId: user.id, displayName: row.name, hireDate: today })
          .returning()

        await tx.insert(schema.repShift).values({ repId: rep.id, businessDate: today, kind: 'WORK' })
        await tx.insert(schema.repDailyStatus).values({
          repId: rep.id,
          businessDate: today,
          status: 'ELIGIBLE',
          decidedBy: 'SYSTEM',
        })
      }
    }

    const [cycle] = await tx.insert(schema.rotationCycle).values({}).returning()
    await tx.insert(schema.rrState).values({ currentCycleId: cycle.id, version: 0 })
  })

  console.log('Roster import complete:')
  console.log(`  total accounts: ${rows.length + 1} (${rows.length} imported + 1 admin)`)
  console.log(`  reps (Sales, rotation members): ${counts.REP}`)
  console.log(`  BDC: ${counts.BDC}`)
  console.log(`  managers: ${counts.MANAGER}`)
  console.log(`  admin login: ${ADMIN_EMAIL} / ${TEMP_PASSWORD}`)
  console.log(`  all imported accounts share temp password: ${TEMP_PASSWORD}`)

  process.exit(0)
}

importRoster().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
