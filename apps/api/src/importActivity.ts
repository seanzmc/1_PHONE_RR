/**
 * One-off / daily operational script: import the CRM "Standard-Daily Activity" export.
 *
 * The UI at Import Activity is the normal path (ADMIN/MANAGER); this exists for the
 * first run and for backfilling a missed day from the command line.
 *
 * businessDate defaults to the date parsed out of the filename and can be overridden
 * explicitly — it is never inferred from the current clock.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @phoneup/api import-activity <file.csv> [YYYY-MM-DD]
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { db } from '@phoneup/db'
import { businessDateFromFilename, importDailyActivity } from './jobs/activityImport'

const fileArg = process.argv[2]
if (!fileArg) {
  console.error('usage: import-activity <file.csv> [YYYY-MM-DD]')
  process.exit(1)
}

const path = resolve(process.cwd(), fileArg)
const csv = readFileSync(path, 'utf-8')

const businessDate = process.argv[3] ?? businessDateFromFilename(path)
if (!businessDate) {
  console.error('could not read a date from the filename — pass one explicitly as the 2nd argument')
  process.exit(1)
}

const summary = await importDailyActivity(db, csv, businessDate)

console.log(`\nImport summary — ${summary.businessDate}`)
console.log(`  rows parsed:            ${summary.rowsParsed}`)
console.log(`  reps matched:           ${summary.repsMatched}`)
console.log(`  not in the file:        ${summary.repsMissingFromFile.length} (register 0 calls)`)
if (summary.repsMissingFromFile.length > 0) {
  console.log(`      ${summary.repsMissingFromFile.join(', ')}`)
}
console.log(`  unmatched names:        ${summary.unmatchedNames.length} (not imported)`)
if (summary.unmatchedNames.length > 0) {
  console.log(`      ${summary.unmatchedNames.join(', ')}`)
}
console.log(`  manual rows preserved:  ${summary.manualRowsPreserved.length}`)
if (summary.manualRowsPreserved.length > 0) {
  console.log(`      ${summary.manualRowsPreserved.join(', ')}`)
}

process.exit(0)
