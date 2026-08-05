# Protected Owner Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one ADMIN account (`seanzmc9613@gmail.com`) unmodifiable and invisible to every other user of the app, while it keeps signing in normally and keeps writing to the audit log.

**Architecture:** A single `app_user.is_protected` boolean, enforced in three layers — a rejection in the three domain functions that write other users' rows, a Postgres `BEFORE UPDATE OR DELETE` trigger with a session-GUC escape hatch, and a filter on the one query that lists users. The flag is set only by a new CLI script, never from the app. Recovery stays with the existing `recover-admin` break-glass script, which gains an explicit opt-in to write protected rows.

**Tech Stack:** TypeScript, Fastify + tRPC v11 + Zod, Drizzle ORM, PostgreSQL, vitest, pnpm workspaces.

## Global Constraints

- Design source of truth: `docs/superpowers/specs/2026-08-04-protected-owner-account-design.md`. Read it before starting.
- Role set stays exactly ADMIN / MANAGER / BDC / REP. Do not add a role.
- The api test suite reads `TEST_DATABASE_URL`, never `DATABASE_URL`, and refuses any database whose name lacks `test`. Do not change that.
- `pnpm typecheck` is the only thing that typechecks `apps/api` — it ships via `tsx`, which strips types without checking them. Run it before every commit.
- New migrations are produced by `drizzle-kit generate` and then hand-edited to append raw SQL, following the existing pattern in `packages/db/src/migrations/0000_pretty_whistler.sql` (which appends `REVOKE UPDATE, DELETE` statements after the generated DDL). Raw statements are separated by `--> statement-breakpoint`.
- The GUC name is exactly `app.protected_write` and its enabling value is exactly the string `'on'`. Any other value, or unset, means protection is enforced.
- The audit action strings are exactly `user.protectedWriteDenied` and `user.setProtected`.
- The error message constant is exactly `PROTECTED_ACCOUNT: this account cannot be modified from the application`.
- Before running the api suite for the first time after Task 1, apply migrations to the test database:
  `DATABASE_URL=$TEST_DATABASE_URL pnpm --filter @phoneup/db migrate`

---

## File Structure

**Create:**
- `packages/db/src/protectAccount.ts` — the `protect-account` CLI. Sets or clears `is_protected`, dry-run by default. Sole writer of the flag.
- `apps/api/src/domain/protectedAccount.testutil.ts` — shared test helper that flips `is_protected` via the GUC. Needed by three test files; keeping one copy prevents three subtly different SQL escapes.
- `apps/api/src/domain/protectedAccountTrigger.test.ts` — Layer B tests. Raw SQL only, no domain code.
- `apps/api/src/domain/protectedAccount.test.ts` — Layer A tests. Domain function rejections and the denied-attempt audit row.

**Modify:**
- `packages/db/src/schema/store.ts:26-39` — add the `is_protected` column to `appUser`.
- `packages/db/src/migrations/` — one new generated migration, hand-extended with the trigger.
- `apps/api/src/domain/userManagement.ts` — add `rejectIfProtected`, wire it into `setRole`, `setActive`, `resetPassword`; add the `allowProtected` opt-in.
- `apps/api/src/routers/userManagement.ts:18-29` — filter `list`; `:59-65` — add the missing target-is-ADMIN guard to `setActive`.
- `apps/api/src/routers/userManagement.test.ts` — router-level tests for the filter and the `setActive` guard.
- `apps/api/src/recoverAdmin.ts` — opt in to protected writes; wrap the reactivation in a GUC transaction; mark protected accounts in its listing.
- `packages/db/package.json` — register the `protect-account` script.
- `docs/RUNBOOK.md`, `CLAUDE.md` — document the script and the flag.

---

### Task 1: Schema column and the Layer B trigger

**Files:**
- Modify: `packages/db/src/schema/store.ts:26-39`
- Create: `packages/db/src/migrations/<NNNN>_<generated_name>.sql` (name assigned by drizzle-kit)
- Create: `apps/api/src/domain/protectedAccount.testutil.ts`
- Test: `apps/api/src/domain/protectedAccountTrigger.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `schema.appUser.isProtected` — Drizzle column, `boolean('is_protected')`, not null, default false.
  - `setProtected(userId: string, value: boolean): Promise<void>` exported from `apps/api/src/domain/protectedAccount.testutil.ts` — flips the flag through the GUC escape hatch. Every later task's tests use this to build fixtures.
  - `deleteUserForce(userId: string): Promise<void>` exported from the same file — deletes an `app_user` row through the GUC escape hatch, for test cleanup that the trigger would otherwise block.
  - SQL trigger `protect_app_user` on `app_user`, backed by function `protect_app_user_row()`.

- [ ] **Step 1: Add the column to the Drizzle schema**

In `packages/db/src/schema/store.ts`, inside the `appUser` table definition, add the column immediately after `mustChangePassword` and before `createdAt`:

```ts
  // The owner/break-glass account. A protected row cannot be modified or deleted by any
  // other user through the app, and is filtered out of the Users list. Enforced in three
  // places: the domain functions in apps/api/src/domain/userManagement.ts, the
  // protect_app_user Postgres trigger, and userManagement.list. Settable ONLY by the
  // protect-account script — a flag the app can set is a flag an ADMIN session can clear.
  isProtected: boolean('is_protected').notNull().default(false),
