# Priority 4B Status Authority and Realtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let failing activity evidence deactivate a manually activated rep, never auto-reactivate an inactive rep, and publish manual Staff List status changes to every connected client.

**Architecture:** Put manager-versus-system precedence in one pure domain predicate consumed by both eligibility implementations. Narrow the existing blanket manager-override guard only for activity-sourced ineligibility, preserving manager precedence for schedule/configuration writes, then publish one existing `ELIGIBILITY_UPDATED` board event after each successful single/bulk manual status transaction.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL advisory locks, Vitest, existing WebSocket event bus.

## Global Constraints

- Governing spec: `docs/superpowers/specs/2026-08-02-priority-4-staff-user-management-design.md`.
- Use Node 22.x and pnpm 11.17.0 for final validation.
- Activity reports never reactivate reps; passing evidence performs no activation write.
- `LOG_ONLY`, preview-token freshness, manager review, advisory locking, append-only overrides/audit, and through-Saturday DQ remain unchanged.
- Realtime publication happens only after commit and only when a mutation applied a status change.
- Do not change day-off editing or management copy/accessibility in this plan.

---

### Task 1: Define one outcome-specific status-authority rule

**Files:**
- Create: `apps/api/src/domain/statusAuthority.ts`
- Create: `apps/api/src/domain/statusAuthority.test.ts`

**Interfaces:**
- Produces: `managerStatusBlocksSystemWrite(existing, incomingStatus, source)` and `managerStatusSkipsActivityEvaluation(existing)`.
- Consumers: activity import and background eligibility tasks below.

- [ ] **Step 1: Write the complete truth-table test**

```ts
import { describe, expect, it } from 'vitest'
import { managerStatusBlocksSystemWrite, managerStatusSkipsActivityEvaluation } from './statusAuthority'

describe('manager/system status authority', () => {
  const active = { status: 'ELIGIBLE', decidedBy: 'MANAGER_OVERRIDE' } as const
  const inactive = { status: 'INELIGIBLE', decidedBy: 'MANAGER_OVERRIDE' } as const

  it('allows failing evidence to replace manager-active', () => {
    expect(managerStatusBlocksSystemWrite(active, 'INELIGIBLE', 'ACTIVITY')).toBe(false)
    expect(managerStatusSkipsActivityEvaluation(active)).toBe(false)
  })

  it('does not let passing activity or non-activity writes replace manager-active', () => {
    expect(managerStatusBlocksSystemWrite(active, 'ELIGIBLE', 'ACTIVITY')).toBe(true)
    expect(managerStatusBlocksSystemWrite(active, 'INELIGIBLE', 'OTHER')).toBe(true)
  })

  it('never lets system evaluation reactivate manager-inactive', () => {
    expect(managerStatusBlocksSystemWrite(inactive, 'ELIGIBLE', 'ACTIVITY')).toBe(true)
    expect(managerStatusBlocksSystemWrite(inactive, 'INELIGIBLE', 'ACTIVITY')).toBe(true)
    expect(managerStatusSkipsActivityEvaluation(inactive)).toBe(true)
  })

  it('does not block rows decided by SYSTEM or missing rows', () => {
    expect(managerStatusBlocksSystemWrite({ status: 'ELIGIBLE', decidedBy: 'SYSTEM' }, 'INELIGIBLE', 'ACTIVITY')).toBe(false)
    expect(managerStatusBlocksSystemWrite(undefined, 'INELIGIBLE', 'ACTIVITY')).toBe(false)
  })
})
```

- [ ] **Step 2: Run and verify the missing-module failure**

Run: `pnpm --filter @phoneup/api test -- src/domain/statusAuthority.test.ts`

Expected: FAIL because `statusAuthority.ts` does not exist.

- [ ] **Step 3: Implement the pure rule**

```ts
type ExistingStatus = {
  status: 'ELIGIBLE' | 'INELIGIBLE' | 'CONFIGURATION_ERROR'
  decidedBy: 'SYSTEM' | 'MANAGER_OVERRIDE'
} | undefined

export function managerStatusSkipsActivityEvaluation(existing: ExistingStatus): boolean {
  return existing?.decidedBy === 'MANAGER_OVERRIDE' && existing.status === 'INELIGIBLE'
}

export function managerStatusBlocksSystemWrite(
  existing: ExistingStatus,
  incomingStatus: 'ELIGIBLE' | 'INELIGIBLE' | 'CONFIGURATION_ERROR',
  source: 'ACTIVITY' | 'OTHER',
): boolean {
  if (existing?.decidedBy !== 'MANAGER_OVERRIDE') return false
  if (existing.status === 'INELIGIBLE') return true
  return !(source === 'ACTIVITY' && incomingStatus === 'INELIGIBLE')
}
```

