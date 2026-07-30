/**
 * Run the ledger/counter reconciliation on demand instead of waiting for the 02:00 cron.
 *
 * Exits non-zero when the projection has drifted from the append-only ledger, which makes
 * it usable as an assertion — the restore drill points it at a restored copy to prove the
 * backup carried the truth model intact, not just the rows.
 *
 * Usage: DATABASE_URL=... pnpm --filter @phoneup/api reconcile
 */
import { db } from '@phoneup/db'
import { reconcile } from './jobs/reconciliation'

const { mismatches } = await reconcile(db)

if (mismatches.length === 0) {
  console.log('reconciliation OK — assignment_events and rep_month_counters agree')
  process.exit(0)
}

console.error(`reconciliation FAILED — ${mismatches.length} rep/period mismatch(es)`)
for (const m of mismatches) {
  console.error(`  rep ${m.repId} ${m.periodKey}: ledger says ${m.expected}, counter says ${m.actual}`)
}
process.exit(1)