```

`boolean` is already imported at the top of the file. Do not add an import.

- [ ] **Step 2: Generate the migration**

```bash
pnpm --filter @phoneup/db generate
```

This writes a new `packages/db/src/migrations/NNNN_*.sql` containing one `ALTER TABLE` and appends an entry to `meta/_journal.json`. Note the generated filename — the next step edits it.

Expected generated SQL (roughly):

```sql
ALTER TABLE "app_user" ADD COLUMN "is_protected" boolean DEFAULT false NOT NULL;
```

- [ ] **Step 3: Hand-append the trigger to the generated migration**

Open the file generated in Step 2. Append the following, starting with a `--> statement-breakpoint` line to separate it from the generated `ALTER TABLE`. This mirrors how `0000_pretty_whistler.sql` appends its `REVOKE` statements.

```sql
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_app_user_row() RETURNS trigger AS $$
BEGIN
  -- The deliberate escape hatch, used by protect-account and recover-admin. This does not
  -- defend against a DATABASE_URL holder -- they can set the GUC themselves, and can already
  -- rewrite every row. It defends against a future router or job that writes app_user
  -- directly and never learned about the domain-layer guard.
  IF coalesce(current_setting('app.protected_write', true), 'off') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- Turning protection ON is restricted too: otherwise an ADMIN session could protect a
  -- colleague's account and lock them out of their own role.
  IF TG_OP = 'UPDATE' AND NOT OLD.is_protected AND NEW.is_protected THEN
    RAISE EXCEPTION 'app_user row %: is_protected can only be set by the protect-account script', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT OLD.is_protected THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'app_user row % is protected: DELETE is not permitted', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- password_hash, must_change_password, display_name and totp_secret stay writable, which
  -- is what keeps auth.changeOwnPassword and the forgot-password flow working with no GUC.
  IF NEW.email IS DISTINCT FROM OLD.email
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.is_active IS DISTINCT FROM OLD.is_active
     OR NEW.is_protected IS DISTINCT FROM OLD.is_protected THEN
    RAISE EXCEPTION 'app_user row % is protected: email, role, is_active and is_protected cannot be changed', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS protect_app_user ON "app_user";
