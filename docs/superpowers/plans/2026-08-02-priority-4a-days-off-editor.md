# Priority 4A Days-Off Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace always-editable recurring-day-off radios with one page-wide staged editor whose changed rows save atomically.

**Architecture:** Add a bounded batch contract and one transaction-aware days-off domain path. Extract the existing shift materializer body so the batch can update day-off rows, audit events, and future generated shifts under one transaction and advisory lock. Keep view/edit draft mechanics in `StaffList.tsx`, with pure helpers and renderable row controls for focused tests.

**Tech Stack:** TypeScript, React 19, tRPC, Zod, Drizzle ORM, PostgreSQL advisory locks, Vitest, WebSocket board refresh.

## Global Constraints

- Governing spec: `docs/superpowers/specs/2026-08-02-priority-4-staff-user-management-design.md`.
- Use Node 22.x and pnpm 11.17.0 for final validation.
- No database migration, dependency, permission, navigation, color-token, or recurring-day-off policy change.
- Preserve the one optional Mon–Sat day, Sunday normalization, past-shift immutability, and manual PTO/SICK/TRAINING rows.
- Read-only Admin View-as must never expose editable day-off controls.
- Do not implement status-authority or general management-label work in this plan; those are Plans 4B and 4C.

---

### Task 1: Add the bounded batch contract

**Files:**
- Create: `packages/contracts/src/daysOffSchemas.test.ts`
- Modify: `packages/contracts/src/schemas.ts:123-146`
- Modify: `packages/contracts/src/index.ts:2-35`

**Interfaces:**
- Produces: `bulkSetDaysOffInputSchema` and `BulkSetDaysOffInput` with `{ changes: Array<{ repId: string; daysOfWeek: number[] }> }`.
- Consumes: existing `setDaysOffInputSchema` weekday and UUID rules.

- [ ] **Step 1: Write failing contract tests**

```ts
import { describe, expect, it } from 'vitest'
import { bulkSetDaysOffInputSchema } from './schemas'

const repA = '11111111-1111-4111-8111-111111111111'
const repB = '22222222-2222-4222-8222-222222222222'

describe('bulkSetDaysOffInputSchema', () => {
  it('accepts complete values for multiple unique reps', () => {
    expect(bulkSetDaysOffInputSchema.safeParse({
      changes: [{ repId: repA, daysOfWeek: [3] }, { repId: repB, daysOfWeek: [] }],
    }).success).toBe(true)
  })

  it('rejects duplicate reps, empty/oversized batches, invalid ids, and invalid weekdays', () => {
    expect(bulkSetDaysOffInputSchema.safeParse({ changes: [] }).success).toBe(false)
    expect(bulkSetDaysOffInputSchema.safeParse({ changes: [
      { repId: repA, daysOfWeek: [2] }, { repId: repA, daysOfWeek: [3] },
    ] }).success).toBe(false)
    expect(bulkSetDaysOffInputSchema.safeParse({ changes: [{ repId: 'bad', daysOfWeek: [2] }] }).success).toBe(false)
    expect(bulkSetDaysOffInputSchema.safeParse({ changes: [{ repId: repA, daysOfWeek: [7] }] }).success).toBe(false)
    expect(bulkSetDaysOffInputSchema.safeParse({ changes: Array.from({ length: 201 }, (_, i) => ({
      repId: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, daysOfWeek: [],
    })) }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test and verify the missing export failure**

Run: `pnpm --filter @phoneup/contracts test -- src/daysOffSchemas.test.ts`

Expected: FAIL because `bulkSetDaysOffInputSchema` is not exported.

- [ ] **Step 3: Implement and export the schema and type**

```ts
const dayOffChangeSchema = setDaysOffInputSchema

export const bulkSetDaysOffInputSchema = z.object({
  changes: z.array(dayOffChangeSchema).min(1).max(200),
}).superRefine(({ changes }, ctx) => {
  const seen = new Set<string>()
  changes.forEach((change, index) => {
    if (seen.has(change.repId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['changes', index, 'repId'], message: 'duplicate repId' })
    }
    seen.add(change.repId)
  })
})

export type BulkSetDaysOffInput = z.infer<typeof bulkSetDaysOffInputSchema>
```

Add both names to `packages/contracts/src/index.ts`.

- [ ] **Step 4: Run focused contract tests**

Run: `pnpm --filter @phoneup/contracts test -- src/daysOffSchemas.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the contract**

