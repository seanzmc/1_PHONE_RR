import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import type { Role } from '@phoneup/contracts'

const SESSION_TTL_MS = 1000 * 60 * 60 * 12 // 12h

export async function createSession(userId: string): Promise<{ id: string; expiresAt: Date }> {
  const id = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await db.insert(schema.session).values({ id, userId, expiresAt })
  return { id, expiresAt }
}

export async function loadSession(sessionId: string): Promise<{ userId: string; role: Role } | null> {
  const row = await db.query.session.findFirst({ where: eq(schema.session.id, sessionId) })
  if (!row || row.expiresAt.getTime() < Date.now()) return null

  const user = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, row.userId) })
  if (!user || !user.isActive) return null

  return { userId: user.id, role: user.role as Role }
}

export async function destroySession(sessionId: string): Promise<void> {
  await db.delete(schema.session).where(eq(schema.session.id, sessionId))
}