--> statement-breakpoint
CREATE TRIGGER protect_app_user
BEFORE UPDATE OR DELETE ON "app_user"
FOR EACH ROW EXECUTE FUNCTION protect_app_user_row();
```

- [ ] **Step 4: Apply the migration to the test database**

```bash
DATABASE_URL=${TEST_DATABASE_URL:-postgresql://localhost/phoneup_test} pnpm --filter @phoneup/db migrate
```

Expected: drizzle-kit reports the new migration applied. If it errors on the `$$` body, confirm each raw statement is separated by its own `--> statement-breakpoint` line.

- [ ] **Step 5: Write the test helper**

Create `apps/api/src/domain/protectedAccount.testutil.ts`:

```ts
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
```

- [ ] **Step 6: Write the failing trigger tests**

Create `apps/api/src/domain/protectedAccountTrigger.test.ts`:

```ts
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
```

- [ ] **Step 7: Run the trigger tests**

```bash
pnpm --filter @phoneup/api test -- protectedAccountTrigger
```

Expected: all PASS. If the "blocks..." cases pass but "allows a password change" fails, the trigger's column comparison list is too broad — it must name only `email`, `role`, `is_active`, `is_protected`.

- [ ] **Step 8: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/schema/store.ts packages/db/src/migrations apps/api/src/domain/protectedAccount.testutil.ts apps/api/src/domain/protectedAccountTrigger.test.ts
git commit -m "feat(db): add is_protected column and protect_app_user trigger"
```

---

### Task 2: Layer A — domain guards and denied-attempt logging

**Files:**
- Modify: `apps/api/src/domain/userManagement.ts`
- Test: `apps/api/src/domain/protectedAccount.test.ts`

**Interfaces:**
- Consumes: `schema.appUser.isProtected` (Task 1); `setProtected`, `deleteUserForce` (Task 1).
- Produces:
  - `PROTECTED_ACCOUNT_ERROR: string` exported from `apps/api/src/domain/userManagement.ts`.
  - `setActive(db, { userId, isActive, actorUserId, allowProtected?: boolean })` — new optional field.
  - `resetPassword(db, { userId, newPassword, actorUserId, mustChangePassword?, allowProtected?: boolean })` — new optional field.
  - `setRole` signature unchanged; it has no `allowProtected` because no script needs to change a protected account's role.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/domain/protectedAccount.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { setProtected, deleteUserForce } from './protectedAccount.testutil'
import {
  createAccount,
  setRole,
  setActive,
  resetPassword,
  changeOwnPassword,
  PROTECTED_ACCOUNT_ERROR,
} from './userManagement'

describe('protected account — domain guards', () => {
  let protectedUserId: string
  let actorUserId: string
  let sacrificialAdminId: string

  beforeAll(async () => {
    const stamp = Date.now()
    // A second active ADMIN so the "last active ADMIN" guards never fire first and mask
    // the protection rejection we are actually testing.
    const sacrificial = await createAccount(db, {
      email: `guard-admin-${stamp}@test.local`,
      displayName: 'Guard Admin',
      role: 'ADMIN',
      password: 'temp-password-234',
      actorUserId: '00000000-0000-0000-0000-000000000000',
    })
    sacrificialAdminId = sacrificial.userId
    actorUserId = sacrificial.userId

    const owner = await createAccount(db, {
      email: `guard-owner-${stamp}@test.local`,
      displayName: 'Guard Owner',
      role: 'ADMIN',
      password: 'temp-password-235',
      actorUserId: sacrificial.userId,
    })
    protectedUserId = owner.userId
    await setProtected(protectedUserId, true)
  })

  afterAll(async () => {
    await deleteUserForce(protectedUserId)
    await deleteUserForce(sacrificialAdminId)
  })

  async function deniedRowCount(): Promise<number> {
    const rows = await db
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.entityId, protectedUserId),
          eq(schema.auditEvents.action, 'user.protectedWriteDenied'),
        ),
      )
    return rows.length
  }

  it('rejects setRole against a protected account', async () => {
    await expect(
      setRole(db, { userId: protectedUserId, newRole: 'REP', actorUserId }),
    ).rejects.toThrow(PROTECTED_ACCOUNT_ERROR)
  })

  it('rejects setActive against a protected account', async () => {
    await expect(
      setActive(db, { userId: protectedUserId, isActive: false, actorUserId }),
    ).rejects.toThrow(PROTECTED_ACCOUNT_ERROR)
  })

  it('rejects resetPassword against a protected account', async () => {
    await expect(
      resetPassword(db, { userId: protectedUserId, newPassword: 'nope-nope-234', actorUserId }),
    ).rejects.toThrow(PROTECTED_ACCOUNT_ERROR)
  })

  it('rejects the protected account acting on itself', async () => {
    await expect(
      setRole(db, { userId: protectedUserId, newRole: 'MANAGER', actorUserId: protectedUserId }),
    ).rejects.toThrow(PROTECTED_ACCOUNT_ERROR)
  })

  it('writes one denied audit row per rejected attempt, and the row survives the rejection', async () => {
    const before = await deniedRowCount()
    await expect(
      setActive(db, { userId: protectedUserId, isActive: false, actorUserId }),
    ).rejects.toThrow(PROTECTED_ACCOUNT_ERROR)
    expect(await deniedRowCount()).toBe(before + 1)

    const [latest] = await db
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.entityId, protectedUserId),
          eq(schema.auditEvents.action, 'user.protectedWriteDenied'),
        ),
      )
    expect(latest.actorUserId).toBe(actorUserId)
  })

  it('leaves the protected account untouched after a rejected attempt', async () => {
    const row = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, protectedUserId) })
    expect(row?.role).toBe('ADMIN')
    expect(row?.isActive).toBe(true)
  })

  it('allows the protected account to change its own password', async () => {
    await changeOwnPassword(db, {
      userId: protectedUserId,
      currentPassword: 'temp-password-235',
      newPassword: 'chosen-password-236',
    })
    const row = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, protectedUserId) })
    expect(row?.mustChangePassword).toBe(false)
  })

  it('allows resetPassword with allowProtected, for recover-admin', async () => {
    await resetPassword(db, {
      userId: protectedUserId,
      newPassword: 'recovered-password-237',
      actorUserId: protectedUserId,
      allowProtected: true,
    })
    const row = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, protectedUserId) })
    expect(row?.mustChangePassword).toBe(true)
  })

  it('allows setActive with allowProtected, for recover-admin', async () => {
    await setActive(db, {
      userId: protectedUserId,
      isActive: true,
      actorUserId: protectedUserId,
      allowProtected: true,
    })
    const row = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, protectedUserId) })
    expect(row?.isActive).toBe(true)
  })

  it('leaves unprotected accounts writable', async () => {
    await setActive(db, { userId: sacrificialAdminId, isActive: true, actorUserId })
    const row = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, sacrificialAdminId) })
    expect(row?.isActive).toBe(true)
  })

  // The forgot-password flow writes only password_hash and must_change_password, never calls
  // resetPassword, and must keep working for the protected account — it is the account's
  // self-service recovery when the mailbox is reachable.
  it('allows the forgot-password flow to complete against a protected account', async () => {
    const token = 'protected-account-reset-token-fixture'
    await db.insert(schema.passwordResetToken).values({
      userId: protectedUserId,
      tokenHash: hashResetToken(token),
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    })

    await completePasswordReset(db, { token, newPassword: 'self-service-238' })

    const row = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, protectedUserId) })
    expect(row?.mustChangePassword).toBe(false)
  })

  // The last-active-ADMIN guards must still count the protected admin. If they skipped it, a
  // visible ADMIN could be demoted into what looks like a zero-admin state.
  it('counts the protected admin when guarding the last active ADMIN', async () => {
    await setActive(db, {
      userId: protectedUserId,
      isActive: true,
      actorUserId: protectedUserId,
      allowProtected: true,
    })

    // The seeded ADMIN is active too, so without this the guard would pass whether or not it
    // counted the protected admin — the assertion would prove nothing. Park every other
    // active ADMIN so the protected one is the only thing standing between the sacrificial
    // admin and a zero-admin state.
    const activeAdmins = await db
      .select()
      .from(schema.appUser)
      .where(and(eq(schema.appUser.role, 'ADMIN'), eq(schema.appUser.isActive, true)))
    const parked = activeAdmins.filter(
      (u: any) => u.id !== protectedUserId && u.id !== sacrificialAdminId,
    )

    for (const u of parked) {
      await db.update(schema.appUser).set({ isActive: false }).where(eq(schema.appUser.id, u.id))
    }
    try {
      await expect(
        setActive(db, { userId: sacrificialAdminId, isActive: false, actorUserId: protectedUserId }),
      ).resolves.toBeUndefined()
    } finally {
      for (const u of parked) {
        await db.update(schema.appUser).set({ isActive: true }).where(eq(schema.appUser.id, u.id))
      }
      await setActive(db, {
        userId: sacrificialAdminId,
        isActive: true,
        actorUserId: protectedUserId,
      })
    }
  })
})
```

Add to that file's imports:

```ts
import {
  completePasswordReset,
  hashResetToken,
  RESET_TOKEN_TTL_MS,
} from './passwordRecovery'
```

Check `completePasswordReset`'s actual parameter shape in `apps/api/src/domain/passwordRecovery.ts:80` before writing the call — if it takes a deps object as a second argument, thread it through the same way `passwordRecovery.test.ts` does.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @phoneup/api test -- protectedAccount.test
```

