/**
 * One-off remediation: replace the shared seed password on every existing account with a
 * unique short temporary password, and force a change on first login.
 *
 * importRoster.ts seeded every account with the same literal password, so anyone who
 * guessed it had ADMIN. This rotates all of them and prints a distribution list ONCE —
 * the plaintext is never stored, so a lost password means resetting that account again
 * from the Users page.
 *
 * Skips accounts already flagged mustChangePassword (already holding a temp password),
 * so it is safe to re-run without invalidating passwords people are mid-way through using.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @phoneup/api rotate-passwords            # dry run
 *   DATABASE_URL=... pnpm --filter @phoneup/api rotate-passwords --commit   # apply
 */
import { asc } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { resetPassword } from './domain/userManagement'
import { generateTempPassword } from './auth/tempPassword'

const commit = process.argv.includes('--commit')

const users = await db.select().from(schema.appUser).orderBy(asc(schema.appUser.role), asc(schema.appUser.email))

// The rotation is attributed to an ADMIN in the audit log, since a human ordered it.
const admin = users.find((u: any) => u.role === 'ADMIN')
if (!admin) {
  console.error('no ADMIN account found to attribute the audit events to')
  process.exit(1)
}

const targets = users.filter((u: any) => !u.mustChangePassword)
const skipped = users.filter((u: any) => u.mustChangePassword)

if (!commit) {
  console.log(`DRY RUN — would rotate ${targets.length} of ${users.length} account(s).`)
  if (skipped.length > 0) {
    console.log(`Skipping ${skipped.length} already holding a temporary password.`)
  }
  console.log('\nRe-run with --commit to apply.')
  process.exit(0)
}

const issued: Array<{ role: string; email: string; name: string; password: string }> = []

for (const user of targets) {
  const password = generateTempPassword()
  await resetPassword(db, {
    userId: user.id,
    newPassword: password,
    actorUserId: admin.id,
    mustChangePassword: true,
  })
  issued.push({
    role: user.role,
    email: user.email,
    name: user.displayName ?? '(no name)',
    password,
  })
}

const width = Math.max(...issued.map((i) => i.email.length), 5)
console.log(`\nRotated ${issued.length} password(s). Distribute these, then discard this output.\n`)
console.log(`${'ROLE'.padEnd(8)} ${'EMAIL'.padEnd(width)}  ${'NAME'.padEnd(20)} TEMP PASSWORD`)
console.log('-'.repeat(8 + width + 24 + 20))
for (const i of issued) {
  console.log(`${i.role.padEnd(8)} ${i.email.padEnd(width)}  ${i.name.padEnd(20)} ${i.password}`)
}
console.log(
  '\nEvery account must choose its own password at first sign-in; until then the API refuses all other routes.',
)
if (skipped.length > 0) {
  console.log(`\nSkipped ${skipped.length} account(s) already holding a temporary password.`)
}

process.exit(0)
