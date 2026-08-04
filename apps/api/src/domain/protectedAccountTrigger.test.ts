import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql, eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { setProtected, deleteUserForce } from './protectedAccount.testutil'

describe('protect_app_user trigger', () => {
  let protectedUserId: string
  let plainUserId: string

  beforeAll(async () => {
    const stamp = Date.now()
    const [protectedUser] = await db
      .insert(schema.appUser)
      .values({
        email: `trigger-protected-${stamp}@test.local`,
        displayName: 'Trigger Protected',
        passwordHash: 'x',
        role: 'ADMIN',
      })
      .returning()
    const [plainUser] = await db
      .insert(schema.appUser)
      .values({
        email: `trigger-plain-${stamp}@test.local`,
        displayName: 'Trigger Plain',
        passwordHash: 'x',
        role: 'MANAGER',
      })
      .returning()
    protectedUserId = protectedUser.id
    plainUserId = plainUser.id
    await setProtected(protectedUserId, true)
  })

  afterAll(async () => {
    await deleteUserForce(protectedUserId)
    await deleteUserForce(plainUserId)
  })

  it('blocks a role change on a protected row', async () => {
    await expect(
      db.execute(sql`update app_user set role = 'REP' where id = ${protectedUserId}::uuid`),
    ).rejects.toThrow(/is protected/)
  })

  it('blocks deactivating a protected row', async () => {
    await expect(
      db.execute(sql`update app_user set is_active = false where id = ${protectedUserId}::uuid`),
    ).rejects.toThrow(/is protected/)
  })

  it('blocks an email change on a protected row', async () => {
    await expect(
      db.execute(sql`update app_user set email = 'moved@test.local' where id = ${protectedUserId}::uuid`),
    ).rejects.toThrow(/is protected/)
  })

  it('blocks DELETE of a protected row', async () => {
    await expect(
      db.execute(sql`delete from app_user where id = ${protectedUserId}::uuid`),
    ).rejects.toThrow(/is protected/)
  })

  it('blocks clearing is_protected without the GUC', async () => {
    await expect(
      db.execute(sql`update app_user set is_protected = false where id = ${protectedUserId}::uuid`),
    ).rejects.toThrow(/is protected/)
  })

  it('blocks setting is_protected on an unprotected row without the GUC', async () => {
    await expect(
      db.execute(sql`update app_user set is_protected = true where id = ${plainUserId}::uuid`),
    ).rejects.toThrow(/protect-account/)
  })

  it('allows a password change on a protected row', async () => {
    await db.execute(
      sql`update app_user set password_hash = 'rotated', must_change_password = true where id = ${protectedUserId}::uuid`,
    )
    const row = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, protectedUserId) })
    expect(row?.passwordHash).toBe('rotated')
  })

  it('allows a display name change on a protected row', async () => {
    await db.execute(sql`update app_user set display_name = 'Renamed' where id = ${protectedUserId}::uuid`)
    const row = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, protectedUserId) })
    expect(row?.displayName).toBe('Renamed')
  })

  it('allows a blocked change when app.protected_write is on', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local app.protected_write = 'on'`)
      await tx.execute(sql`update app_user set is_active = false where id = ${protectedUserId}::uuid`)
    })
    const row = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, protectedUserId) })
    expect(row?.isActive).toBe(false)

    await db.transaction(async (tx) => {
      await tx.execute(sql`set local app.protected_write = 'on'`)
      await tx.execute(sql`update app_user set is_active = true where id = ${protectedUserId}::uuid`)
    })
  })

  it('leaves unprotected rows fully writable', async () => {
    await db.execute(sql`update app_user set role = 'BDC' where id = ${plainUserId}::uuid`)
    const row = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, plainUserId) })
    expect(row?.role).toBe('BDC')
  })
})