```bash
git add packages/contracts/src/schemas.ts packages/contracts/src/index.ts packages/contracts/src/daysOffSchemas.test.ts
git commit -m "feat(contracts): add batch days-off input"
```

### Task 2: Make shift materialization reusable inside a locked transaction

**Files:**
- Modify: `apps/api/src/jobs/eligibility.ts:192-267`
- Modify: `apps/api/src/jobs/eligibility.test.ts`

**Interfaces:**
- Produces: `materializeShiftsLocked(tx, opts): Promise<{ inserted: number; updated: number }>`; caller must already hold the rotation advisory lock.
- Preserves: `materializeShifts(db, opts)` as the public transaction-and-lock wrapper.

- [ ] **Step 1: Add a failing rollback-oriented helper test**

Add a test that opens a database transaction, takes `ADVISORY_LOCK_KEY`, changes a seeded rep's recurring day, calls `materializeShiftsLocked`, throws `simulated rollback`, and then asserts both the recurring-day row and generated future shift retain their pre-transaction values.

```ts
await expect(db.transaction(async (tx) => {
  await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)
  await tx.delete(schema.repRecurringDayOff).where(eq(schema.repRecurringDayOff.repId, repId))
  await tx.insert(schema.repRecurringDayOff).values({ repId, dayOfWeek: targetDow })
  await materializeShiftsLocked(tx, { fromDate: today, days: 7, repIds: [repId] })
  throw new Error('simulated rollback')
})).rejects.toThrow('simulated rollback')
```

- [ ] **Step 2: Run the focused test and verify the missing helper failure**

Run: `pnpm --filter @phoneup/api test -- src/jobs/eligibility.test.ts`

Expected: FAIL because `materializeShiftsLocked` is not exported.

- [ ] **Step 3: Extract the existing body without changing its queries**

```ts
export type MaterializeShiftsOptions = { fromDate?: string; days?: number; repIds?: string[] }

export async function materializeShiftsLocked(
  tx: any,
  opts: MaterializeShiftsOptions = {},
): Promise<{ inserted: number; updated: number }> {
  // Move lines 211-265 here unchanged; do not acquire a lock or open a transaction.
}

export async function materializeShifts(db: DB, opts: MaterializeShiftsOptions = {}) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)
    return materializeShiftsLocked(tx, opts)
  })
}
```

- [ ] **Step 4: Run eligibility and materialization tests**

Run: `pnpm --filter @phoneup/api test -- src/jobs/eligibility.test.ts`

Expected: PASS with existing future-only/manual-kind cases unchanged.

- [ ] **Step 5: Commit the extraction**

```bash
git add apps/api/src/jobs/eligibility.ts apps/api/src/jobs/eligibility.test.ts
git commit -m "refactor(api): expose locked shift materializer"
```

### Task 3: Implement the atomic batch days-off domain and router

**Files:**
- Modify: `apps/api/src/domain/daysOff.ts`
- Modify: `apps/api/src/domain/daysOff.test.ts`
- Modify: `apps/api/src/routers/rep.ts`
- Modify: `apps/api/src/routers/rep.test.ts`

**Interfaces:**
- Consumes: `BulkSetDaysOffInput`; `materializeShiftsLocked(tx, opts)`.
- Produces: `bulkSetRecurringDaysOff(db, { changes, actorUserId }) -> { changedRepIds: string[]; daysOffByRep: Record<string, number[]> }` and `rep.bulkSetDaysOff`.
- Preserves: `setRecurringDaysOff` and `rep.setDaysOff`, delegating through the same batch rule.
- Publishes: one `{ type: 'ELIGIBILITY_UPDATED', statusDate }` event after a successful changed batch.

- [ ] **Step 1: Add failing domain cases**

Add fixtures using two existing active reps and assert:

```ts
const result = await bulkSetRecurringDaysOff(db, {
  actorUserId: managerUserId,
  changes: [{ repId: repIds[0], daysOfWeek: [0, 3] }, { repId: repIds[1], daysOfWeek: [] }],
})
expect(result.changedRepIds).toEqual([repIds[0]])
expect(result.daysOffByRep).toEqual({ [repIds[0]]: [3], [repIds[1]]: [] })
```

Also assert two working days reject before writes, an unknown/inactive rep rejects the whole batch, identical rows produce no audit event or realtime event, one audit event is written per changed rep, one realtime event publishes after commit, and a mocked `materializeShiftsLocked` failure rolls back every day-off and audit write without publishing.

