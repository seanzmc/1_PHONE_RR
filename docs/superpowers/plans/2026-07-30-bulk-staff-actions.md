# Bulk Staff Actions and Preset Reasons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a manager select several reps on the Staff List and activate, deactivate or release them in one action with a preset reason, and stop the status buttons from prompting for a decision they cannot make.

**Architecture:** One shared no-op predicate in `@phoneup/core` keeps the client's disabled-button rule and the server's skip rule from drifting. `overrideStatus`'s body is extracted into `applyOverrideStatus(tx, input)` so a batch can apply many overrides inside a single transaction holding a single `pg_advisory_xact_lock` — the same lock every ordering-changing path takes. `board.roster` starts returning `decidedBy` so the client can tell a system-decided ineligibility from a manager-decided one.

**Tech Stack:** Fastify + tRPC v11 + Zod, Drizzle ORM, PostgreSQL, React, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-30-bulk-staff-actions-design.md`. Where this plan and the spec disagree, the spec wins.
- The advisory lock key is `42_100_1`. Every path that changes rotation ordering takes it. A batch takes it **once**, not once per rep.
- The API suite reads `TEST_DATABASE_URL`, never `DATABASE_URL`. Run it as `TEST_DATABASE_URL=postgresql://localhost/phoneup_test pnpm --filter @phoneup/api test`.
- `pnpm typecheck` is the only thing that typechecks `apps/api` — it ships via `tsx`, which strips types without checking them. Run it before every commit that touches `apps/api`.
- The no-op rule is keyed on the status a manager can **see** (`isEligible`), not on whether the database write would differ.
- Four roles only: ADMIN, MANAGER, BDC, REP. Bulk status changes use the existing `rep.override` permission. Do not add a permission.
- Commit messages: Conventional Commits, and end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 1: Shared no-op predicate in `@phoneup/core`

The client disables a button and the server skips a rep. If those two rules live in two places they will drift, and a button will read "disabled" for a change the server would happily have applied. One definition, two callers, each mapping its own row shape onto a small normalized type.

**Files:**
- Create: `packages/core/src/overrideNoOp.ts`
- Create: `packages/core/src/overrideNoOp.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type OverrideTarget = 'FORCE_ACTIVE' | 'FORCE_INACTIVE' | 'FOLLOW_SCHEDULE'`
  - `type CurrentRepStatus = { isEligible: boolean; decidedBy: 'SYSTEM' | 'MANAGER_OVERRIDE' | null }`
  - `function isOverrideNoOp(target: OverrideTarget, current: CurrentRepStatus): boolean`
  - `function noOpReason(target: OverrideTarget): string`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/overrideNoOp.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isOverrideNoOp, noOpReason, type CurrentRepStatus } from './overrideNoOp'

const eligible: CurrentRepStatus = { isEligible: true, decidedBy: 'SYSTEM' }
const ineligibleBySystem: CurrentRepStatus = { isEligible: false, decidedBy: 'SYSTEM' }
const ineligibleByManager: CurrentRepStatus = { isEligible: false, decidedBy: 'MANAGER_OVERRIDE' }
const eligibleByManager: CurrentRepStatus = { isEligible: true, decidedBy: 'MANAGER_OVERRIDE' }
const noRow: CurrentRepStatus = { isEligible: false, decidedBy: null }

describe('isOverrideNoOp', () => {
  it('cannot reactivate a rep who is already eligible', () => {
    expect(isOverrideNoOp('FORCE_ACTIVE', eligible)).toBe(true)
    expect(isOverrideNoOp('FORCE_ACTIVE', eligibleByManager)).toBe(true)
  })

  it('can reactivate a rep who is ineligible, whoever decided it', () => {
    expect(isOverrideNoOp('FORCE_ACTIVE', ineligibleBySystem)).toBe(false)
    expect(isOverrideNoOp('FORCE_ACTIVE', ineligibleByManager)).toBe(false)
  })

  it('cannot deactivate a rep who already reads as ineligible', () => {
    // Including a rep who is only out because it is their scheduled day off: the
    // rule is on the visible status, so they are suspended the next day they are in.
    expect(isOverrideNoOp('FORCE_INACTIVE', ineligibleBySystem)).toBe(true)
    expect(isOverrideNoOp('FORCE_INACTIVE', ineligibleByManager)).toBe(true)
  })

  it('can deactivate an eligible rep', () => {
    expect(isOverrideNoOp('FORCE_INACTIVE', eligible)).toBe(false)
  })

  it('can only follow schedule when there is a manager override to release', () => {
    expect(isOverrideNoOp('FOLLOW_SCHEDULE', ineligibleByManager)).toBe(false)
    expect(isOverrideNoOp('FOLLOW_SCHEDULE', eligibleByManager)).toBe(false)
    expect(isOverrideNoOp('FOLLOW_SCHEDULE', eligible)).toBe(true)
    expect(isOverrideNoOp('FOLLOW_SCHEDULE', ineligibleBySystem)).toBe(true)
  })

  it('treats a rep with no status row as ineligible, matching what the board shows', () => {
    expect(isOverrideNoOp('FORCE_ACTIVE', noRow)).toBe(false)
    expect(isOverrideNoOp('FORCE_INACTIVE', noRow)).toBe(true)
    expect(isOverrideNoOp('FOLLOW_SCHEDULE', noRow)).toBe(true)
  })
})

