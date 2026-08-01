import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import type { DB } from '@phoneup/db'
import { schema } from '@phoneup/db'
import { hashPassword } from '../auth/password'
import type { PasswordResetEmailSender } from '../email/resend'

export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000
export const RESET_LINK_INVALID_OR_EXPIRED = 'RESET_LINK_INVALID_OR_EXPIRED'

export type PasswordRecoveryDeps = {
  sendEmail: PasswordResetEmailSender
  appBaseUrl: string
  now?: () => Date
  randomToken?: () => string
  logDeliveryFailure?: (error: unknown) => void
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function safeDeliveryError(error: unknown): Error {
  const message = error instanceof Error ? error.message : ''
  if (/^(Resend email request failed \(\d{3}\)|Resend email is not configured)$/.test(message)) {
    return new Error(message)
  }
  return new Error('Password reset email delivery failed')
}

export async function requestPasswordReset(
  db: DB,
  input: { email: string },
  deps: PasswordRecoveryDeps,
): Promise<void> {
  const normalizedEmail = input.email.trim().toLowerCase()
  const [user] = await db
    .select()
    .from(schema.appUser)
    .where(
      and(
        sql`lower(${schema.appUser.email}) = ${normalizedEmail}`,
        eq(schema.appUser.isActive, true),
      ),
    )
    .limit(1)

  if (!user) return

  const now = deps.now?.() ?? new Date()
  const token = deps.randomToken?.() ?? randomBytes(32).toString('base64url')
  const tokenHash = hashResetToken(token)
  const expiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_MS)

  await db.insert(schema.passwordResetToken).values({
    userId: user.id,
    tokenHash,
    expiresAt,
  })

  const resetUrl = new URL('/', deps.appBaseUrl)
  resetUrl.searchParams.set('reset_token', token)

  try {
    await deps.sendEmail({
      to: user.email,
      displayName: user.displayName,
      resetUrl: resetUrl.toString(),
      expiresAt,
    })
  } catch (error) {
    await db
      .update(schema.passwordResetToken)
      .set({ usedAt: now })
      .where(eq(schema.passwordResetToken.tokenHash, tokenHash))
    deps.logDeliveryFailure?.(safeDeliveryError(error))
  }
}

export async function completePasswordReset(
  db: DB,
  input: { token: string; newPassword: string },
  now = new Date(),
): Promise<void> {
  const tokenHash = hashResetToken(input.token)

  await db.transaction(async (tx) => {
    const [match] = await tx
      .select({
        token: schema.passwordResetToken,
        user: schema.appUser,
      })
      .from(schema.passwordResetToken)
      .innerJoin(schema.appUser, eq(schema.passwordResetToken.userId, schema.appUser.id))
      .where(
        and(
          eq(schema.passwordResetToken.tokenHash, tokenHash),
          isNull(schema.passwordResetToken.usedAt),
          gt(schema.passwordResetToken.expiresAt, now),
          eq(schema.appUser.isActive, true),
        ),
      )
      .for('update')

    if (!match) throw new Error(RESET_LINK_INVALID_OR_EXPIRED)

    await tx
      .update(schema.appUser)
      .set({ passwordHash: hashPassword(input.newPassword), mustChangePassword: false })
      .where(eq(schema.appUser.id, match.user.id))

    await tx
      .update(schema.passwordResetToken)
      .set({ usedAt: now })
      .where(
        and(
          eq(schema.passwordResetToken.userId, match.user.id),
          isNull(schema.passwordResetToken.usedAt),
        ),
      )

    await tx.delete(schema.session).where(eq(schema.session.userId, match.user.id))

    await tx.insert(schema.auditEvents).values({
      actorUserId: match.user.id,
      action: 'user.resetOwnPassword',
      entityType: 'app_user',
      entityId: match.user.id,
      before: { mustChangePassword: match.user.mustChangePassword },
      after: { source: 'self_service', mustChangePassword: false },
    })
  })
}