- [ ] **Step 2: Run the domain test and verify failure**

Run: `pnpm --filter @phoneup/api test -- src/domain/daysOff.test.ts`

Expected: FAIL because `bulkSetRecurringDaysOff` does not exist.

- [ ] **Step 3: Implement one locked transaction path**

```ts
export type BulkSetDaysOffDomainInput = BulkSetDaysOffInput & { actorUserId: string }

export async function bulkSetRecurringDaysOff(db: DB, input: BulkSetDaysOffDomainInput) {
  const normalized = input.changes.map(({ repId, daysOfWeek }) => ({
    repId,
    daysOff: normalizeRecurringDaysOff(daysOfWeek),
  }))

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)
    // Verify all ids are currently returned by selectActiveReps(tx).
    // Read before values, apply only changed rows, and append per-rep audit events.
    await materializeShiftsLocked(tx, {
      fromDate: businessDate(new Date()),
      repIds: changedRepIds,
    })
    return { changedRepIds, daysOffByRep }
  })
  if (result.changedRepIds.length > 0) {
    publishAssignment({ type: 'ELIGIBILITY_UPDATED', statusDate: businessDate(new Date()) })
  }
  return result
}
```

Extract `normalizeRecurringDaysOff(daysOfWeek)` from the existing single setter. Implement `setRecurringDaysOff` as a one-change wrapper over the batch function and return its existing `{ daysOff }` shape. Import `publishAssignment` from `../realtime/bus`; publication stays after the transaction promise resolves.

- [ ] **Step 4: Add and run router permission/shape tests**

Add `rep.bulkSetDaysOff` with `.use(requirePerm('schedule.manage'))` and `.input(bulkSetDaysOffInputSchema)`. Assert MANAGER succeeds and BDC/REP receive `FORBIDDEN`.

Run: `pnpm --filter @phoneup/api test -- src/domain/daysOff.test.ts src/routers/rep.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the API path**

```bash
git add apps/api/src/domain/daysOff.ts apps/api/src/domain/daysOff.test.ts apps/api/src/routers/rep.ts apps/api/src/routers/rep.test.ts
git commit -m "feat(api): save recurring days off atomically"
```

### Task 4: Add pure Staff List draft mechanics

**Files:**
- Modify: `apps/web/src/pages/StaffList.tsx:100-180`
- Modify: `apps/web/src/pages/StaffList.test.ts`

**Interfaces:**
- Produces: `DayOffMap`, `changedDayOffRows`, `reconcileDayOffDraft`, and `dayOffDisplay`.
- Consumes: `RosterEntry[]` and the `rep.allDaysOff` record.

- [ ] **Step 1: Write failing helper tests**

```ts
expect(dayOffDisplay([])).toBe('None')
expect(dayOffDisplay([3])).toBe('Wed')
expect(dayOffDisplay([4, 5])).toBe('Thu, Fri — needs correction')
expect(changedDayOffRows({ a: [2], b: [] }, { a: [3], b: [] }, ['a', 'b'])).toEqual([
  { repId: 'a', daysOfWeek: [3] },
])
expect(reconcileDayOffDraft({ a: [3], gone: [2] }, { a: [2], added: [] }, ['a', 'added'])).toEqual({
  a: [3], added: [],
})
```

- [ ] **Step 2: Run the Staff List test and verify missing exports**

Run: `pnpm --filter @phoneup/web test -- src/pages/StaffList.test.ts`

Expected: FAIL because the draft helpers do not exist.

- [ ] **Step 3: Implement immutable pure helpers**

```ts
export type DayOffMap = Record<string, number[]>

export function changedDayOffRows(baseline: DayOffMap, draft: DayOffMap, activeIds: string[]) {
  return activeIds.flatMap((repId) => {
    const before = baseline[repId] ?? []
    const after = draft[repId] ?? []
    return before.length === after.length && before.every((day, i) => day === after[i])
      ? [] : [{ repId, daysOfWeek: after }]
  })
}
```

Implement `dayOffDisplay` with `WEEKDAYS`; implement reconciliation by retaining an existing draft only for still-active IDs and initializing new IDs from the latest saved map.

- [ ] **Step 4: Run the helper suite**

Run: `pnpm --filter @phoneup/web test -- src/pages/StaffList.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the draft model**

```bash
git add apps/web/src/pages/StaffList.tsx apps/web/src/pages/StaffList.test.ts
git commit -m "test(web): define days-off editor draft model"
```

