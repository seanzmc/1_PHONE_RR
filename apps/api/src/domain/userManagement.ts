import { sql, eq, and, ne } from 'drizzle-orm'
import type { DB } from '@phoneup/db'
import { schema } from '@phoneup/db'
import { businessDate } from '@phoneup/core'
import type { Role } from '@phoneup/contracts'
import { hashPassword, verifyPassword } from '../auth/password'
import { materializeShifts } from '../jobs/eligibility'

const ADVISORY_LOCK_KEY = 42_100_1 // same key as assignLead/overrideStatus — this touches rotation ordering too

/**
 * A rep with no rep_shift row for a date gets CONFIGURATION_ERROR from the eligibility job
 * and drops out of the rotation. The weekly materialization cron only runs Sunday 03:00, so
 * a rep added mid-week would have today (inserted inline, as the fail-safe) and nothing
 * else until then. Fill the window forward as soon as the rep exists.
 *
 * Called AFTER the enclosing transaction commits, never inside it: materializeShifts opens
 * its own transaction and takes the same advisory lock on a different pooled connection,
 * so nesting it would block on a lock the caller still holds.
 */
async function materializeNewRepShifts(db: DB, repId: string): Promise<void> {
  await materializeShifts(db, { repIds: [repId] })
}

export async function createAccount(
  db: DB,
  input: { email: string; displayName: string; role: Role; password: string; actorUserId: string },
): Promise<{ userId: string }> {
  const passwordHash = hashPassword(input.password)

  const { userId, repId } = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)

    const [user] = await tx
      .insert(schema.appUser)
      .values({
        email: input.email,
        displayName: input.displayName,
        passwordHash,
        role: input.role,
        // the admin picked this password, so the new user must replace it on first login
        mustChangePassword: true,
      })
      .returning()

    let newRepId: string | null = null
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
      newRepId = rep.id
    }

    await tx.insert(schema.auditEvents).values({
      actorUserId: input.actorUserId,
      action: 'user.create',
      entityType: 'app_user',
      entityId: user.id,
      before: null,
      after: { email: input.email, role: input.role, displayName: input.displayName },
    })

    return { userId: user.id, repId: newRepId }
  })

  if (repId) await materializeNewRepShifts(db, repId)

  return { userId }
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
  const promotedRepId = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)

    const user = await tx.query.appUser.findFirst({ where: eq(schema.appUser.id, input.userId) })
    if (!user) throw new Error('user not found')

    const oldRole = user.role as Role
    let becameRepId: string | null = null

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
      becameRepId = rep.id
    }

    await tx.insert(schema.auditEvents).values({
      actorUserId: input.actorUserId,
      action: 'user.setRole',
      entityType: 'app_user',
      entityId: input.userId,
      before: { role: oldRole },
      after: { role: input.newRole },
    })

    return becameRepId
  })

  if (promotedRepId) await materializeNewRepShifts(db, promotedRepId)
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
  input: { userId: string; newPassword: string; actorUserId: string; mustChangePassword?: boolean },
): Promise<void> {
  const passwordHash = hashPassword(input.newPassword)
  // An admin-issued password is temporary by default: the user must replace it on next
  // login before they can use anything else.
  const mustChange = input.mustChangePassword ?? true

  await db.transaction(async (tx) => {
    const user = await tx.query.appUser.findFirst({ where: eq(schema.appUser.id, input.userId) })
    if (!user) throw new Error('user not found')

    await tx
      .update(schema.appUser)
      .set({ passwordHash, mustChangePassword: mustChange })
      .where(eq(schema.appUser.id, input.userId))

    await tx.delete(schema.session).where(eq(schema.session.userId, input.userId))

    await tx.insert(schema.auditEvents).values({
      actorUserId: input.actorUserId,
      action: 'user.resetPassword',
      entityType: 'app_user',
      entityId: input.userId,
      before: { mustChangePassword: user.mustChangePassword },
      after: { passwordReset: true, mustChangePassword: mustChange },
    })
  })
}

/**
 * A user setting their OWN password. Requires the current password, which is what makes
 * this safe to expose to every role, and clears mustChangePassword — the flag can only be
 * cleared by the user choosing a secret nobody else has seen.
 *
 * Other sessions for the account are revoked; the caller's own session is kept so the
 * forced-change flow doesn't bounce them back to the login screen.
 */
export async function changeOwnPassword(
  db: DB,
  input: { userId: string; currentPassword?: string; newPassword: string; keepSessionId?: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const user = await tx.query.appUser.findFirst({ where: eq(schema.appUser.id, input.userId) })
    if (!user) throw new Error('user not found')

    if (!user.mustChangePassword) {
      if (!input.currentPassword) throw new Error('CURRENT_PASSWORD_REQUIRED')
      if (!verifyPassword(input.currentPassword, user.passwordHash)) {
        throw new Error('current password is incorrect')
      }
    }
    if (verifyPassword(input.newPassword, user.passwordHash)) {
      throw new Error('new password must be different from the current one')
    }

    await tx
      .update(schema.appUser)
      .set({ passwordHash: hashPassword(input.newPassword), mustChangePassword: false })
      .where(eq(schema.appUser.id, input.userId))

    // revoke every other session for this account
    await tx
      .delete(schema.session)
      .where(
        input.keepSessionId
          ? and(eq(schema.session.userId, input.userId), ne(schema.session.id, input.keepSessionId))
          : eq(schema.session.userId, input.userId),
      )

    await tx.insert(schema.auditEvents).values({
      actorUserId: input.userId,
      action: 'user.changeOwnPassword',
      entityType: 'app_user',
      entityId: input.userId,
      before: { mustChangePassword: user.mustChangePassword },
      after: { mustChangePassword: false },
    })
  })
}