Expected: FAIL — `PROTECTED_ACCOUNT_ERROR` is not exported from `./userManagement`.

- [ ] **Step 3: Add the guard helper**

In `apps/api/src/domain/userManagement.ts`, add the `TRPCError` import at the top:

```ts
import { TRPCError } from '@trpc/server'
```

Then add, immediately after the `ADVISORY_LOCK_KEY` constant:

```ts
export const PROTECTED_ACCOUNT_ERROR =
  'PROTECTED_ACCOUNT: this account cannot be modified from the application'

/**
 * The one gate for the owner/break-glass account. Rejects regardless of actor — including
 * the protected user acting on itself, so a mis-click cannot brick the account. Recovery is
 * the recover-admin script, which passes allowProtected.
 *
 * Deliberately runs OUTSIDE the caller's transaction. The three callers load their target
 * inside db.transaction, and throwing there rolls the transaction back — an audit insert
 * made inside it would vanish along with the rejection it exists to record. The window
 * between this read and the caller's transaction is backstopped by the protect_app_user
 * trigger, which rejects the same writes at the database.
 *
 * It throws a TRPCError rather than a plain Error so a manager who clicks the wrong row
 * gets a FORBIDDEN, not a 500. The domain layer already lives inside apps/api, which
 * depends on @trpc/server directly.
 */
async function rejectIfProtected(
  db: DB,
  input: {
    userId: string
    actorUserId: string
    attempted: 'setRole' | 'setActive' | 'resetPassword'
    allowProtected?: boolean
  },
): Promise<void> {
  if (input.allowProtected) return

  const target = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, input.userId) })
  if (!target?.isProtected) return

  await db.insert(schema.auditEvents).values({
    actorUserId: input.actorUserId,
    action: 'user.protectedWriteDenied',
    entityType: 'app_user',
    entityId: input.userId,
    before: null,
    after: { attempted: input.attempted },
  })

  throw new TRPCError({ code: 'FORBIDDEN', message: PROTECTED_ACCOUNT_ERROR })
}
```

- [ ] **Step 4: Wire the guard into the three writers**

In `setRole`, insert as the first statement of the function body, before `const promotedRepId = await db.transaction(...)`:

```ts
  await rejectIfProtected(db, {
    userId: input.userId,
    actorUserId: input.actorUserId,
    attempted: 'setRole',
  })
```

In `setActive`, widen the input type to `{ userId: string; isActive: boolean; actorUserId: string; allowProtected?: boolean }`, then insert after the existing self-deactivation check and before `await db.transaction(...)`:

```ts
  await rejectIfProtected(db, {
    userId: input.userId,
    actorUserId: input.actorUserId,
    attempted: 'setActive',
    allowProtected: input.allowProtected,
  })
```

In `resetPassword`, widen the input type to `{ userId: string; newPassword: string; actorUserId: string; mustChangePassword?: boolean; allowProtected?: boolean }`, then insert as the first statement of the function body, before `const passwordHash = hashPassword(input.newPassword)`:

```ts
  await rejectIfProtected(db, {
    userId: input.userId,
    actorUserId: input.actorUserId,
    attempted: 'resetPassword',
    allowProtected: input.allowProtected,
  })
```

Leave `changeOwnPassword` and `createAccount` untouched. `changeOwnPassword` requires the current password and writes only columns the trigger permits; `createAccount` cannot collide because `app_user.email` is unique.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @phoneup/api test -- protectedAccount.test
```

Expected: all PASS.

- [ ] **Step 6: Run the whole api suite for regressions**

```bash
pnpm --filter @phoneup/api test
```

Expected: all PASS. `issueTempPassword` is covered implicitly — it funnels through `resetPassword`.

- [ ] **Step 7: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/domain/userManagement.ts apps/api/src/domain/protectedAccount.test.ts
git commit -m "feat(api): reject writes to protected accounts and log denied attempts"
```

---

### Task 3: Layer C — hide the account, and close the setActive ADMIN hole

**Files:**
- Modify: `apps/api/src/routers/userManagement.ts:18-29` and `:59-65`
- Modify: `apps/api/src/routers/auth.ts:163-179` (`viewAsProfiles`)
- Test: `apps/api/src/routers/userManagement.test.ts`
- Test: `apps/api/src/routers/auth.test.ts`

**Interfaces:**
- Consumes: `schema.appUser.isProtected` (Task 1); `PROTECTED_ACCOUNT_ERROR` (Task 2); `setProtected`, `deleteUserForce` (Task 1).
- Produces: `userManagement.list` and `auth.viewAsProfiles` output shapes are unchanged — no `isProtected` field is exposed. The web client needs no change.

**Correction to the design's Layer C:** the spec claimed "No other query lists users." That is wrong. `auth.viewAsProfiles` (`apps/api/src/routers/auth.ts:163`) selects every active user, gated on `admin.*`. Left unfiltered, the owner account still appears in the View-as picker to any other ADMIN — which defeats the hiding for exactly the audience it matters most for. Step 4a below closes it.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routers/userManagement.test.ts`. Reuse the `fakeSession` and `fakeReqRes` helpers already defined at the top of that file — do not redefine them.