- [ ] **Step 4: Run the truth table**

Run: `pnpm --filter @phoneup/api test -- src/domain/statusAuthority.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the authority primitive**

```bash
git add apps/api/src/domain/statusAuthority.ts apps/api/src/domain/statusAuthority.test.ts
git commit -m "feat(api): define activity status authority"
```

### Task 2: Apply the rule to reviewed activity imports

**Files:**
- Modify: `apps/api/src/jobs/activityImportDecision.ts:219-260,457-535`
- Modify: `apps/api/src/jobs/activityImportDecision.test.ts`

**Interfaces:**
- Consumes: both `statusAuthority.ts` predicates.
- Preserves: `ActivityImportPreview`, `CommitActivityImportResult`, and existing decision names.

- [ ] **Step 1: Replace the old preservation test with three failing cases**

Create fixtures for manager-active and manager-inactive rows on `STATUS_DATE`:

```ts
expect(preview.ineligibleReps.map((rep) => rep.repId)).toContain(managerActiveRep.id)
await commitDailyActivity(db, { ...reviewedInput, decision: 'LOG_AND_DEACTIVATE', actorUserId })
expect(await statusFor(managerActiveRep.id, STATUS_DATE)).toMatchObject({
  status: 'INELIGIBLE', decidedBy: 'SYSTEM',
})
```

Also assert a passing manager-active rep stays `ELIGIBLE` without an activation write, and manager-inactive remains `INELIGIBLE/MANAGER_OVERRIDE` and is not presented as an auto-reactivation candidate.

- [ ] **Step 2: Run the focused import suite and verify current failures**

Run: `pnpm --filter @phoneup/api test -- src/jobs/activityImportDecision.test.ts`

Expected: FAIL because current preparation reports “manager override already decides today” and `upsertSystemStatus` returns early.

- [ ] **Step 3: Narrow preview skipping and system upsert protection**

```ts
if (managerStatusSkipsActivityEvaluation(existingStatus)) {
  notEvaluatedReps.push({
    repId: rep.id,
    displayName: rep.displayName,
    reason: 'already inactive by manager decision',
  })
  continue
}
```

In `upsertSystemStatus`, replace the blanket source check with:

```ts
if (managerStatusBlocksSystemWrite(existing, status, 'ACTIVITY')) return
```

Do not add eligible status writes to the commit loop; it continues to call the upsert only for `wouldBeStatus === 'INELIGIBLE'` under `LOG_AND_DEACTIVATE`.

- [ ] **Step 4: Run import tests**

Run: `pnpm --filter @phoneup/api test -- src/jobs/activityImportDecision.test.ts`

Expected: PASS, including `LOG_ONLY` and preview-token stale/replay cases.

- [ ] **Step 5: Commit reviewed-import precedence**

```bash
git add apps/api/src/jobs/activityImportDecision.ts apps/api/src/jobs/activityImportDecision.test.ts
git commit -m "fix(activity): let failing reports override activation"
```

### Task 3: Apply the same rule to background eligibility and documentation

**Files:**
- Modify: `apps/api/src/jobs/eligibility.ts:56-64,137-188`
- Modify: `apps/api/src/jobs/eligibility.test.ts`
- Modify: `CLAUDE.md:30-34`

**Interfaces:**
- Consumes: `managerStatusBlocksSystemWrite` and `managerStatusSkipsActivityEvaluation`.
- Produces: the same outcomes as reviewed import for matching facts.

- [ ] **Step 1: Add failing background-evaluation cases**

Assert manager-active plus imported calls below minimum becomes `SYSTEM/INELIGIBLE` through Saturday; manager-active plus passing calls stays active; manager-inactive remains manager-inactive for both passing and failing calls. Add a scheduled-day-off case proving this activity change does not remove the existing manager precedence for non-activity status writes.

```ts
await evaluateRepEligibility(db, { repId, businessDate: today, policyId })
expect(await statusOn(repId, today)).toMatchObject({ status: 'INELIGIBLE', decidedBy: 'SYSTEM' })
```

- [ ] **Step 2: Run and verify the blanket early-return failure**

Run: `pnpm --filter @phoneup/api test -- src/jobs/eligibility.test.ts`

Expected: FAIL because line 64 currently returns for every manager override.

- [ ] **Step 3: Use the shared rule at evaluation and write boundaries**

Replace the top-level early return with `managerStatusSkipsActivityEvaluation(existing)`. Add a `source: 'ACTIVITY' | 'OTHER' = 'OTHER'` parameter to `upsertStatus` and replace `existing.decidedBy === 'MANAGER_OVERRIDE'` with `managerStatusBlocksSystemWrite(existing, status, source)`. Pass `'ACTIVITY'` only from the enforced failing-activity through-Saturday loop; schedule/day-off, CONFIGURATION_ERROR, SHADOW, import-late, and passing calls retain the default `'OTHER'` protection.

Update `CLAUDE.md` to state:

```md
- A manager deactivation remains until a manager reactivates the rep. A manager activation is
  not an activity exemption: failing reviewed/imported activity may replace it with SYSTEM
  INELIGIBLE through Saturday. Passing activity never auto-reactivates an inactive rep.