### Task 5: Build and verify page-wide Edit Days Off mode

**Files:**
- Modify: `apps/web/src/pages/StaffList.tsx:153-610`
- Modify: `apps/web/src/pages/StaffList.test.ts`
- Modify if required for existing layout utilities: `apps/web/src/styles/ui.css`

**Interfaces:**
- Consumes: `rep.allDaysOff`, `rep.bulkSetDaysOff`, draft helpers from Task 4.
- Produces: compact view cells; page-wide Edit/Save/Cancel; `RecurringDayOffEditor` pure row component.

- [ ] **Step 1: Add failing static-markup cases for row modes**

Export `RecurringDayOffEditor` and render it with `renderToStaticMarkup`. Assert view mode has `Wed` and no `type="radio"`; edit mode contains seven radios, `role="radiogroup"`, and `aria-label="Recurring day off for Taylor Reed"`; an ambiguous view contains `Thu, Fri — needs correction`.

- [ ] **Step 2: Run the focused web test and verify failure**

Run: `pnpm --filter @phoneup/web test -- src/pages/StaffList.test.ts`

Expected: FAIL because `RecurringDayOffEditor` and page-wide mode are not implemented.

- [ ] **Step 3: Replace immediate mutation state with staged editor state**

```ts
const [editingDaysOff, setEditingDaysOff] = useState(false)
const [dayOffDraft, setDayOffDraft] = useState<DayOffMap>({})
const [savingDaysOff, setSavingDaysOff] = useState(false)

async function saveDaysOff() {
  const changes = changedDayOffRows(daysOffByRep, dayOffDraft, roster.map((r) => r.repId))
  if (!canManageSchedule || changes.length === 0 || savingDaysOff) return
  setSavingDaysOff(true)
  try {
    const result = await mutate<{ changedRepIds: string[]; daysOffByRep: DayOffMap }>(
      'rep.bulkSetDaysOff', { changes },
    )
    setDaysOffByRep((current) => ({ ...current, ...result.daysOffByRep }))
    setEditingDaysOff(false)
    setNotice(`Recurring days off saved for ${result.changedRepIds.length} reps.`)
  } catch (err) {
    setError(err instanceof Error ? err.message : 'saving recurring days off failed')
  } finally {
    setSavingDaysOff(false)
  }
}
```

Normal cells render `dayOffDisplay`. Edit mode renders all row radio groups. Add Edit days off, dirty count, Save days off/Saving…, and Cancel. Entering copies the loaded baseline; Cancel discards draft. Keep `board.roster` refresh live and reconcile draft IDs without copying status fields into the draft. Hide the activator in View-as.

- [ ] **Step 4: Run focused and package verification**

Run:

```bash
pnpm --filter @phoneup/web test -- src/pages/StaffList.test.ts
pnpm --filter @phoneup/web typecheck
pnpm --filter @phoneup/web build
```

Expected: all pass.

- [ ] **Step 5: Verify in an authenticated browser**

At 1024x768 and 390x844 verify compact values, truthful legacy copy, Edit activation, dirty count, no mutation before Save, Cancel discard, Save busy state, failure retention, read-only View-as absence, and no navigation/menu regression. Verify two connected clients refresh after Save.

- [ ] **Step 6: Commit the editor**

```bash
git add apps/web/src/pages/StaffList.tsx apps/web/src/pages/StaffList.test.ts apps/web/src/styles/ui.css
git commit -m "feat(staff): add staged days-off edit mode"
```

### Task 6: Run Plan 4A regression gates

**Files:**
- Verify only; do not edit unrelated failures.

- [ ] **Step 1: Run focused cross-package checks**

```bash
pnpm --filter @phoneup/contracts test -- src/daysOffSchemas.test.ts
pnpm --filter @phoneup/api test -- src/domain/daysOff.test.ts src/routers/rep.test.ts src/jobs/eligibility.test.ts
pnpm --filter @phoneup/web test -- src/pages/StaffList.test.ts
```

- [ ] **Step 2: Run static gates**

```bash
pnpm typecheck
pnpm --filter @phoneup/web lint
pnpm build
git diff --check
```

- [ ] **Step 3: Record evidence in the eventual Priority 4 completion update**

Record exact pass counts, Node version, browser viewports, two-client realtime result, and any parent-reproduced unrelated failure. Do not mark Priority 4 complete until Plans 4B and 4C also pass.
