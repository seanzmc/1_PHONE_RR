/**
 * Restore drill: prove a backup is actually restorable, and that what comes back is the
 * truth model rather than merely a set of rows.
 *
 * A backup nobody has restored is a guess. This restores the dump into a scratch database
 * and then asserts three things, in increasing order of what they prove:
 *   1. pg_restore completes;
 *   2. every table's row count matches the manifest written at dump time;
 *   3. the API's own reconciliation passes on the restored copy — assignment_events and
 *      rep_month_counters agree, so the ledger and its projection both survived intact.
 *
 * The scratch database is dropped and recreated every run. Its name must contain "drill",
 * and it may never be the database the dump came from.
 *
 * Usage: DATABASE_URL=... pnpm --filter @phoneup/db restore-drill [dumpFile] [--keep]
 *        DATABASE_URL only supplies the host/credentials to restore *into*; the dump file
 *        is the source of data. Defaults to the newest dump in ./backups.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const run = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const SCRATCH_DB = process.env.RESTORE_DRILL_DB ?? 'phoneup_restore_drill'
const keep = process.argv.includes('--keep')

function newestDump(dir: string): string {
  if (!existsSync(dir)) {
    throw new Error(`no backup directory at ${dir} — run \`pnpm --filter @phoneup/db backup\` first`)
  }
  const dumps = readdirSync(dir)
    .filter((f) => f.endsWith('.dump'))
    .sort()
  if (dumps.length === 0) throw new Error(`no .dump files in ${dir}`)
  return join(dir, dumps[dumps.length - 1])
}

async function drill() {
  const sourceUrl = new URL(process.env.DATABASE_URL!)
  const sourceDb = sourceUrl.pathname.replace(/^\//, '')

  if (!SCRATCH_DB.includes('drill')) {
    throw new Error(`scratch database name must contain "drill" (got "${SCRATCH_DB}") — it gets dropped`)
  }
  if (SCRATCH_DB === sourceDb) {
    throw new Error(`refusing to use "${SCRATCH_DB}" as scratch: it is the database in DATABASE_URL`)
  }

  const dumpArg = process.argv.slice(2).find((a) => !a.startsWith('--'))
  const dumpPath = dumpArg ? resolve(process.cwd(), dumpArg) : newestDump(resolve(process.cwd(), './backups'))
  const manifestPath = dumpPath.replace(/\.dump$/, '.manifest.json')

  console.log(`dump:    ${dumpPath}`)
  console.log(`scratch: ${SCRATCH_DB} on ${sourceUrl.host}\n`)

  const adminUrl = new URL(sourceUrl.toString())
  adminUrl.pathname = '/postgres'
  const scratchUrl = new URL(sourceUrl.toString())
  scratchUrl.pathname = `/${SCRATCH_DB}`

  // onnotice: the expected "database does not exist, skipping" NOTICE is not a finding
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} })
  try {
    // FORCE terminates leftover connections from an interrupted previous run
    await admin.unsafe(`drop database if exists "${SCRATCH_DB}" with (force)`)
    await admin.unsafe(`create database "${SCRATCH_DB}"`)
  } finally {
    await admin.end()
  }

  console.log('restoring…')
  try {
    await run('pg_restore', ['--no-owner', '--no-privileges', '--dbname', scratchUrl.toString(), dumpPath], {
      maxBuffer: 1024 * 1024 * 64,
    })
  } catch (err: any) {
    // pg_restore exits non-zero on warnings too; surface them rather than hiding a real failure
    if (err.stderr) console.error(err.stderr)
    throw new Error('pg_restore reported errors — see output above')
  }

  const failures: string[] = []

  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    const restored = postgres(scratchUrl.toString(), { max: 1, onnotice: () => {} })
    try {
      for (const [table, expected] of Object.entries(manifest.rowCounts as Record<string, number>)) {
        if (expected < 0) continue // table absent at dump time
        const [{ n }] = await restored.unsafe(`select count(*)::int as n from ${table}`)
        if (Number(n) !== expected) failures.push(`${table}: manifest ${expected}, restored ${n}`)
      }
    } finally {
      await restored.end()
    }
    console.log(
      failures.length === 0
        ? `row counts match the manifest across ${Object.keys(manifest.rowCounts).length} tables`
        : 'ROW COUNT MISMATCH',
    )
  } else {
    console.log(`no manifest beside the dump (${manifestPath}) — skipping the row-count comparison`)
  }

  // The real assertion: the restored ledger and its projection still agree.
  console.log('reconciling the restored copy…')
  try {
    const { stdout } = await run('pnpm', ['--filter', '@phoneup/api', 'reconcile'], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: scratchUrl.toString() },
      maxBuffer: 1024 * 1024 * 16,
    })
    console.log(stdout.trim().split('\n').pop())
  } catch (err: any) {
    console.error(err.stdout ?? '')
    console.error(err.stderr ?? '')
    failures.push('reconciliation failed on the restored copy')
  }

  if (!keep) {
    const cleanup = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} })
    try {
      await cleanup.unsafe(`drop database if exists "${SCRATCH_DB}" with (force)`)
    } finally {
      await cleanup.end()
    }
  } else {
    console.log(`\nscratch database kept: ${SCRATCH_DB}`)
  }

  if (failures.length > 0) {
    console.error('\nRESTORE DRILL FAILED')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }

  console.log('\nRESTORE DRILL PASSED — this dump restores to a working, self-consistent database')
  process.exit(0)
}

drill().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
