/**
 * One-off operational script: generate rep_shift rows ~14 days ahead.
 *
 * Needed on first setup and after a bulk roster import, because eligibility writes
 * CONFIGURATION_ERROR for any rep with no rep_shift row for the day. The weekly cron
 * (scheduleShiftMaterializationJob) keeps them topped up after this.
 *
 * Safe to re-run: materializeShifts only inserts missing rows and updates rows it
 * generated itself, so manager-set PTO/SICK/TRAINING survive and past dates are
 * never rewritten.
 *
 * Usage: DATABASE_URL=... pnpm --filter @phoneup/api materialize-shifts [days]
 */
import { db } from '@phoneup/db'
import { materializeShifts } from './jobs/eligibility'

const days = Number(process.argv[2] ?? 14)

const result = await materializeShifts(db, { days })
console.log(`materializeShifts(${days} days): inserted ${result.inserted}, updated ${result.updated}`)
process.exit(0)
