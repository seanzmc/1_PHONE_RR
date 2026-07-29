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
  const passwordHash = hashPassword(input.password)

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)

    const [user] = await tx
      .insert(schema.appUser)
      .values({
        email: input.email,
        displayName: input.displayName,
        passwordHash,
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

async function applyRepRotationStatus(
  tx: any,
  repId: string,
  status: 'ELIGIBLE' | 'INELIGIBLE',
  reasonNote: string,
): Promise<void> {
  const today = businessDate(new Date())
  const existing = await tx.query.repDailyStatus.findFirst({
    where: and(eq(schema.repDailyStatus.repId, repId), eq(schema.repDailyStatus.businessDate, today)),
  })

  if (existing) {
    await tx
      .update(schema.repDailyStatus)
      .set({ status, decidedBy: 'MANAGER_OVERRIDE', reason: reasonNote, updatedAt: new Date() })
      .where(eq(schema.repDailyStatus.id, existing.id))
  } else {
    await tx.insert(schema.repDailyStatus).values({
      repId,
      businessDate: today,
      status,
      reason: reasonNote,
      decidedBy: 'MANAGER_OVERRIDE',
    })
  }
}

async function ensureTodayShift(tx: any, repId: string): Promise<void> {
  const today = businessDate(new Date())
  const existing = await tx.query.repShift.findFirst({
    where: and(eq(schema.repShift.repId, repId), eq(schema.repShift.businessDate, today)),
  })
  if (!existing) {
    await tx.insert(schema.repShift).values({ repId, businessDate: today, kind: 'WORK' })
  }
}

export async function setRole(
  db: DB,
  input: { userId: string; newRole: Role; actorUserId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)

    const user = await tx.query.appUser.findFirst({ where: eq(schema.appUser.id, input.userId) })
    if (!user) throw new Error('user not found')

    const oldRole = user.role as Role

    if (oldRole === 'ADMIN' && input.newRole !== 'ADMIN') {
      const others = await tx
        .select()
        .from(schema.appUser)
        .where(
          and(
            eq(schema.appUser.role, 'ADMIN'),
            eq(schema.appUser.isActive, true),
            ne(schema.appUser.id, input.userId),
          ),
        )
      if (others.length === 0) throw new Error('cannot change role: this is the last active ADMIN account')
    }

    await tx.update(schema.appUser).set({ role: input.newRole }).where(eq(schema.appUser.id, input.userId))

    if (oldRole === 'REP' && input.newRole !== 'REP') {
      const rep = await tx.query.salesRep.findFirst({ where: eq(schema.salesRep.userId, input.userId) })
      if (rep) {
        await applyRepRotationStatus(tx, rep.id, 'INELIGIBLE', `role changed to ${input.newRole}`)
      }
    } else if (oldRole !== 'REP' && input.newRole === 'REP') {
      let rep = await tx.query.salesRep.findFirst({ where: eq(schema.salesRep.userId, input.userId) })
      if (!rep) {
        const today = businessDate(new Date())
        const inserted = await tx
          .insert(schema.salesRep)
          .values({ userId: input.userId, displayName: user.displayName ?? user.email, hireDate: today })
          .returning()
        rep = inserted[0]
      } else {
        await tx
          .update(schema.salesRep)
          .set({ displayName: user.displayName ?? user.email })
          .where(eq(schema.salesRep.id, rep.id))
      }
      await ensureTodayShift(tx, rep.id)
      await applyRepRotationStatus(
        tx,
        rep.id,
        user.isActive ? 'ELIGIBLE' : 'INELIGIBLE',
        user.isActive ? 'role changed to REP' : 'role changed to REP (account inactive)',
      )
    }

    await tx.insert(schema.auditEvents).values({
      actorUserId: input.actorUserId,
      action: 'user.setRole',
      entityType: 'app_user',
      entityId: input.userId,
      before: { role: oldRole },
      after: { role: input.newRole },
    })
  })
}

export async function setActive(
  db: DB,
  input: { userId: string; isActive: boolean; actorUserId: string },
): Promise<void> {
  if (input.userId === input.actorUserId && !input.isActive) {
    throw new Error('cannot deactivate your own account')
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)

    const user = await tx.query.appUser.findFirst({ where: eq(schema.appUser.id, input.userId) })
    if (!user) throw new Error('user not found')

    if (user.role === 'ADMIN' && !input.isActive) {
      const others = await tx
        .select()
        .from(schema.appUser)
        .where(
          and(
            eq(schema.appUser.role, 'ADMIN'),
            eq(schema.appUser.isActive, true),
            ne(schema.appUser.id, input.userId),
          ),
        )
      if (others.length === 0) throw new Error('cannot deactivate: this is the last active ADMIN account')
    }

    await tx.update(schema.appUser).set({ isActive: input.isActive }).where(eq(schema.appUser.id, input.userId))

    if (user.role === 'REP') {
      const rep = await tx.query.salesRep.findFirst({ where: eq(schema.salesRep.userId, input.userId) })
      if (rep) {
        await applyRepRotationStatus(
          tx,
          rep.id,
          input.isActive ? 'ELIGIBLE' : 'INELIGIBLE',
          input.isActive ? 'account reactivated' : 'account deactivated',
        )
      }
    }

    await tx.insert(schema.auditEvents).values({
      actorUserId: input.actorUserId,
      action: 'user.setActive',
      entityType: 'app_user',
      entityId: input.userId,
      before: { isActive: user.isActive },
      after: { isActive: input.isActive },
    })
  })
}

export async function resetPassword(
  db: DB,
  input: { userId: string; newPassword: string; actorUserId: string },
): Promise<void> {
  const passwordHash = hashPassword(input.newPassword)

  await db.transaction(async (tx) => {
    const user = await tx.query.appUser.findFirst({ where: eq(schema.appUser.id, input.userId) })
    if (!user) throw new Error('user not found')

    await tx
      .update(schema.appUser)
      .set({ passwordHash })
      .where(eq(schema.appUser.id, input.userId))

    await tx.delete(schema.session).where(eq(schema.session.userId, input.userId))

    await tx.insert(schema.auditEvents).values({
      actorUserId: input.actorUserId,
      action: 'user.resetPassword',
      entityType: 'app_user',
      entityId: input.userId,
      before: null,
      after: { passwordReset: true },
    })
  })
}
