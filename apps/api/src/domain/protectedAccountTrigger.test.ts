import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql, eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { setProtected, deleteUserForce } from './protectedAccount.testutil'

describe('protect_app_user trigger', () => {
  let protectedUserId: string | undefined
  let plainUserId: string | undefined

  beforeAll(async () => {
    // Self-healing: if a previous run was killed between setProtected and afterAll's
    // cleanup, a protected leftover fixture would otherwise need manual GUC SQL to remove,
    // and would poison every later run of this suite. Clear any stale trigger-test rows
    // first, through the same GUC escape hatch, so this file can never wedge itself.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local app.protected_write = 'on'`)
      await tx.execute(sql`delete from app_user where email like 'trigger-%@test.local'`)
    })

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
    if (protectedUserId) await deleteUserForce(protectedUserId)
    if (plainUserId) await deleteUserForce(plainUserId)
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

  it('blocks INSERT with is_protected = true and no GUC', async () => {
    await expect(
      db.insert(schema.appUser).values({
        email: `trigger-insert-blocked-${Date.now()}@test.local`,
        displayName: 'Trigger Insert Blocked',
        passwordHash: 'x',
        role: 'ADMIN',
        isProtected: true,
      }),
    ).rejects.toThrow(/protect-account/)
  })

  it('allows INSERT with is_protected = true when app.protected_write is on', async () => {
    const email = `trigger-insert-allowed-${Date.now()}@test.local`
    let insertedId: string | undefined
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local app.protected_write = 'on'`)
      const [row] = await tx
        .insert(schema.appUser)
        .values({
          email,
          displayName: 'Trigger Insert Allowed',
          passwordHash: 'x',
          role: 'ADMIN',
          isProtected: true,
        })
        .returning()
      insertedId = row.id
    })
    expect(insertedId).toBeDefined()
    const row = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, insertedId as string) })
    expect(row?.isProtected).toBe(true)
    await deleteUserForce(insertedId as string)
  })

  it('allows a password change on a protected row', async () => {
    await db.execute(
      sql`update app_user set password_hash = 'rotated', must_change_password = true where id = ${protectedUserId}::uuid`,
    )
    const row = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, protectedUserId as string) })
    expect(row?.passwordHash).toBe('rotated')
  })

  it('allows a display name change on a protected row', async () => {
    await db.execute(sql`update app_user set display_name = 'Renamed' where id = ${protectedUserId}::uuid`)
    const row = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, protectedUserId as string) })
    expect(row?.displayName).toBe('Renamed')
  })

  it('allows a totp_secret change on a protected row', async () => {
    await db.execute(sql`update app_user set totp_secret = 'SECRET123' where id = ${protectedUserId}::uuid`)
    const row = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, protectedUserId as string) })
    expect(row?.totpSecret).toBe('SECRET123')
  })

  it('allows a blocked change when app.protected_write is on', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local app.protected_write = 'on'`)
      await tx.execute(sql`update app_user set is_active = false where id = ${protectedUserId}::uuid`)
    })
    const row = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, protectedUserId as string) })
    expect(row?.isActive).toBe(false)

    await db.transaction(async (tx) => {
      await tx.execute(sql`set local app.protected_write = 'on'`)
      await tx.execute(sql`update app_user set is_active = true where id = ${protectedUserId}::uuid`)
    })
  })

  it('leaves unprotected rows fully writable', async () => {
    await db.execute(sql`update app_user set role = 'BDC' where id = ${plainUserId}::uuid`)
    const row = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, plainUserId as string) })
    expect(row?.role).toBe('BDC')
  })

  it('allows DELETE of an unprotected row', async () => {
    const [row] = await db
      .insert(schema.appUser)
      .values({
        email: `trigger-plain-delete-${Date.now()}@test.local`,
        displayName: 'Trigger Plain Delete',
        passwordHash: 'x',
        role: 'BDC',
      })
      .returning()
    await db.execute(sql`delete from app_user where id = ${row.id}::uuid`)
    const found = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, row.id) })
    expect(found).toBeUndefined()
  })
})