describe('noOpReason', () => {
  it('explains each disabled button', () => {
    expect(noOpReason('FORCE_ACTIVE')).toBe('Already active')
    expect(noOpReason('FORCE_INACTIVE')).toBe('Already inactive')
    expect(noOpReason('FOLLOW_SCHEDULE')).toBe('No manager override to release')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @phoneup/core test`
Expected: FAIL — `Failed to resolve import "./overrideNoOp"`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/overrideNoOp.ts`:

```ts
/**
 * Whether a status action would accomplish anything the manager can see.
 *
 * One definition, deliberately shared: the Staff List uses it to disable a button and
 * `bulkOverrideStatus` re-checks it inside the transaction against a fresh row. Two copies
 * would drift, and a button reading "Already inactive" for a rep the server would happily
 * have deactivated is worse than no rule at all.
 *
 * The rule is keyed on the status a manager can SEE, not on whether the write would differ.
 * A rep who is ineligible only because it is their scheduled day off therefore cannot be
 * deactivated today — that is done the next day they are in. Accepted in the design.
 */
export type OverrideTarget = 'FORCE_ACTIVE' | 'FORCE_INACTIVE' | 'FOLLOW_SCHEDULE'

/** A rep's status today, normalized from either a `rep_daily_status` row or a roster entry. */
export type CurrentRepStatus = {
  isEligible: boolean
  /** `null` when the rep has no `rep_daily_status` row for today. */
  decidedBy: 'SYSTEM' | 'MANAGER_OVERRIDE' | null
}

export function isOverrideNoOp(target: OverrideTarget, current: CurrentRepStatus): boolean {
  switch (target) {
    case 'FORCE_ACTIVE':
      return current.isEligible
    case 'FORCE_INACTIVE':
      return !current.isEligible
    case 'FOLLOW_SCHEDULE':
      // Following the schedule releases a manager override. With none in place there is
      // nothing to release, whatever today's status happens to be.
      return current.decidedBy !== 'MANAGER_OVERRIDE'
  }
}

/** Hover text for a button disabled by the rule above. A dead button should say why. */
export function noOpReason(target: OverrideTarget): string {
  switch (target) {
    case 'FORCE_ACTIVE':
      return 'Already active'
    case 'FORCE_INACTIVE':
      return 'Already inactive'
    case 'FOLLOW_SCHEDULE':
      return 'No manager override to release'
  }
}
```

- [ ] **Step 4: Export it from the package entry point**

In `packages/core/src/index.ts`, add after the `rankReps` line:

```ts
export {
  isOverrideNoOp,
  noOpReason,
  type OverrideTarget,
  type CurrentRepStatus,
} from './overrideNoOp'
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @phoneup/core test`
Expected: PASS — all `overrideNoOp` tests green, plus the existing `ranking` tests.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm typecheck`
Expected: all five projects Done.

```bash
git add packages/core/src/overrideNoOp.ts packages/core/src/overrideNoOp.test.ts packages/core/src/index.ts
git commit -m "$(cat <<'EOF'
feat(core): share the status override no-op rule

The Staff List needs it to disable a button and the batch apply needs it
to skip a rep inside the transaction. Two copies would drift, and a
button reading "Already inactive" for a rep the server would have
deactivated is worse than no rule.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Extract `applyOverrideStatus` from `overrideStatus`

Pure refactor, no behaviour change. A batch needs the body of one override without the transaction and lock wrapped around it, and there must stay exactly one definition of what an override does — the week-tail handling in particular is subtle enough that a second copy would rot.

**Files:**
- Modify: `apps/api/src/domain/overrideStatus.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `const ADVISORY_LOCK_KEY = 42_100_1` — now exported.
  - `async function applyOverrideStatus(tx: any, input: OverrideStatusInput): Promise<void>` — the body of one override, assuming the caller already opened a transaction and took the lock.
  - `async function overrideStatus(db, input): Promise<void>` — unchanged signature and behaviour.

- [ ] **Step 1: Run the existing test to establish the baseline**

Run: `TEST_DATABASE_URL=postgresql://localhost/phoneup_test pnpm --filter @phoneup/api test src/domain/overrideStatus.test.ts`
Expected: PASS, 1 test. This test is the guard for the refactor — it must still pass unchanged at the end.

- [ ] **Step 2: Split the function**

In `apps/api/src/domain/overrideStatus.ts`, export the lock key:

```ts
export const ADVISORY_LOCK_KEY = 42_100_1 // same key as assignLead — overrides change ordering too, spec §0.1
```

Then replace the whole `overrideStatus` function (currently lines 23-90) with a wrapper plus the extracted body. The body is the existing code verbatim, with `tx` now a parameter instead of a closure variable:

```ts
export async function overrideStatus(db: DB, input: OverrideStatusInput): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)
    await applyOverrideStatus(tx, input)
  })
}

/**
 * One override, applied inside a transaction the caller already opened and locked.
 *
 * Split out so `bulkOverrideStatus` can apply many of these under a SINGLE
 * `pg_advisory_xact_lock`. Taking and releasing the lock once per rep would make a partial
 * apply reachable and would hold up an assigning BDC agent N times over.
 *
 * The caller MUST hold ADVISORY_LOCK_KEY. This function does not take it.
 */
export async function applyOverrideStatus(tx: any, input: OverrideStatusInput): Promise<void> {
  const today = businessDate(new Date())

  const before = await tx.query.repDailyStatus.findFirst({
    where: and(eq(schema.repDailyStatus.repId, input.repId), eq(schema.repDailyStatus.businessDate, today)),
  })

  await tx.insert(schema.statusOverride).values({
    repId: input.repId,
    status: input.status,
    reasonCode: input.reasonCode,
    reasonNote: input.reasonNote,
    actorUserId: input.actorUserId,
    businessDate: today,
  })

  const newStatus = STATUS_TO_DAILY_STATUS[input.status]

  // A week suspension writes INELIGIBLE for today AND every remaining business date through
  // Saturday (design pass §I). Touching only today would silently re-DQ the rep tomorrow,
  // so an override has to reach the whole tail it is undoing (or, for FORCE_INACTIVE, mirror it).
  const weekDates = businessDatesThroughSaturday(today)
  const futureDates = weekDates.filter((d) => d !== today)

  await upsertOverride(tx, input.repId, today, newStatus, input.reasonNote)

  if (input.status === 'FORCE_ACTIVE') {
    // clear the remaining WEEK_DQ tail — but only rows the SYSTEM wrote, so we never
    // stomp another manager's explicit future decision.
    if (futureDates.length > 0) {
      await tx
        .delete(schema.repDailyStatus)
        .where(
          and(
            eq(schema.repDailyStatus.repId, input.repId),
            inArray(schema.repDailyStatus.businessDate, futureDates),
            eq(schema.repDailyStatus.decidedBy, 'SYSTEM'),
            eq(schema.repDailyStatus.status, 'INELIGIBLE'),
          ),
        )
    }
  } else if (input.status === 'FORCE_INACTIVE') {
    // symmetric: write the deactivation through the end of the business week
    for (const date of futureDates) {
      await upsertOverride(tx, input.repId, date, 'INELIGIBLE', input.reasonNote)
    }
  }

  await tx.insert(schema.auditEvents).values({
    actorUserId: input.actorUserId,
    action: 'rep.override',
    entityType: 'rep_daily_status',
    entityId: input.repId,
    before: before ? { status: before.status, decidedBy: before.decidedBy, reason: before.reason } : null,
    after: {
      status: newStatus,
      decidedBy: 'MANAGER_OVERRIDE',
      reasonNote: input.reasonNote,
      // Reactivation only clears status rows — it never marks a rep exempt, so the rep is
      // still subject to the daily call qualifier the next morning (design pass §I).
      appliedThrough: input.status === 'FOLLOW_SCHEDULE' ? today : weekDates[weekDates.length - 1],
    },
  })
}
```

Leave `upsertOverride`, `STATUS_TO_DAILY_STATUS`, `OverrideStatusInput` and the imports exactly as they are.

- [ ] **Step 3: Run the test to verify nothing changed**

Run: `TEST_DATABASE_URL=postgresql://localhost/phoneup_test pnpm --filter @phoneup/api test src/domain/overrideStatus.test.ts`
Expected: PASS, 1 test — the same test, unmodified.

- [ ] **Step 4: Run the whole API suite**

Run: `TEST_DATABASE_URL=postgresql://localhost/phoneup_test pnpm --filter @phoneup/api test`
Expected: PASS, 13 files, 126 tests. A refactor that changes a count here is not a refactor.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`
Expected: all five projects Done.

```bash
git add apps/api/src/domain/overrideStatus.ts
git commit -m "$(cat <<'EOF'
refactor(api): split applyOverrideStatus out of overrideStatus

A batch needs the body of one override without a transaction and lock
wrapped around it. Extracting it keeps exactly one definition of what an
override does — the week-tail clearing in particular is subtle enough
that a second copy would rot.

No behaviour change; the existing test is unmodified.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `bulkOverrideStatus` domain function

**Files:**
- Create: `apps/api/src/domain/bulkOverrideStatus.ts`
- Create: `apps/api/src/domain/bulkOverrideStatus.test.ts`

**Interfaces:**
- Consumes: `applyOverrideStatus`, `ADVISORY_LOCK_KEY`, `OverrideStatusInput` from `./overrideStatus`; `isOverrideNoOp`, `type CurrentRepStatus` from `@phoneup/core`.
- Produces:
  - `type BulkOverrideStatusInput = { repIds: string[]; status: OverrideTarget; reasonCode: string; reasonNote: string; actorUserId: string }`
  - `type BulkOverrideStatusResult = { applied: string[]; skipped: string[] }`
  - `async function bulkOverrideStatus(db: DB, input: BulkOverrideStatusInput): Promise<BulkOverrideStatusResult>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/domain/bulkOverrideStatus.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq, and, inArray } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db, schema } from '@phoneup/db'
import { businessDate } from '@phoneup/core'
import { bulkOverrideStatus } from './bulkOverrideStatus'
import { assignLead } from './assignLead'
import { businessDatesThroughSaturday } from '../jobs/eligibility'

let repIds: string[] = []
let managerUserId: string
const today = businessDate(new Date())

beforeAll(async () => {
  const reps = await db.select().from(schema.salesRep)
  repIds = reps.map((r: any) => r.id).slice(0, 3)
  const [manager] = await db
    .insert(schema.appUser)
    .values({ email: `bulk-test-manager-${Date.now()}@dealership.test`, passwordHash: 'x:y', role: 'MANAGER' })
    .returning()
  managerUserId = manager.id
})

/** Put the given reps at a known starting status so each test controls its own inputs. */
async function setStatus(
  ids: string[],
  status: 'ELIGIBLE' | 'INELIGIBLE',
  decidedBy: 'SYSTEM' | 'MANAGER_OVERRIDE',
) {
  for (const repId of ids) {
    const existing = await db.query.repDailyStatus.findFirst({
      where: and(eq(schema.repDailyStatus.repId, repId), eq(schema.repDailyStatus.businessDate, today)),
    })
    if (existing) {
      await db
        .update(schema.repDailyStatus)
        .set({ status, decidedBy, reason: 'test fixture' })
        .where(eq(schema.repDailyStatus.id, existing.id))
    } else {
      await db
        .insert(schema.repDailyStatus)
        .values({ repId, businessDate: today, status, decidedBy, reason: 'test fixture' })
    }
  }
}

beforeEach(async () => {
  await db.delete(schema.statusOverride).where(inArray(schema.statusOverride.repId, repIds))
  await db
    .delete(schema.repDailyStatus)
    .where(
      and(
        inArray(schema.repDailyStatus.repId, repIds),
        inArray(schema.repDailyStatus.businessDate, businessDatesThroughSaturday(today)),
      ),
    )
})

describe('bulkOverrideStatus', () => {
  it('deactivates every eligible rep in one call, through Saturday', async () => {
    await setStatus(repIds, 'ELIGIBLE', 'SYSTEM')

    const result = await bulkOverrideStatus(db, {
      repIds,
      status: 'FORCE_INACTIVE',
      reasonCode: 'BELOW_CALL_MINIMUM',
      reasonNote: 'Below call minimum',
      actorUserId: managerUserId,
    })

    expect(result.applied.sort()).toEqual([...repIds].sort())
    expect(result.skipped).toEqual([])

    const weekDates = businessDatesThroughSaturday(today)
    for (const repId of repIds) {
      const rows = await db.query.repDailyStatus.findMany({
        where: and(
          eq(schema.repDailyStatus.repId, repId),
          inArray(schema.repDailyStatus.businessDate, weekDates),
        ),
      })
      expect(rows.length).toBe(weekDates.length)
      expect(rows.every((r: any) => r.status === 'INELIGIBLE')).toBe(true)
      expect(rows.every((r: any) => r.decidedBy === 'MANAGER_OVERRIDE')).toBe(true)
    }
  })

  it('writes one status_override and one audit event per applied rep', async () => {
    await setStatus(repIds, 'ELIGIBLE', 'SYSTEM')

    await bulkOverrideStatus(db, {
      repIds,
      status: 'FORCE_INACTIVE',
      reasonCode: 'PTO',
      reasonNote: 'PTO',
      actorUserId: managerUserId,
    })

    const overrides = await db.query.statusOverride.findMany({
      where: inArray(schema.statusOverride.repId, repIds),
    })
    expect(overrides.length).toBe(repIds.length)
    expect(overrides.every((o: any) => o.reasonCode === 'PTO')).toBe(true)

    // Per-rep, not per-batch: the audit screen and the rep drill-down both query by
    // entityId, and a batch-shaped event would leave a rep's own history incomplete.
    for (const repId of repIds) {
      const audit = await db.query.auditEvents.findMany({
        where: and(
          eq(schema.auditEvents.entityType, 'rep_daily_status'),
          eq(schema.auditEvents.entityId, repId),
          eq(schema.auditEvents.actorUserId, managerUserId),
        ),
      })
      expect(audit.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('skips reps the action would not change, writing nothing for them', async () => {
    const [alreadyOut, ...eligible] = repIds
    await setStatus([alreadyOut], 'INELIGIBLE', 'MANAGER_OVERRIDE')
    await setStatus(eligible, 'ELIGIBLE', 'SYSTEM')

    const result = await bulkOverrideStatus(db, {
      repIds,
      status: 'FORCE_INACTIVE',
      reasonCode: 'DISCIPLINARY',
      reasonNote: 'Disciplinary',
      actorUserId: managerUserId,
    })

    expect(result.skipped).toEqual([alreadyOut])
    expect(result.applied.sort()).toEqual([...eligible].sort())

    const skippedOverrides = await db.query.statusOverride.findMany({
      where: eq(schema.statusOverride.repId, alreadyOut),
    })
    expect(skippedOverrides.length).toBe(0)
  })

  it('reactivating a batch clears each rep SYSTEM ineligible tail', async () => {
    const weekDates = businessDatesThroughSaturday(today)
    const futureDates = weekDates.filter((d) => d !== today)
    await setStatus(repIds, 'INELIGIBLE', 'SYSTEM')
    for (const repId of repIds) {
      for (const date of futureDates) {
        await db
          .insert(schema.repDailyStatus)
          .values({ repId, businessDate: date, status: 'INELIGIBLE', decidedBy: 'SYSTEM', reason: 'WEEK_DQ' })
      }
    }

    const result = await bulkOverrideStatus(db, {
      repIds,
      status: 'FORCE_ACTIVE',
      reasonCode: 'SUSPENSION_LIFTED',
      reasonNote: 'Suspension lifted early',
      actorUserId: managerUserId,
    })
    expect(result.applied.length).toBe(repIds.length)

    for (const repId of repIds) {
      const todayRow = await db.query.repDailyStatus.findFirst({
        where: and(eq(schema.repDailyStatus.repId, repId), eq(schema.repDailyStatus.businessDate, today)),
      })
      expect(todayRow?.status).toBe('ELIGIBLE')

      if (futureDates.length > 0) {
        const tail = await db.query.repDailyStatus.findMany({
          where: and(
            eq(schema.repDailyStatus.repId, repId),
            inArray(schema.repDailyStatus.businessDate, futureDates),
          ),
        })
        expect(tail).toEqual([])
      }
    }
  })

  it('reactivating a batch leaves another manager future decision alone', async () => {
    const weekDates = businessDatesThroughSaturday(today)
    const futureDates = weekDates.filter((d) => d !== today)
    if (futureDates.length === 0) return // Saturday: no tail to protect

    const [protectedRep, ...rest] = repIds
    await setStatus(repIds, 'INELIGIBLE', 'SYSTEM')
    // One rep carries an explicit manager decision for a future date. A batch reactivation
    // clears the SYSTEM week tail; it must not stomp this.
    await db.insert(schema.repDailyStatus).values({
      repId: protectedRep,
      businessDate: futureDates[0],
      status: 'INELIGIBLE',
      decidedBy: 'MANAGER_OVERRIDE',
      reason: 'suspended by another manager',
    })
    for (const repId of rest) {
      await db.insert(schema.repDailyStatus).values({
        repId,
        businessDate: futureDates[0],
        status: 'INELIGIBLE',
        decidedBy: 'SYSTEM',
        reason: 'WEEK_DQ',
      })
    }

    await bulkOverrideStatus(db, {
      repIds,
      status: 'FORCE_ACTIVE',
      reasonCode: 'DEACTIVATED_IN_ERROR',
      reasonNote: 'Deactivated in error',
      actorUserId: managerUserId,
    })

    const kept = await db.query.repDailyStatus.findFirst({
      where: and(
        eq(schema.repDailyStatus.repId, protectedRep),
        eq(schema.repDailyStatus.businessDate, futureDates[0]),
      ),
    })
    expect(kept?.status).toBe('INELIGIBLE')
    expect(kept?.decidedBy).toBe('MANAGER_OVERRIDE')

    for (const repId of rest) {
      const cleared = await db.query.repDailyStatus.findFirst({
        where: and(
          eq(schema.repDailyStatus.repId, repId),
          eq(schema.repDailyStatus.businessDate, futureDates[0]),
        ),
      })
      expect(cleared).toBeUndefined()
    }
  })

  it('serializes against a concurrent assignLead rather than interleaving', async () => {
    // The batch holds the rotation lock for its whole duration. If it did not, an assign
    // landing mid-batch could pick a rep the batch was in the middle of deactivating.
    await db.delete(schema.assignmentEvents)
    await db.delete(schema.rrCycleAssignments)
    await db.delete(schema.unassignedQueue)
    await db.delete(schema.lead)
    await db.delete(schema.customer)
    await db.delete(schema.repMonthCounters)

    await setStatus(repIds, 'ELIGIBLE', 'SYSTEM')
    const bdc = await db.query.appUser.findFirst({ where: eq(schema.appUser.role, 'BDC') })

    await Promise.all([
      bulkOverrideStatus(db, {
        repIds,
        status: 'FORCE_INACTIVE',
        reasonCode: 'TRAINING',
        reasonNote: 'Training',
        actorUserId: managerUserId,
      }),
      assignLead(db, {
        idempotencyKey: randomUUID(),
        customerName: 'Concurrent With Bulk',
        customerPhoneE164: '+15557770001',
        actorUserId: bdc!.id,
      }),
    ])

    // Whichever won the lock, the ledger and the counters agree — that is what the lock buys.
    const events = await db.query.assignmentEvents.findMany({
      where: eq(schema.assignmentEvents.eventType, 'ASSIGN'),
    })
    const counters = await db.query.repMonthCounters.findMany()
    const totalCredited = counters.reduce((sum: number, c: any) => sum + c.upsMtd, 0)
    expect(totalCredited).toBe(events.length)
  })

  it('rolls the whole batch back when one rep fails', async () => {
    await setStatus(repIds, 'ELIGIBLE', 'SYSTEM')
    const bogusRepId = '00000000-0000-0000-0000-000000000000'

    await expect(
      bulkOverrideStatus(db, {
        repIds: [...repIds, bogusRepId],
        status: 'FORCE_INACTIVE',
        reasonCode: 'PTO',
        reasonNote: 'PTO',
        actorUserId: managerUserId,
      }),
    ).rejects.toThrow()

    // Partial success is not a state a manager should have to reason about.
    const overrides = await db.query.statusOverride.findMany({
      where: inArray(schema.statusOverride.repId, repIds),
    })
    expect(overrides.length).toBe(0)

    for (const repId of repIds) {
      const row = await db.query.repDailyStatus.findFirst({
        where: and(eq(schema.repDailyStatus.repId, repId), eq(schema.repDailyStatus.businessDate, today)),
      })
      expect(row?.status).toBe('ELIGIBLE')
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://localhost/phoneup_test pnpm --filter @phoneup/api test src/domain/bulkOverrideStatus.test.ts`
Expected: FAIL — `Failed to resolve import "./bulkOverrideStatus"`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/domain/bulkOverrideStatus.ts`:

```ts
import { sql, eq, and, inArray } from 'drizzle-orm'
import type { DB } from '@phoneup/db'
import { schema } from '@phoneup/db'
import { businessDate, isOverrideNoOp, type CurrentRepStatus, type OverrideTarget } from '@phoneup/core'
import { ADVISORY_LOCK_KEY, applyOverrideStatus } from './overrideStatus'

export type BulkOverrideStatusInput = {
  repIds: string[]
  status: OverrideTarget
  reasonCode: string
  reasonNote: string
  actorUserId: string
}

export type BulkOverrideStatusResult = {
  applied: string[]
  skipped: string[]
}

/**
 * Apply one status decision to many reps in a single transaction under a single
 * `pg_advisory_xact_lock`.
 *
 * Deliberately not N calls to `overrideStatus` from the client: status changes reorder the
 * rotation, so N transactions would make a partial apply reachable and would take and
 * release the lock N times while a BDC agent waits to assign a lead.
 *
 * The no-op rule is re-checked HERE rather than trusted from the client. The Staff List's
 * roster can be seconds stale, and the same lock that serializes this batch is what makes
 * the re-read authoritative.
 */
export async function bulkOverrideStatus(
  db: DB,
  input: BulkOverrideStatusInput,
): Promise<BulkOverrideStatusResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)

    const today = businessDate(new Date())
    const rows = await tx.query.repDailyStatus.findMany({
      where: and(
        inArray(schema.repDailyStatus.repId, input.repIds),
        eq(schema.repDailyStatus.businessDate, today),
      ),
    })
    const statusByRep = new Map(rows.map((row: any) => [row.repId, row]))

    const applied: string[] = []
    const skipped: string[] = []

    for (const repId of input.repIds) {
      const row: any = statusByRep.get(repId)
      const current: CurrentRepStatus = {
        isEligible: row?.status === 'ELIGIBLE',
        decidedBy: row?.decidedBy ?? null,
      }

      if (isOverrideNoOp(input.status, current)) {
        skipped.push(repId)
        continue
      }

      await applyOverrideStatus(tx, {
        repId,
        status: input.status,
        reasonCode: input.reasonCode,
        reasonNote: input.reasonNote,
        actorUserId: input.actorUserId,
      })
      applied.push(repId)
    }

    return { applied, skipped }
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://localhost/phoneup_test pnpm --filter @phoneup/api test src/domain/bulkOverrideStatus.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the whole API suite**

Run: `TEST_DATABASE_URL=postgresql://localhost/phoneup_test pnpm --filter @phoneup/api test`
Expected: PASS, 14 files, 133 tests.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm typecheck`
Expected: all five projects Done.

```bash
git add apps/api/src/domain/bulkOverrideStatus.ts apps/api/src/domain/bulkOverrideStatus.test.ts
git commit -m "$(cat <<'EOF'
feat(api): apply a status decision to many reps in one transaction

One transaction, one advisory lock for the whole batch. N calls from the
client would make a partial apply reachable and would take and release
the rotation lock N times while a BDC agent waits to assign a lead.

The no-op rule is re-checked inside the transaction rather than trusted
from the client, whose roster can be seconds stale. Reps that would not
change come back in `skipped` with nothing written for them; one audit
event per applied rep keeps a rep's own history complete.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Expose it as `rep.bulkOverrideStatus`

**Files:**
- Modify: `packages/contracts/src/schemas.ts`
- Modify: `apps/api/src/routers/rep.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `bulkOverrideStatus` from `../domain/bulkOverrideStatus`.
- Produces:
  - `bulkStatusOverrideInputSchema` and `type BulkStatusOverrideInput` from `@phoneup/contracts`.
  - tRPC mutation `rep.bulkOverrideStatus` returning `{ applied: string[]; skipped: string[] }`.

- [ ] **Step 1: Add the input schema**

In `packages/contracts/src/schemas.ts`, immediately after `statusOverrideInputSchema` (line 21):

```ts
export const bulkStatusOverrideInputSchema = z.object({
  // Capped well above a single store's roster (~30 reps). The cap is a guard against a
  // malformed client, not a product limit.
  repIds: z
    .array(z.string().uuid())
    .min(1)
    .max(200)
    .transform((ids) => [...new Set(ids)]),
  status: z.enum(['FORCE_ACTIVE', 'FORCE_INACTIVE', 'FOLLOW_SCHEDULE']),
  reasonCode: z.string().min(1),
  reasonNote: z.string().min(1),
})
```

And with the other type exports near line 106:

```ts
export type BulkStatusOverrideInput = z.infer<typeof bulkStatusOverrideInputSchema>
```

- [ ] **Step 2: Add the route**

In `apps/api/src/routers/rep.ts`, extend the contracts import and add the domain import:

```ts
import { statusOverrideInputSchema, bulkStatusOverrideInputSchema, setDaysOffInputSchema } from '@phoneup/contracts'
import { bulkOverrideStatus } from '../domain/bulkOverrideStatus'
```

Then add the mutation directly after `overrideStatus`:

```ts
  /** Same decision applied to many reps, in one transaction under one advisory lock. */
  bulkOverrideStatus: publicProcedure
    .use(requirePerm('rep.override'))
    .input(bulkStatusOverrideInputSchema)
    .mutation(async ({ ctx, input }) => {
      return bulkOverrideStatus(db, { ...input, actorUserId: ctx.session.userId })
    }),
```

- [ ] **Step 3: Verify the permission gate holds**

Run: `TEST_DATABASE_URL=postgresql://localhost/phoneup_test pnpm --filter @phoneup/api test src/trpc/requirePerm.test.ts`
Expected: PASS, 6 tests. `rep.override` is an existing permission, so no permission-table change is needed — confirm the suite still passes rather than assuming.

- [ ] **Step 4: Record the rule in CLAUDE.md**

In `CLAUDE.md`, under "Decided architecture", extend the **Concurrency** bullet. It currently reads:

```
- **Concurrency:** one `pg_advisory_xact_lock` per assignment transaction. This is the load-bearing correctness mechanism for multi-BDC-agent races. Every path that changes ordering (assign, void, reassign, status override, reactivation) takes the same lock.
```

Append to that bullet:

```
 A bulk status change takes it **once for the whole batch**, not once per rep — `bulkOverrideStatus` opens one transaction and calls `applyOverrideStatus` per rep inside it. Per-rep transactions would make a partial apply reachable. A rep whose visible status already matches the action is skipped, using the one shared `isOverrideNoOp` in `packages/core`; do not add a second copy of that rule to the client.
```

- [ ] **Step 5: Typecheck and run both suites**

Run: `pnpm typecheck`
Expected: all five projects Done.

Run: `TEST_DATABASE_URL=postgresql://localhost/phoneup_test pnpm --filter @phoneup/api test`
Expected: PASS, 14 files, 133 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/schemas.ts apps/api/src/routers/rep.ts CLAUDE.md
git commit -m "$(cat <<'EOF'
feat(api): expose rep.bulkOverrideStatus

Same rep.override permission as the single-rep route. Ids are deduped and
capped at 200 — a guard against a malformed client, not a product limit.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `board.roster` returns `decidedBy`

The payload has `isEligible` and `ineligibleReason` but not who decided. Without it the client cannot tell "ineligible because it is their scheduled day off" from "ineligible because a manager sat them down", which is exactly what the Follow schedule button keys on.

`decidedBy` is merged at the response layer, the same way `displayName` already is. `RepRankInput` in `packages/core` is the ranking algorithm's input and stays untouched — the algorithm has no business reading who decided a status.

**Files:**
- Modify: `apps/api/src/routers/board.ts:13-52`

**Interfaces:**
- Consumes: nothing new.
- Produces: `board.roster` entries gain `decidedBy: 'SYSTEM' | 'MANAGER_OVERRIDE' | null`.

- [ ] **Step 1: Change `computeRoster` to return the status map alongside the ranking**

In `apps/api/src/routers/board.ts`, change the signature and the return (line 13 and line 43):

```ts
async function computeRoster(): Promise<{
  ranked: RepRankInput[]
  decidedByRep: Map<string, 'SYSTEM' | 'MANAGER_OVERRIDE'>
}> {
```

The body is unchanged up to the return. Replace the final `return rankReps(rankInputs)` with:

```ts
  // Presentation only, so it is merged at the response layer rather than pushed into
  // RepRankInput — the ranking algorithm has no business reading who decided a status.
  const decidedByRep = new Map<string, 'SYSTEM' | 'MANAGER_OVERRIDE'>(
    statuses.map((s: any) => [s.repId, s.decidedBy]),
  )

  return { ranked: rankReps(rankInputs), decidedByRep }
}
```

- [ ] **Step 2: Merge it into the `roster` response**

Replace the body of the `roster` query (lines 47-52):

```ts
  roster: publicProcedure.use(requirePerm('board.view')).query(async () => {
    const { ranked, decidedByRep } = await computeRoster()
    const repRows = await db.select().from(schema.salesRep)
    const nameById = new Map(repRows.map((r: any) => [r.id, r.displayName]))
    return ranked.map((r) => ({
      ...r,
      displayName: nameById.get(r.repId) ?? 'Unknown',
      // null when the rep has no rep_daily_status row for today.
      decidedBy: decidedByRep.get(r.repId) ?? null,
    }))
  }),
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: all five projects Done. `computeRoster` has exactly one caller, so a missed destructure surfaces here.

- [ ] **Step 4: Verify the payload by hand**

Start the API and query the route as a signed-in manager, or run the existing suite which exercises the ranking:

Run: `TEST_DATABASE_URL=postgresql://localhost/phoneup_test pnpm --filter @phoneup/api test`
Expected: PASS, 14 files, 133 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routers/board.ts
git commit -m "$(cat <<'EOF'
feat(api): return decidedBy on board.roster entries

The client could not tell "ineligible because it is their scheduled day
off" from "ineligible because a manager sat them down", which is what the
Follow schedule button keys on.

Merged at the response layer like displayName. RepRankInput stays
untouched — the ranking algorithm has no business reading who decided a
status.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Staff List pure helpers

Selection and the applied/skipped split are the parts worth testing, so they are extracted as pure exported functions and tested directly — the pattern `AssignScreen.tsx`/`AssignScreen.test.ts` already uses.

**Files:**
- Modify: `apps/web/src/pages/StaffList.tsx`
- Create: `apps/web/src/pages/StaffList.test.ts`

**Interfaces:**
- Consumes: `isOverrideNoOp`, `type OverrideTarget`, `type CurrentRepStatus` from `@phoneup/core`.
- Produces, exported from `StaffList.tsx`:
  - `type RosterEntry` gains `decidedBy: 'SYSTEM' | 'MANAGER_OVERRIDE' | null`.
  - `function currentStatusOf(entry: RosterEntry): CurrentRepStatus`
  - `function reconcileSelection(selected: string[], roster: RosterEntry[]): string[]`
  - `function splitByNoOp(target: OverrideTarget, entries: RosterEntry[]): { applied: RosterEntry[]; skipped: RosterEntry[] }`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/pages/StaffList.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { reconcileSelection, splitByNoOp, currentStatusOf } from './StaffList'

type Entry = Parameters<typeof splitByNoOp>[1][number]

function entry(over: Partial<Entry> & { repId: string }): Entry {
  return {
    displayName: over.repId,
    isEligible: true,
    monthlyLoad: 0,
    decidedBy: 'SYSTEM',
    ...over,
  }
}

describe('currentStatusOf', () => {
  it('maps a roster entry onto the shared no-op input', () => {
    expect(currentStatusOf(entry({ repId: 'a', isEligible: false, decidedBy: 'MANAGER_OVERRIDE' }))).toEqual({
      isEligible: false,
      decidedBy: 'MANAGER_OVERRIDE',
    })
  })

  it('carries a missing status row through as null', () => {
    expect(currentStatusOf(entry({ repId: 'a', decidedBy: null }))).toEqual({
      isEligible: true,
      decidedBy: null,
    })
  })
})

describe('reconcileSelection', () => {
  it('keeps ids that are still on the roster', () => {
    const roster = [entry({ repId: 'a' }), entry({ repId: 'b' })]
    expect(reconcileSelection(['a', 'b'], roster)).toEqual(['a', 'b'])
  })

  it('drops ids that vanished from a refreshed roster', () => {
    // The list refreshes on every board realtime event. A stale id left in the
    // selection would silently widen the next batch.
    const roster = [entry({ repId: 'a' })]
    expect(reconcileSelection(['a', 'gone'], roster)).toEqual(['a'])
  })

  it('returns an empty selection when the roster empties', () => {
    expect(reconcileSelection(['a', 'b'], [])).toEqual([])
  })
})

describe('splitByNoOp', () => {
  it('splits a deactivate into the reps it would change and the rest', () => {
    const { applied, skipped } = splitByNoOp('FORCE_INACTIVE', [
      entry({ repId: 'eligible' }),
      entry({ repId: 'alreadyOut', isEligible: false }),
      entry({ repId: 'alsoEligible' }),
    ])
    expect(applied.map((r) => r.repId)).toEqual(['eligible', 'alsoEligible'])
    expect(skipped.map((r) => r.repId)).toEqual(['alreadyOut'])
  })

  it('splits a reactivate the other way', () => {
    const { applied, skipped } = splitByNoOp('FORCE_ACTIVE', [
      entry({ repId: 'eligible' }),
      entry({ repId: 'out', isEligible: false }),
    ])
    expect(applied.map((r) => r.repId)).toEqual(['out'])
    expect(skipped.map((r) => r.repId)).toEqual(['eligible'])
  })

  it('only follows schedule for reps carrying a manager override', () => {
    const { applied, skipped } = splitByNoOp('FOLLOW_SCHEDULE', [
      entry({ repId: 'overridden', isEligible: false, decidedBy: 'MANAGER_OVERRIDE' }),
      entry({ repId: 'systemDecided', isEligible: false, decidedBy: 'SYSTEM' }),
      entry({ repId: 'noRow', decidedBy: null }),
    ])
    expect(applied.map((r) => r.repId)).toEqual(['overridden'])
    expect(skipped.map((r) => r.repId)).toEqual(['systemDecided', 'noRow'])
  })

  it('is non-leaky: every entry lands in exactly one side', () => {
    const entries = [
      entry({ repId: 'a' }),
      entry({ repId: 'b', isEligible: false }),
      entry({ repId: 'c', decidedBy: 'MANAGER_OVERRIDE' }),
    ]
    const { applied, skipped } = splitByNoOp('FORCE_INACTIVE', entries)
    expect(applied.length + skipped.length).toBe(entries.length)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @phoneup/web test src/pages/StaffList.test.ts`
Expected: FAIL — `does not provide an export named 'reconcileSelection'`.

- [ ] **Step 3: Write the helpers**

In `apps/web/src/pages/StaffList.tsx`, extend the imports:

```ts
import { isOverrideNoOp, type CurrentRepStatus, type OverrideTarget } from '@phoneup/core'
```

Change the `RosterEntry` type (currently lines 9-15) to carry `decidedBy`:

```ts
export type RosterEntry = {
  repId: string
  displayName: string
  isEligible: boolean
  ineligibleReason?: string
  monthlyLoad: number
  /** Who decided today's status; null when the rep has no row for today. */
  decidedBy: 'SYSTEM' | 'MANAGER_OVERRIDE' | null
}
```

Add the three helpers below the `WEEKDAYS` constant, above the component:

```ts
/** Roster entry to the shape the shared no-op rule expects. */
export function currentStatusOf(entry: RosterEntry): CurrentRepStatus {
  return { isEligible: entry.isEligible, decidedBy: entry.decidedBy }
}

/**
 * Drop selected ids that are no longer on the roster. The list refreshes on every board
 * realtime event, and a stale id left in the selection would silently widen a later batch.
 */
export function reconcileSelection(selected: string[], roster: RosterEntry[]): string[] {
  const live = new Set(roster.map((r) => r.repId))
  return selected.filter((repId) => live.has(repId))
}

/**
 * Which of these reps a given action would actually change. Used to enable or disable the
 * bulk buttons and to show the split in the confirm modal — the server re-checks the same
 * rule inside the transaction, so this is a preview, not the decision.
 */
export function splitByNoOp(
  target: OverrideTarget,
  entries: RosterEntry[],
): { applied: RosterEntry[]; skipped: RosterEntry[] } {
  const applied: RosterEntry[] = []
  const skipped: RosterEntry[] = []
  for (const entry of entries) {
    if (isOverrideNoOp(target, currentStatusOf(entry))) skipped.push(entry)
    else applied.push(entry)
  }
  return { applied, skipped }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @phoneup/web test src/pages/StaffList.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`
Expected: all five projects Done.

```bash
git add apps/web/src/pages/StaffList.tsx apps/web/src/pages/StaffList.test.ts
git commit -m "$(cat <<'EOF'
feat(web): extract Staff List selection and no-op split as pure helpers

Selection reconciliation and the applied/skipped preview are the parts
worth testing, so they are pure exported functions tested directly, the
pattern AssignScreen already uses.

Reconciliation drops ids missing from a refreshed roster: the list
refreshes on every board realtime event and a stale id would silently
widen a later batch.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Preset reasons and inert per-row buttons

**Files:**
- Modify: `apps/web/src/pages/StaffList.tsx`

**Interfaces:**
- Consumes: `currentStatusOf` and `RosterEntry` from Task 6; `isOverrideNoOp`, `noOpReason` from `@phoneup/core`; `Select` from `../ui`.
- Produces:
  - `const REASON_PRESETS: Record<OverrideTarget, Array<{ code: string; label: string }>>`
  - `function presetsFor(target: OverrideTarget)` — used by both the per-row and bulk modals in Task 8.

- [ ] **Step 1: Add the preset table**

In `apps/web/src/pages/StaffList.tsx`, replace the `STATUS_OPTIONS`/`StatusOption` declarations (lines 17-24) with the shared-typed versions plus the presets. `OverrideTarget` from `@phoneup/core` is now the single definition of the three actions:

```ts
const STATUS_OPTIONS: OverrideTarget[] = ['FORCE_ACTIVE', 'FORCE_INACTIVE', 'FOLLOW_SCHEDULE']

const STATUS_LABEL: Record<OverrideTarget, string> = {
  FORCE_ACTIVE: 'Reactivate',
  FORCE_INACTIVE: 'Deactivate',
  FOLLOW_SCHEDULE: 'Follow schedule',
}

/**
 * One list per action, shared by the per-row and bulk modals so the two cannot drift.
 * OTHER is always last and is the only option that requires typing.
 */
const OTHER = { code: 'OTHER', label: 'Other' }

const REASON_PRESETS: Record<OverrideTarget, Array<{ code: string; label: string }>> = {
  FORCE_INACTIVE: [
    { code: 'BELOW_CALL_MINIMUM', label: 'Below call minimum' },
    { code: 'ABSENT', label: 'Called out / absent' },
    { code: 'PTO', label: 'PTO' },
    { code: 'TRAINING', label: 'Training' },
    { code: 'DISCIPLINARY', label: 'Disciplinary' },
    OTHER,
  ],
  FORCE_ACTIVE: [
    { code: 'SUSPENSION_LIFTED', label: 'Suspension lifted early' },
    { code: 'ABSENCE_RESOLVED', label: 'Absence resolved' },
    { code: 'DEACTIVATED_IN_ERROR', label: 'Deactivated in error' },
    OTHER,
  ],
  FOLLOW_SCHEDULE: [{ code: 'OVERRIDE_NOT_NEEDED', label: 'Override no longer needed' }, OTHER],
}

export function presetsFor(target: OverrideTarget) {
  return REASON_PRESETS[target]
}
```

Delete every remaining reference to the old `StatusOption` type and use `OverrideTarget` instead.

- [ ] **Step 2: Replace the free-text reason state with a preset code plus optional note**

Replace the reason state (line 45) and add a derived note:

```ts
  const [pendingStatus, setPendingStatus] = useState<OverrideTarget | null>(null)
  const [reasonCode, setReasonCode] = useState<string>('')
  const [otherNote, setOtherNote] = useState('')
```

Add above `submitOverride`:

```ts
  // OTHER is the only preset that requires typing; every other one submits with no input.
  const isOther = reasonCode === 'OTHER'
  const reasonNote = isOther
    ? otherNote
    : (pendingStatus ? presetsFor(pendingStatus).find((p) => p.code === reasonCode)?.label ?? '' : '')
  const reasonReady = reasonCode !== '' && (!isOther || otherNote.trim() !== '')
```

Rewrite `submitOverride` and `closeOverride`:

```ts
  async function submitOverride() {
    if (!pendingRepId || !pendingStatus || !reasonReady) return
    setError(null)
    try {
      await mutate('rep.overrideStatus', {
        repId: pendingRepId,
        status: pendingStatus,
        reasonCode,
        reasonNote,
      })
      closeOverride()
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'override failed')
    }
  }

  function closeOverride() {
    setPendingRepId(null)
    setPendingStatus(null)
    setReasonCode('')
    setOtherNote('')
  }
```

Update the Enter handler to key on the new readiness flag:

```ts
  const onReasonKeyDown = useSubmitOnEnter(submitOverride, {
    mode: 'multiline',
    disabled: !reasonReady,
  })
```

- [ ] **Step 3: Make the per-row buttons inert when they cannot accomplish anything**

Replace the per-row action cell (lines 190-207):

```ts
            <td>
              <div className="ui-row">
                {canOverride &&
                  STATUS_OPTIONS.map((status) => {
                    const noOp = isOverrideNoOp(status, currentStatusOf(r))
                    return (
                      <Button
                        key={status}
                        size="sm"
                        variant={status === 'FORCE_INACTIVE' ? 'danger' : 'default'}
                        disabled={noOp}
                        // A dead button should say why rather than just not responding.
                        title={noOp ? noOpReason(status) : undefined}
                        onClick={() => {
                          setPendingRepId(r.repId)
                          setPendingStatus(status)
                          setReasonCode('')
                          setOtherNote('')
                        }}
                      >
                        {STATUS_LABEL[status]}
                      </Button>
                    )
                  })}
              </div>
            </td>
```

- [ ] **Step 4: Replace the modal's textarea with a preset dropdown**

Replace the modal body (lines 212-232):

```tsx
      <Modal
        open={!!pendingRepId && !!pendingStatus}
        title={`${pendingStatus ? STATUS_LABEL[pendingStatus] : ''} — ${pendingRep?.displayName ?? ''}`}
        onClose={closeOverride}
        onSubmit={submitOverride}
        submitDisabled={!reasonReady}
        hint={isOther ? 'Ctrl+Enter to confirm, Esc to cancel' : 'Esc to cancel'}
      >
        <Field label="Reason (required)">
          <Select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
            <option value="">Choose a reason…</option>
            {pendingStatus &&
              presetsFor(pendingStatus).map((preset) => (
                <option key={preset.code} value={preset.code}>
                  {preset.label}
                </option>
              ))}
          </Select>
        </Field>
        {isOther && (
          <Field label="Details (required)">
            <Textarea value={otherNote} onChange={(e) => setOtherNote(e.target.value)} onKeyDown={onReasonKeyDown} />
          </Field>
        )}
        {pendingStatus === 'FORCE_ACTIVE' && (
          <p className="ui-hint">
            Clears any remaining week suspension. The rep is still subject to the daily call
            qualifier tomorrow morning — reactivation does not exempt anyone.
          </p>
        )}
        {pendingStatus === 'FORCE_INACTIVE' && (
          <p className="ui-hint">Applies through the end of the business week (Saturday).</p>
        )}
      </Modal>
```

Add `Select` to the `../ui` import at the top of the file.

- [ ] **Step 5: Run the web suite and typecheck**

Run: `pnpm --filter @phoneup/web test`
Expected: PASS, 4 files, 24 tests.

Run: `pnpm typecheck`
Expected: all five projects Done.

- [ ] **Step 6: Verify in the running app**

Start the app (`pnpm dev` from the repo root, or per `docs/RUNBOOK.md`), sign in as a manager, open the Staff List and confirm:
- Reactivate is greyed out on an eligible rep and its tooltip reads "Already active".
- Deactivate is greyed out on an ineligible rep and reads "Already inactive".
- Follow schedule is greyed out unless the rep carries a manager override.
- Deactivating a rep offers the six presets, submits with no typing, and only shows the textarea for Other.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/StaffList.tsx
git commit -m "$(cat <<'EOF'
feat(web): preset reasons and inert status buttons on the Staff List

Every status button used to open a modal and demand a typed reason,
including when it could not accomplish anything: deactivating an already
ineligible rep prompted for a decision and then wrote an override nobody
could see. The buttons now disable themselves through the shared
isOverrideNoOp rule and say why on hover.

The required free-text reason becomes a dropdown. reasonCode gets the
preset key instead of echoing the status field, which made it useless for
grouping. Other is the only option that still requires typing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Multi-select and the bulk toolbar

**Files:**
- Modify: `apps/web/src/pages/StaffList.tsx`
- Modify: `apps/web/src/styles/ui.css`
- Modify: `docs/RUNBOOK.md:345`

**Interfaces:**
- Consumes: `reconcileSelection`, `splitByNoOp`, `presetsFor`, `STATUS_OPTIONS`, `STATUS_LABEL` from Tasks 6 and 7; `rep.bulkOverrideStatus` from Task 4.
- Produces: nothing consumed by a later task.

- [ ] **Step 1: Add selection state that survives a refresh**

In `apps/web/src/pages/StaffList.tsx`, add alongside the other state:

```ts
  const [selected, setSelected] = useState<string[]>([])
  // Separate from `error`: "2 were already in that state" is an outcome, not a failure.
  const [notice, setNotice] = useState<string | null>(null)
```

Render it next to the existing error line, just under the toolbar:

```tsx
      {error && <p className="ui-error">{error}</p>}
      {notice && <p className="ui-hint">{notice}</p>}
```

Clear it at the start of every action that can produce a new one — add `setNotice(null)` beside each existing `setError(null)`.

Inside `refresh`, after `setRoster(rows)`, drop ids that vanished:

```ts
        setRoster(rows)
        setSelected((prev) => reconcileSelection(prev, rows))
```

Add the derived selection values above the return:

```ts
  const selectedSet = new Set(selected)
  const selectedEntries = roster.filter((r) => selectedSet.has(r.repId))
  const allSelected = roster.length > 0 && selected.length === roster.length

  function toggleRep(repId: string) {
    setSelected((prev) => (prev.includes(repId) ? prev.filter((id) => id !== repId) : [...prev, repId]))
  }

  function toggleAll() {
    setSelected((prev) => (prev.length === roster.length ? [] : roster.map((r) => r.repId)))
  }
```

- [ ] **Step 2: Add the bulk modal state and submit**

Add state:

```ts
  const [bulkStatus, setBulkStatus] = useState<OverrideTarget | null>(null)
```

Add the derived split and the submit, next to the single-rep versions. Note the reason state is shared with the per-row modal, so `closeOverride` already clears it:

```ts
  const bulkSplit = bulkStatus ? splitByNoOp(bulkStatus, selectedEntries) : null

  async function submitBulk() {
    if (!bulkStatus || !bulkSplit || bulkSplit.applied.length === 0 || !reasonReady) return
    setError(null)
    try {
      const result = await mutate<{ applied: string[]; skipped: string[] }>('rep.bulkOverrideStatus', {
        repIds: bulkSplit.applied.map((r) => r.repId),
        status: bulkStatus,
        reasonCode,
        reasonNote,
      })
      closeBulk()
      // Report what the server actually did: its re-check inside the transaction can
      // disagree with this preview if the roster moved underneath. This is information,
      // not a failure, so it does not go through setError's red styling.
      if (result.skipped.length > 0) {
        setNotice(`${result.applied.length} applied, ${result.skipped.length} already in that state.`)
      }
      setSelected([])
      refresh()
    } catch (err) {
      // Selection is preserved so the manager can retry without re-picking.
      setError(err instanceof Error ? err.message : 'bulk update failed')
    }
  }

  function closeBulk() {
    setBulkStatus(null)
    setReasonCode('')
    setOtherNote('')
  }
```

Point the Enter handler at whichever modal is open:

```ts
  const onReasonKeyDown = useSubmitOnEnter(bulkStatus ? submitBulk : submitOverride, {
    mode: 'multiline',
    disabled: !reasonReady,
  })
```

- [ ] **Step 3: Replace the toolbar**

Replace the whole toolbar block (lines 125-145) — the `Generate 14 days of shifts` button goes with it:

```tsx
      <div className="ui-toolbar">
        <h2>Staff List</h2>
        {canOverride && selected.length > 0 && (
          <>
            <span className="ui-toolbar-spacer" />
            <div className="ui-bulkbar">
              <span className="ui-muted">{selected.length} selected</span>
              {STATUS_OPTIONS.map((status) => {
                const { applied } = splitByNoOp(status, selectedEntries)
                return (
                  <Button
                    key={status}
                    size="sm"
                    variant={status === 'FORCE_INACTIVE' ? 'danger' : 'default'}
                    disabled={applied.length === 0}
                    title={applied.length === 0 ? `No selected rep would change` : undefined}
                    onClick={() => {
                      setBulkStatus(status)
                      setReasonCode('')
                      setOtherNote('')
                    }}
                  >
                    {STATUS_LABEL[status]}
                  </Button>
                )
              })}
              <Button size="sm" onClick={() => setSelected([])}>
                Clear
              </Button>
            </div>
          </>
        )}
      </div>
```

- [ ] **Step 4: Add the checkbox column**

Change the headers (line 121) to lead with the select-all box:

```tsx
  const headers = [
    // Spread, not a ternary yielding '': the row below omits the cell entirely when
    // canOverride is false, so an empty header string would leave the columns misaligned.
    ...(canOverride
      ? [
          <input
            key="select-all"
            type="checkbox"
            aria-label="Select all reps"
            checked={allSelected}
            ref={(el) => {
              // Partial selection reads as indeterminate, not as unchecked.
              if (el) el.indeterminate = selected.length > 0 && !allSelected
            }}
            onChange={toggleAll}
          />,
        ]
      : []),
    'Rep',
    'Status',
    'Ups MTD',
    ...(canManageSchedule ? ['Recurring days off'] : []),
    'Action',
  ]
```

Add the leading cell as the first `<td>` of each row, before the rep name cell:

```tsx
            {canOverride && (
              <td>
                <input
                  type="checkbox"
                  aria-label={`Select ${r.displayName}`}
                  checked={selectedSet.has(r.repId)}
                  onChange={() => toggleRep(r.repId)}
                />
              </td>
            )}
```

Header and cell are gated on the same `canOverride`, so the column counts match in both cases.

- [ ] **Step 5: Add the bulk confirm modal**

Add after the existing per-row `<Modal>`:

```tsx
      <Modal
        open={!!bulkStatus}
        title={
          bulkStatus && bulkSplit
            ? `${STATUS_LABEL[bulkStatus]} ${bulkSplit.applied.length} of ${selected.length} selected`
            : ''
        }
        onClose={closeBulk}
        onSubmit={submitBulk}
        submitDisabled={!reasonReady || !bulkSplit || bulkSplit.applied.length === 0}
        submitLabel={bulkSplit ? `${bulkStatus ? STATUS_LABEL[bulkStatus] : ''} ${bulkSplit.applied.length}` : 'Confirm'}
        hint={isOther ? 'Ctrl+Enter to confirm, Esc to cancel' : 'Esc to cancel'}
      >
        {bulkSplit && (
          <>
            <p className="ui-muted">{bulkSplit.applied.map((r) => r.displayName).join(' · ')}</p>
            {bulkSplit.skipped.length > 0 && (
              // Named rather than silently dropped: a manager who selected them should see
              // that they were left alone.
              <p className="ui-hint">
                Unchanged, already in that state: {bulkSplit.skipped.map((r) => r.displayName).join(' · ')}
              </p>
            )}
          </>
        )}
        <Field label="Reason (required)">
          <Select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
            <option value="">Choose a reason…</option>
            {bulkStatus &&
              presetsFor(bulkStatus).map((preset) => (
                <option key={preset.code} value={preset.code}>
                  {preset.label}
                </option>
              ))}
          </Select>
        </Field>
        {isOther && (
          <Field label="Details (required)">
            <Textarea value={otherNote} onChange={(e) => setOtherNote(e.target.value)} onKeyDown={onReasonKeyDown} />
          </Field>
        )}
        {bulkStatus === 'FORCE_INACTIVE' && (
          <p className="ui-hint">Applies through the end of the business week (Saturday).</p>
        )}
      </Modal>
```

- [ ] **Step 6: Style the bulk bar**

In `apps/web/src/styles/ui.css`, add after the `.ui-toolbar-spacer` rule (line 84):

```css
.ui-bulkbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
```

- [ ] **Step 7: Update the RUNBOOK**

`docs/RUNBOOK.md:345` currently offers a button that no longer exists:

```
| Reps show `CONFIGURATION_ERROR` | No `rep_shift` row for today | Run `materialize-shifts`, or Staff List → Generate shifts. |
```

Replace the remedy cell with:

```
| Reps show `CONFIGURATION_ERROR` | No `rep_shift` row for today | Run `materialize-shifts`. The weekly job (Sun 03:00) normally keeps 14 days ahead. |
```

- [ ] **Step 8: Run both suites and typecheck**

Run: `pnpm --filter @phoneup/web test`
Expected: PASS, 4 files, 24 tests.

Run: `pnpm typecheck`
Expected: all five projects Done.

Run: `TEST_DATABASE_URL=postgresql://localhost/phoneup_test pnpm --filter @phoneup/api test`
Expected: PASS, 14 files, 133 tests.

- [ ] **Step 9: Verify in the running app**

Sign in as a manager and confirm end to end:
- Selecting reps reveals the bulk bar with an accurate count; the header checkbox goes indeterminate on a partial selection and select-all works.
- Deactivating a mixed selection names the skipped reps in the modal and applies only the rest.
- A bulk button is disabled when no selected rep would change.
- The selection clears after a successful apply and survives a failure.
- `Generate 14 days of shifts` is gone.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/pages/StaffList.tsx apps/web/src/styles/ui.css docs/RUNBOOK.md
git commit -m "$(cat <<'EOF'
feat(web): bulk activate and deactivate on the Staff List

Sitting five reps down after a bad call day was five modals and five
typed reasons. A checkbox column and a bulk bar apply one decision to a
selection through rep.bulkOverrideStatus, which does the whole batch in a
single transaction under a single advisory lock.

The confirm modal names the reps the action would skip rather than
silently dropping them, and the result is reported from what the server
actually applied — its re-check inside the transaction can disagree with
the preview if the roster moved underneath.

Replaces the Generate 14 days of shifts button, which duplicated the
weekly cron and the materialize-shifts CLI. RUNBOOK's
CONFIGURATION_ERROR remedy points at the script instead.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Verification

After Task 8, from a clean tree:

```bash
pnpm typecheck
pnpm --filter @phoneup/core test
pnpm --filter @phoneup/web test
TEST_DATABASE_URL=postgresql://localhost/phoneup_test pnpm --filter @phoneup/api test
```

All four must pass before this queue item is called done. CI runs the same three checks plus a build on every push to `main`.