```

- [ ] **Step 4: Run eligibility and import suites together**

Run: `pnpm --filter @phoneup/api test -- src/jobs/eligibility.test.ts src/jobs/activityImportDecision.test.ts src/domain/statusAuthority.test.ts`

Expected: PASS with identical manager-active/manager-inactive outcomes.

- [ ] **Step 5: Commit background parity and docs**

```bash
git add apps/api/src/jobs/eligibility.ts apps/api/src/jobs/eligibility.test.ts CLAUDE.md
git commit -m "fix(eligibility): align manager status precedence"
```

### Task 4: Publish manual single and bulk status changes after commit

**Files:**
- Modify: `apps/api/src/domain/overrideStatus.ts`
- Modify: `apps/api/src/domain/overrideStatus.test.ts`
- Modify: `apps/api/src/domain/bulkOverrideStatus.ts`
- Modify: `apps/api/src/domain/bulkOverrideStatus.test.ts`

**Interfaces:**
- Consumes: `publishAssignment` existing generic board bus function.
- Produces: `{ type: 'ELIGIBILITY_UPDATED', statusDate }` after successful status transactions.

- [ ] **Step 1: Mock the bus and write failing publication tests**

```ts
vi.mock('../realtime/bus', () => ({ publishAssignment: vi.fn() }))

expect(publishAssignment).toHaveBeenCalledWith({
  type: 'ELIGIBILITY_UPDATED',
  statusDate: today,
})
```

For bulk, assert one publication for a mixed applied/skipped batch, zero when every rep is skipped, and zero after the existing simulated mid-batch rollback.

- [ ] **Step 2: Run focused domain tests and verify no publication**

Run: `pnpm --filter @phoneup/api test -- src/domain/overrideStatus.test.ts src/domain/bulkOverrideStatus.test.ts`

Expected: FAIL because neither domain publishes.

- [ ] **Step 3: Publish only after successful transactions**

```ts
export async function overrideStatus(db: DB, input: OverrideStatusInput): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)
    await applyOverrideStatus(tx, input)
  })
  publishAssignment({ type: 'ELIGIBILITY_UPDATED', statusDate: businessDate(new Date()) })
}
```

For bulk, store the transaction result, publish only when `result.applied.length > 0`, then return it. Never call the bus inside the transaction callback.

- [ ] **Step 4: Run domain and realtime server tests**

Run: `pnpm --filter @phoneup/api test -- src/domain/overrideStatus.test.ts src/domain/bulkOverrideStatus.test.ts src/realtime/server.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit realtime parity**

```bash
git add apps/api/src/domain/overrideStatus.ts apps/api/src/domain/overrideStatus.test.ts apps/api/src/domain/bulkOverrideStatus.ts apps/api/src/domain/bulkOverrideStatus.test.ts
git commit -m "fix(realtime): publish manual status updates"
```

### Task 5: Run Plan 4B regression and two-client checks

**Files:**
- Verify only; do not edit unrelated failures.

- [ ] **Step 1: Run focused API checks serially**

```bash
pnpm --filter @phoneup/api test -- src/domain/statusAuthority.test.ts src/jobs/activityImportDecision.test.ts src/jobs/eligibility.test.ts src/domain/overrideStatus.test.ts src/domain/bulkOverrideStatus.test.ts src/realtime/server.test.ts
```

- [ ] **Step 2: Run API type checking and diff validation**

```bash
pnpm --filter @phoneup/api typecheck
git diff --check
```

- [ ] **Step 3: Verify connected-client behavior**

Open two authenticated clients. From one client perform Reactivate, Deactivate, and a bulk change. Confirm the other client's Staff List, dashboard/roster, and assignment Next Up refresh without page reload. Then commit a reviewed failing activity import for a manager-active rep and confirm both clients show the system deactivation.

- [ ] **Step 4: Record evidence**

Record exact test counts, Node version, each status starting state/outcome, and the two-client refresh result for the final Priority 4 completion update.