```ts
describe('userManagementRouter — protected account', () => {
  let protectedUserId: string
  let plainAdminId: string

  beforeAll(async () => {
    const stamp = Date.now()
    const plain = await createAccount(db, {
      email: `router-admin-${stamp}@test.local`,
      displayName: 'Router Admin',
      role: 'ADMIN',
      password: 'temp-password-334',
      actorUserId: '00000000-0000-0000-0000-000000000000',
    })
    plainAdminId = plain.userId

    const owner = await createAccount(db, {
      email: `router-owner-${stamp}@test.local`,
      displayName: 'Router Owner',
      role: 'ADMIN',
      password: 'temp-password-335',
      actorUserId: plain.userId,
    })
    protectedUserId = owner.userId
    await setProtected(protectedUserId, true)
  })

  afterAll(async () => {
    await deleteUserForce(protectedUserId)
    await deleteUserForce(plainAdminId)
  })

  it('omits the protected account from list for an ADMIN caller', async () => {
    const caller = t.createCallerFactory(userManagementRouter)({
      session: fakeSession(plainAdminId, 'ADMIN'),
      ...fakeReqRes,
    })
    const rows = await caller.list()
    expect(rows.some((u) => u.id === protectedUserId)).toBe(false)
    expect(rows.some((u) => u.id === plainAdminId)).toBe(true)
  })

  it('omits the protected account from list for a MANAGER caller', async () => {
    const caller = t.createCallerFactory(userManagementRouter)({
      session: fakeSession(plainAdminId, 'MANAGER'),
      ...fakeReqRes,
    })
    const rows = await caller.list()
    expect(rows.some((u) => u.id === protectedUserId)).toBe(false)
  })

  it('returns the full list, protected rows included, to a protected caller', async () => {
    const caller = t.createCallerFactory(userManagementRouter)({
      session: fakeSession(protectedUserId, 'ADMIN'),
      ...fakeReqRes,
    })
    const rows = await caller.list()
    expect(rows.some((u) => u.id === protectedUserId)).toBe(true)
    expect(rows.some((u) => u.id === plainAdminId)).toBe(true)
  })

  it('rejects an ADMIN issuing a temp password for the protected account', async () => {
    const caller = t.createCallerFactory(userManagementRouter)({
      session: fakeSession(plainAdminId, 'ADMIN'),
      ...fakeReqRes,
    })
    await expect(caller.issueTempPassword({ userId: protectedUserId })).rejects.toThrow(
      /PROTECTED_ACCOUNT/,
    )
  })

  it('rejects an ADMIN deactivating the protected account', async () => {
    const caller = t.createCallerFactory(userManagementRouter)({
      session: fakeSession(plainAdminId, 'ADMIN'),
      ...fakeReqRes,
    })
    await expect(
      caller.setActive({ userId: protectedUserId, isActive: false }),
    ).rejects.toThrow(/PROTECTED_ACCOUNT/)
  })

  it('rejects a MANAGER deactivating any ADMIN', async () => {
    const caller = t.createCallerFactory(userManagementRouter)({
      session: fakeSession('manager-session-user', 'MANAGER'),
      ...fakeReqRes,
    })
    await expect(
      caller.setActive({ userId: plainAdminId, isActive: false }),
    ).rejects.toThrow(/FORBIDDEN/)
  })
})
```

Add to the existing imports at the top of that file:

```ts
import { beforeAll, afterAll } from 'vitest'
import { setProtected, deleteUserForce } from '../domain/protectedAccount.testutil'
```

`describe`, `it`, `expect`, `db`, `schema`, `t`, `userManagementRouter` and `createAccount` are already imported there. Merge `beforeAll`/`afterAll` into the existing `vitest` import rather than adding a second import line.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @phoneup/api test -- routers/userManagement
```

Expected: the two `list` filtering cases FAIL (the protected row is still returned), and "rejects a MANAGER deactivating any ADMIN" FAILS (the guard does not exist yet). The `issueTempPassword` and ADMIN-`setActive` cases should already PASS from Task 2.

- [ ] **Step 3: Filter the list query**

Replace the `list` procedure in `apps/api/src/routers/userManagement.ts`:

```ts
  /**
   * The protected owner account is filtered out for everyone else — it is invisible in the
   * Users page by design. A protected caller gets the unfiltered list so it can see itself,
   * and so a second protected account would not be invisible to the first.
   */
  list: publicProcedure.use(requirePerm('user.manage')).query(async ({ ctx }) => {
    // One query, filtered in memory. Do NOT look the caller up with
    // `eq(schema.appUser.id, ctx.session.userId)` — existing tests in this file build
    // sessions with non-UUID ids like 'u1', and Postgres rejects those with
    // "invalid input syntax for type uuid" before any filtering happens.
    const all = await db.select().from(schema.appUser)
    const caller = all.find((u: any) => u.id === ctx.session.userId)
    const rows = caller?.isProtected ? all : all.filter((u: any) => !u.isProtected)

    return rows.map((u: any) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      isActive: u.isActive,
      mustChangePassword: u.mustChangePassword,
      createdAt: u.createdAt.toISOString(),
    }))
  }),
```

`eq` and `db`/`schema` are already imported in this file.

- [ ] **Step 4: Add the missing ADMIN guard to setActive**

Replace the `setActive` procedure in the same file. This is the pre-existing hole: it was the only user-management route with no target-is-ADMIN check, so a MANAGER could deactivate any ADMIN. The guard mirrors the one already in `resetPassword`.

```ts
  setActive: publicProcedure
    .use(requirePerm('user.manage'))
    .input(setActiveInputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!hasPermission(ctx.session.role, 'admin.*')) {
        const target = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, input.userId) })
        if (target?.role === 'ADMIN') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'only an ADMIN can activate or deactivate an ADMIN account',
          })
        }
      }

      await setActive(db, { ...input, actorUserId: ctx.session.userId })
      return { ok: true }
    }),
