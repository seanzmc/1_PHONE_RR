/**
 * Take a verified backup of a PhoneUp database.
 *
 * Railway's own volume backups are unavailable on the current plan (the workspace limit is
 * maxBackupsCount: 0), so this is the actual backup for this deployment, not a supplement
 * to one. The assignment_events ledger is the truth model and cannot be reconstructed from
 * anywhere else — if this does not run, there is no recovery.
 *
 * What it does beyond a bare pg_dump:
 *   - refuses to run if pg_dump is older than the server, which otherwise fails halfway
 *     through with a confusing version error;
 *   - writes a sidecar manifest of per-table row counts, so restore-drill can prove the
 *     restored copy actually matches what was dumped rather than just "restored without
 *     erroring";
 *   - verifies the archive is readable with pg_restore --list before reporting success.
 *
 * Usage: DATABASE_URL=... pnpm --filter @phoneup/db backup [outputDir]
 *        (default output directory: ./backups, which is gitignored — dumps hold real
 *         employee and customer data and must never be committed)
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, writeFileSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { sql } from 'drizzle-orm'
import { db } from './client'

const run = promisify(execFile)

const TABLES = [
  'app_user', 'sales_rep', 'store', 'store_hours', 'store_closure',
  'rep_shift', 'rep_daily_status', 'rep_recurring_day_off', 'rep_daily_activity',
  'lead', 'customer', 'assignment_events', 'rep_month_counters',
  'rotation_cycle', 'rr_cycle_assignments', 'rr_state',
  'audit_events', 'work_requirement_policy', 'eligibility_snapshot',
]

function majorVersion(v: string): number {
  const m = v.match(/(\d+)/)
  if (!m) throw new Error(`could not parse a major version from ${JSON.stringify(v)}`)
  return Number(m[1])
}

async function assertDumpVersionIsCompatible(): Promise<{ server: string; tool: string }> {
  const [{ server_version: server }] = (await db.execute(sql`show server_version`)) as any
  const { stdout } = await run('pg_dump', ['--version'])
  const tool = stdout.trim()

  if (majorVersion(tool.replace(/^pg_dump \(PostgreSQL\) /, '')) < majorVersion(server)) {
    throw new Error(
      `pg_dump is older than the server (${tool} vs server ${server}). ` +
        'pg_dump refuses to dump a newer server; install a matching client version first.',
    )
  }
  return { server, tool }
}

async function rowCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const table of TABLES) {
    try {
      const rows = (await db.execute(sql.raw(`select count(*)::int as n from ${table}`))) as any
      counts[table] = Number(rows[0].n)
    } catch {
      // a table that does not exist in this database is reported as absent rather than
      // failing the backup — the manifest is evidence, not a schema assertion
      counts[table] = -1
    }
  }
  return counts
}

async function backup() {
  const url = process.env.DATABASE_URL!
  const outDir = resolve(process.cwd(), process.argv[2] ?? './backups')
  mkdirSync(outDir, { recursive: true })

  const { server, tool } = await assertDumpVersionIsCompatible()
  console.log(`server ${server}, ${tool}`)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dumpPath = join(outDir, `phoneup-${stamp}.dump`)
  const manifestPath = join(outDir, `phoneup-${stamp}.manifest.json`)

  const counts = await rowCounts()

  console.log('dumping…')
  // -Fc: custom format, so restore-drill can use pg_restore into a fresh database
  await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', dumpPath, url], {
    maxBuffer: 1024 * 1024 * 64,
  })

  // an archive that pg_restore cannot list is not a backup, whatever its size
  const { stdout: listing } = await run('pg_restore', ['--list', dumpPath], { maxBuffer: 1024 * 1024 * 64 })
  const objectCount = listing.split('\n').filter((l) => l && !l.startsWith(';')).length

  const bytes = statSync(dumpPath).size
  writeFileSync(
    manifestPath,
    JSON.stringify({ takenAt: new Date().toISOString(), server, tool, bytes, objectCount, rowCounts: counts }, null, 2),
  )

  console.log(`\nbackup written: ${dumpPath}`)
  console.log(`  ${(bytes / 1024 / 1024).toFixed(1)} MB, ${objectCount} archive objects`)
  console.log(`  manifest:      ${manifestPath}`)
  console.log(`  ledger rows:   ${counts.assignment_events} assignment_events, ${counts.lead} leads`)
  console.log('\nVerify it restores: pnpm --filter @phoneup/db restore-drill')

  process.exit(0)
}

backup().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
