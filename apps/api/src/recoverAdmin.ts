/**
 * Break-glass recovery for a locked-out ADMIN.
 *
 * `import-roster` prints each temporary password exactly once and stores only the hash. If
 * that output was never captured, Forgot password is now the normal recovery path for an active
 * account when Resend is configured. This command remains the break-glass path when email is
 * unavailable or misconfigured. `rotate-passwords` deliberately SKIPS accounts still flagged
 * `mustChangePassword` — which a never-used admin account always is.
 *
 * The security boundary is `DATABASE_URL`. Anyone who can point this at the production
 * database can already read and rewrite every row in it, so requiring nothing beyond that
 * grants no new authority. It is not an authentication bypass: it issues a fresh temporary
 * password through the same path the Users page uses, revokes existing sessions, forces a
 * change on next login, and writes an audit event.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @phoneup/api recover-admin                     # dry run, lists admins
 *   DATABASE_URL=... pnpm --filter @phoneup/api recover-admin --commit            # reset the only admin
 *   DATABASE_URL=... pnpm --filter @phoneup/api recover-admin me@x.com --commit   # reset a named admin
 */
import { asc, eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { resetPassword } from './domain/userManagement'
import { generateTempPassword } from '@phoneup/core'

const args = process.argv.slice(2)
const commit = args.includes('--commit')
const emailArg = args.find((arg) => !arg.startsWith('--'))
const targetEmail = emailArg ?? process.env.ADMIN_EMAIL

const admins = await db
  .select()
  .from(schema.appUser)
  .where(eq(schema.appUser.role, 'ADMIN'))
  .orderBy(asc(schema.appUser.email))

if (admins.length === 0) {
  const [anyUser] = await db.select().from(schema.appUser).limit(1)
  console.error(
    anyUser
      ? 'no ADMIN account exists in this database. Promote one from the Users page, or check DATABASE_URL points at the right database.'
      : 'this database has no accounts at all — it has been migrated but never bootstrapped. Run `pnpm --filter @phoneup/db import-roster` first (RUNBOOK §3.2).',
  )
  process.exit(1)
}

// Naming the account is only optional when there is exactly one; otherwise picking for the
// operator is how the wrong admin gets reset.
let target = admins[0]
if (targetEmail) {
  const match = admins.find((admin: any) => admin.email.toLowerCase() === targetEmail.toLowerCase())
  if (!match) {
    console.error(`no ADMIN account with email ${targetEmail}. Known ADMIN accounts:`)
    for (const admin of admins) console.error(`  ${admin.email}`)
    process.exit(1)
  }
  target = match
} else if (admins.length > 1) {
  console.error('several ADMIN accounts exist — name the one to reset:')
  for (const admin of admins) console.error(`  ${admin.email}`)
  process.exit(1)
}

const describe = (admin: any) =>
  `${admin.email}${admin.isActive ? '' : ' (INACTIVE)'}${admin.mustChangePassword ? ' (holds a temporary password)' : ''}`

if (!commit) {
  console.log(`DRY RUN — would issue a new temporary password for:\n  ${describe(target)}\n`)
  if (admins.length > 1) {
    console.log('Other ADMIN accounts, untouched:')
    for (const admin of admins.filter((a: any) => a.id !== target.id)) console.log(`  ${describe(admin)}`)
    console.log('')
  }
  console.log('Re-run with --commit to apply.')
  process.exit(0)
}

const password = generateTempPassword()

// Attributed to the account itself: a human with database access ordered this, and there is
// no signed-in actor to name. The audit event is what makes the reset visible after the fact.
await resetPassword(db, {
  userId: target.id,
  newPassword: password,
  actorUserId: target.id,
  mustChangePassword: true,
})

// A deactivated admin would still be unable to sign in after the reset.
if (!target.isActive) {
  await db.update(schema.appUser).set({ isActive: true }).where(eq(schema.appUser.id, target.id))
}

console.log('\nTemporary password issued — shown once, stored only as a hash.\n')
console.log(`  email:    ${target.email}`)
console.log(`  password: ${password}\n`)
console.log('Existing sessions for this account were revoked. Signing in forces a password change')
console.log('before any other screen is reachable.')

process.exit(0)