```

`TRPCError` and `hasPermission` are already imported in this file.

- [ ] **Step 4a: Filter the View-as picker**

`auth.viewAsProfiles` (`apps/api/src/routers/auth.ts:163`) selects every active user and is gated on `admin.*`. Unfiltered, the owner account stays visible in the View-as picker to every other ADMIN — the audience the hiding exists for. Apply the same rule as `list`: a protected caller sees everything, everyone else sees no protected rows.

Replace its query and return:

```ts
  viewAsProfiles: publicProcedure.use(requirePerm('admin.*')).query(async ({ ctx }) => {
    const users = await db
      .select({
        userId: schema.appUser.id,
        role: schema.appUser.role,
        email: schema.appUser.email,
        displayName: schema.appUser.displayName,
        isProtected: schema.appUser.isProtected,
      })
      .from(schema.appUser)
      // View-as is an ADMIN inspection tool, not authentication as the target. New-hire
      // accounts commonly still hold a temporary password; excluding them made the list
      // collapse to the ADMIN's own profile before onboarding was complete.
      .where(eq(schema.appUser.isActive, true))

    // Same rule as userManagement.list: the protected owner account is invisible to
    // everyone but itself. Filtered in memory because session ids are not guaranteed to
    // parse as UUIDs in tests.
    const caller = users.find((u) => u.userId === ctx.session.userId)
    const visible = caller?.isProtected ? users : users.filter((u) => !u.isProtected)

    return visible
      .map(({ isProtected: _isProtected, ...u }) => u)
      .sort((a, b) =>
        (a.displayName ?? a.email).localeCompare(b.displayName ?? b.email, undefined, { sensitivity: 'base' }),
      )
  }),
```

The `isProtected` field is selected only to filter on and is stripped before returning, so the wire shape is unchanged and the web client needs no edit.

- [ ] **Step 4b: Test the View-as filter**

Add to `apps/api/src/routers/auth.test.ts`, following that file's existing caller-construction pattern (read it first — do not assume it matches `userManagement.test.ts`). Two cases, using the same protected fixture approach as Step 1:

- an ADMIN caller's `viewAsProfiles` result contains no protected account
- a protected caller's `viewAsProfiles` result contains itself

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @phoneup/api test -- routers/userManagement
```

Expected: all PASS.

- [ ] **Step 6: Run the whole api suite**

```bash
pnpm --filter @phoneup/api test
```

Expected: all PASS.

- [ ] **Step 7: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routers/userManagement.ts apps/api/src/routers/userManagement.test.ts
git commit -m "feat(api): hide protected accounts from the Users list; gate setActive on ADMIN"
```

---

### Task 4: The protect-account script

**Files:**
- Create: `packages/db/src/protectAccount.ts`
- Modify: `packages/db/package.json`
- Modify: `docs/RUNBOOK.md`

**Interfaces:**
- Consumes: `schema.appUser.isProtected` and the `app.protected_write` GUC (Task 1).
- Produces: `pnpm --filter @phoneup/db protect-account <email> [--off] [--commit]`. No exported functions — it is a top-level-await CLI, the same shape as `packages/db/src/backfillDisplayNames.ts` and `apps/api/src/recoverAdmin.ts`.

- [ ] **Step 1: Write the script**

Create `packages/db/src/protectAccount.ts`:

```ts
/**
 * Set or clear app_user.is_protected — the owner/break-glass flag.
 *
 * A protected account cannot be modified or deleted by any other user through the app, and
 * is filtered out of the Users page. This script is the ONLY writer of the flag: a flag the
 * application can set is a flag an ADMIN session can clear.
 *
 * The security boundary is DATABASE_URL, the same boundary recover-admin has. Anyone who can
 * point this at production can already rewrite every row there, so it grants no new authority.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @phoneup/db protect-account me@x.com            # dry run
 *   DATABASE_URL=... pnpm --filter @phoneup/db protect-account me@x.com --commit   # protect
 *   DATABASE_URL=... pnpm --filter @phoneup/db protect-account me@x.com --off --commit
 */
import { sql, eq } from 'drizzle-orm'
import { db } from './client'
import * as schema from './schema'

const args = process.argv.slice(2)
const commit = args.includes('--commit')
const turnOff = args.includes('--off')
const email = args.find((arg) => !arg.startsWith('--'))

if (!email) {
  console.error('usage: protect-account <email> [--off] [--commit]')
  process.exit(1)
}

const target = await db.query.appUser.findFirst({
  where: eq(schema.appUser.email, email.toLowerCase()),
})

if (!target) {
  console.error(`no account with email ${email}`)
  process.exit(1)
}

const desired = !turnOff

if (target.isProtected === desired) {
  console.log(`${target.email} is already ${desired ? 'protected' : 'unprotected'} — nothing to do.`)
  process.exit(0)
}

if (!commit) {
  console.log(
    `DRY RUN — would ${desired ? 'PROTECT' : 'UNPROTECT'} ${target.email} (role ${target.role})\n`,
  )
  if (desired) {
    console.log('Once protected, this account:')
    console.log('  - cannot have its role, active status or password changed by anyone in-app')
    console.log('  - cannot change its own role or active status either')
    console.log('  - is hidden from the Users page for every other user')
    console.log('  - still signs in normally and is still fully audit-logged')
    console.log('  - is recoverable only via `recover-admin` or this script with --off\n')
  }
  console.log('Re-run with --commit to apply.')
  process.exit(0)
}

