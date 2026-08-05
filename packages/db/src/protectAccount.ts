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
import { db, schema } from './client'

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
