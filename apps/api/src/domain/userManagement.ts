import { sql, eq, and, ne } from 'drizzle-orm'
import type { DB } from '@phoneup/db'
import { schema } from '@phoneup/db'
import { businessDate } from '@phoneup/core'
import type { Role } from '@phoneup/contracts'
import { hashPassword } from '../auth/password'

const ADVISORY_LOCK_KEY = 42_100_1 // same key as assignLead/overrideStatus — this touches rotation ordering too

export async function createAccount(
  db: DB,
  input: { email: string; displayName: string; role: Role; password: string; actorUserId: string },
): Promise<{ userId: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)

    const [user] = await tx
      .insert(schema.appUser)
      .values({
        email: input.email,
        displayName: input.displayName,
        passwordHash: hashPassword(input.password),
        role: input.role,
      })
      .returning()

    if (input.role === 'REP') {
      const today = businessDate(new Date())
      const [rep] = await tx
        .insert(schema.salesRep)
        .values({ userId: user.id, displayName: input.displayName, hireDate: today })
        .returning()
      await tx.insert(schema.repShift).values({ repId: rep.id, businessDate: today, kind: 'WORK' })
      await tx.insert(schema.repDailyStatus).values({
        repId: rep.id,
        businessDate: today,
        status: 'ELIGIBLE',
        decidedBy: 'SYSTEM',
      })
    }

    await tx.insert(schema.auditEvents).values({
      actorUserId: input.actorUserId,
      action: 'user.create',
      entityType: 'app_user',
      entityId: user.id,
      before: null,
      after: { email: input.email, role: input.role, displayName: input.displayName },
    })

    return { userId: user.id }
  })
}