await db.transaction(async (tx) => {
  await tx.execute(sql`set local app.protected_write = 'on'`)
  await tx
    .update(schema.appUser)
    .set({ isProtected: desired })
    .where(eq(schema.appUser.id, target.id))

  // Attributed to the account itself: a human with database access ordered this, and there
  // is no signed-in actor to name. Same attribution recover-admin uses.
  await tx.insert(schema.auditEvents).values({
    actorUserId: target.id,
    action: 'user.setProtected',
    entityType: 'app_user',
    entityId: target.id,
    before: { isProtected: target.isProtected },
    after: { isProtected: desired },
  })
})

console.log(`${target.email} is now ${desired ? 'PROTECTED' : 'unprotected'}.`)
process.exit(0)
```

Before writing, open `packages/db/src/backfillDisplayNames.ts` and match its import style for `db` and `schema` exactly — if it imports from `./index` rather than `./client` and `./schema`, use that instead.

- [ ] **Step 2: Register the script**

In `packages/db/package.json`, add to `"scripts"`, after `"backfill-display-names"`:

```json
    "protect-account": "tsx src/protectAccount.ts",
```

- [ ] **Step 3: Verify the dry run against the test database**

```bash
DATABASE_URL=${TEST_DATABASE_URL:-postgresql://localhost/phoneup_test} pnpm --filter @phoneup/db protect-account nobody@test.local
```

Expected: `no account with email nobody@test.local`, exit code 1.

- [ ] **Step 4: Verify the full round trip against the test database**

```bash
DATABASE_URL=${TEST_DATABASE_URL:-postgresql://localhost/phoneup_test} pnpm --filter @phoneup/db seed
```

If the test database is already seeded this refuses — that is fine, use any existing account's email from it instead. Then, substituting a real email from that database:

```bash
DATABASE_URL=${TEST_DATABASE_URL:-postgresql://localhost/phoneup_test} pnpm --filter @phoneup/db protect-account <email> --commit
```

Expected: `... is now PROTECTED.` Then reverse it so the suite is not left with a surprise protected row:

```bash
DATABASE_URL=${TEST_DATABASE_URL:-postgresql://localhost/phoneup_test} pnpm --filter @phoneup/db protect-account <email> --off --commit
```

Expected: `... is now unprotected.`

- [ ] **Step 5: Document the script in the RUNBOOK**

In `docs/RUNBOOK.md`, in the operational-scripts section, add an entry matching the surrounding format:

```markdown
- `pnpm --filter @phoneup/db protect-account <email> [--off] [--commit]` — set or clear the
  owner/break-glass flag on an account. Dry-run by default. A protected account cannot be
  modified or deleted by anyone in-app (including itself), and is hidden from the Users page
  for every other user. It still signs in normally and is still fully audit-logged. This
  script is the only writer of the flag — there is deliberately no UI, because a flag the app
  can set is a flag a compromised ADMIN session can clear. Recovery for a protected account is
  `recover-admin`, or this script with `--off`.
```

- [ ] **Step 6: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/protectAccount.ts packages/db/package.json docs/RUNBOOK.md
git commit -m "feat(db): add protect-account script for the owner flag"
```

---

### Task 5: recover-admin support, and the remaining docs

**Files:**
- Modify: `apps/api/src/recoverAdmin.ts`
- Modify: `docs/RUNBOOK.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `resetPassword(..., { allowProtected })` and `setActive(..., { allowProtected })` (Task 2); the `app.protected_write` GUC (Task 1).
- Produces: no new exports. `recover-admin` keeps its existing CLI surface.

- [ ] **Step 1: Mark protected accounts in the listing**

In `apps/api/src/recoverAdmin.ts`, replace the `describe` helper:

```ts
const describe = (admin: any) =>
  `${admin.email}${admin.isProtected ? ' (PROTECTED)' : ''}${admin.isActive ? '' : ' (INACTIVE)'}${admin.mustChangePassword ? ' (holds a temporary password)' : ''}`
```

Do not filter protected admins out of the `admins` query. If this script hid them, the one account that cannot be recovered any other way would become unrecoverable.

- [ ] **Step 2: Opt in to the protected write on the password reset**

In the same file, add `allowProtected: true` to the `resetPassword` call:

```ts
// This script's boundary is DATABASE_URL, not a login — it is the documented recovery path
// for a protected account, so it opts past the in-app protection deliberately.
await resetPassword(db, {
  userId: target.id,
  newPassword: password,
  actorUserId: target.id,
  mustChangePassword: true,
  allowProtected: true,
})
```

- [ ] **Step 3: Fix the reactivation to survive the trigger**

The bare `db.update(...).set({ isActive: true })` at the end of the script writes `is_active`, which the `protect_app_user` trigger rejects on a protected row. Replace it:

```ts
// A deactivated admin would still be unable to sign in after the reset. setActive owns the
// GUC escape hatch, so this one call covers both a protected and an unprotected target and
// gets the reactivation audit-logged for free.
if (!target.isActive) {
  await setActive(db, {
    userId: target.id,
    isActive: true,
    actorUserId: target.id,
    allowProtected: true,
  })
}
```

Import `setActive` alongside the existing `resetPassword` import:

```ts
import { resetPassword, setActive } from './domain/userManagement'
```

**Amended during Task 2.** The original plan wrapped a raw `db.update` in its own `SET LOCAL app.protected_write = 'on'` transaction here. The Task 2 review found that `setActive`'s `allowProtected` flag was dead as specified — clearing the app-layer guard only moved the failure down to the trigger, because the domain layer never set the GUC. `setActive` now sets it itself when `allowProtected` is true, which puts the escape hatch in exactly one place and lets this script drop its raw SQL entirely. Do not reintroduce a second GUC site here.

- [ ] **Step 4: Verify recover-admin still works, dry run first**

```bash
DATABASE_URL=${TEST_DATABASE_URL:-postgresql://localhost/phoneup_test} pnpm --filter @phoneup/api recover-admin
```

Expected: a DRY RUN listing of the ADMIN accounts in the test database. If more than one exists it lists them and exits 1 asking you to name one — that is correct behaviour, not a failure.

- [ ] **Step 5: Verify recover-admin against a protected admin**

Using an ADMIN email from the test database:

```bash
DATABASE_URL=${TEST_DATABASE_URL:-postgresql://localhost/phoneup_test} pnpm --filter @phoneup/db protect-account <admin-email> --commit
DATABASE_URL=${TEST_DATABASE_URL:-postgresql://localhost/phoneup_test} pnpm --filter @phoneup/api recover-admin <admin-email> --commit
```

Expected: the listing shows `(PROTECTED)`, and the reset succeeds with a temporary password printed once. Then clean up:

```bash
DATABASE_URL=${TEST_DATABASE_URL:-postgresql://localhost/phoneup_test} pnpm --filter @phoneup/db protect-account <admin-email> --off --commit
```

- [ ] **Step 6: Update the recover-admin entry in the RUNBOOK**

In `docs/RUNBOOK.md`, extend the existing `recover-admin` bullet with one sentence:

```markdown
  It is also the recovery path for a protected account (see `protect-account`): it opts past
  the in-app protection deliberately, because its boundary is `DATABASE_URL` rather than a
  login. It never hides protected admins from its listing — doing so would make the one
  account that has no other recovery path unrecoverable.
```

- [ ] **Step 7: Document the flag in CLAUDE.md**

In `CLAUDE.md`, under **Accounts & passwords**, add:

```markdown
- **The owner account is protected, not privileged.** `app_user.is_protected` marks one ADMIN
  account that no user — including itself — can modify through the app: `setRole`, `setActive`
  and `resetPassword` all reject a protected target in `apps/api/src/domain/userManagement.ts`,
  a `protect_app_user` Postgres trigger rejects the same writes at the database, and
  `userManagement.list` filters it out for every other caller. It is still an ordinary ADMIN:
  same login page, same password rules, same login throttle, every action in `audit_events`.
  Rejected attempts against it are logged too, as `user.protectedWriteDenied`. The flag is set
  only by `pnpm --filter @phoneup/db protect-account`; do not add a UI or a tRPC route for it,
  and do not add a fifth role — the protection is a flag on ADMIN, not a tier above it.
  The escape hatch for both scripts is the `app.protected_write = 'on'` session GUC.
```

- [ ] **Step 8: Run the full suite and typecheck**

```bash
pnpm --filter @phoneup/api test && pnpm typecheck
```

Expected: all PASS, typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/recoverAdmin.ts docs/RUNBOOK.md CLAUDE.md
git commit -m "feat(api): let recover-admin reach protected accounts; document the owner flag"
```

---

### Task 6: Protect the real account

**Files:** none — this is an operational step against the production database.

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: `seanzmc9613@gmail.com` protected in production.

- [ ] **Step 1: Confirm the deploy applied the migration**

Production runs `pnpm --filter @phoneup/db migrate` on container start (see `Dockerfile`), so pushing to `main` applies it. Confirm the trigger exists before relying on it:

```bash
psql "$DATABASE_URL" -c "select tgname from pg_trigger where tgname = 'protect_app_user';"
```

Expected: one row, `protect_app_user`.

- [ ] **Step 2: Confirm a second active ADMIN exists, or accept sole-admin risk**

```bash
psql "$DATABASE_URL" -c "select email, is_active from app_user where role = 'ADMIN';"
```

If `seanzmc9613@gmail.com` is the only ADMIN, protecting it means no in-app path can ever change its role or active status again — `recover-admin` becomes the sole recovery. That is the intended design; just go in knowing it.

- [ ] **Step 3: Dry run**

```bash
pnpm --filter @phoneup/db protect-account seanzmc9613@gmail.com
```

Expected: the DRY RUN summary listing the four consequences. Read it.

- [ ] **Step 4: Apply**

```bash
pnpm --filter @phoneup/db protect-account seanzmc9613@gmail.com --commit
```

Expected: `seanzmc9613@gmail.com is now PROTECTED.`

- [ ] **Step 5: Verify in the app**

Sign in as a MANAGER (or a second ADMIN) and open the Users page. The account must not appear. Sign in as the protected account and open the Users page. It must appear, alongside everyone else.

- [ ] **Step 6: Verify the audit row landed**

```bash
psql "$DATABASE_URL" -c "select action, before, after, created_at from audit_events where action = 'user.setProtected' order by created_at desc limit 1;"
```

Expected: one row, `before` `{"isProtected": false}`, `after` `{"isProtected": true}`.

---

## Deliberately not in this plan

`app_user.totp_secret` exists in the schema and is completely unimplemented — nothing in `apps/api`, `packages/core` or `packages/contracts` references it. A hidden, protected account still falls to a stolen password, so TOTP on the owner account is the correct next hardening step. It gets its own spec and its own plan.
