import { sql } from 'drizzle-orm'
import { db } from '@phoneup/db'

/**
 * Test-only. Flips app_user.is_protected through the same GUC escape hatch the
 * protect-account script uses. Tests cannot set the flag with a plain UPDATE — the
 * protect_app_user trigger blocks turning protection both on and off.
 */
export async function setProtected(userId: string, value: boolean): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local app.protected_write = 'on'`)
    await tx.execute(sql`update app_user set is_protected = ${value} where id = ${userId}::uuid`)
  })
}

/**
 * Test-only cleanup. The trigger blocks DELETE on a protected row outright, so a test that
 * leaves a protected fixture behind would poison every later run.
 */
export async function deleteUserForce(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local app.protected_write = 'on'`)
    await tx.execute(sql`delete from app_user where id = ${userId}::uuid`)
  })
}
