# Recurring Day Off Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Constrain a sales rep to at most one recurring weekly day off, replace the six day-off toggle buttons on the Staff List with a radio group, and collapse the column's per-rep N+1 query into one batch query.

**Architecture:** The limit is enforced in one place — `setRecurringDaysOff`, after input normalization, inside the advisory-lock transaction that path already opens. The client cannot express more than one day (a radio group has one value), so no shared rule module is created. The Staff List's per-rep `rep.daysOff` fetch loop is replaced by a single `rep.allDaysOff` query wrapping `getRecurringDaysOffForReps`, which already exists in the domain and has never been called; `rep.daysOff` and `getUpcomingShifts` are then deleted as unused.

**Tech Stack:** Fastify + tRPC v11 + Zod, Drizzle ORM, PostgreSQL, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-31-recurring-day-off-design.md`

## Global Constraints

- The algorithm reads exactly one table, `rep_daily_status`. Nothing in this plan adds a branch to ranking or eligibility. Days off only ever influence `rep_shift` rows via `materializeShifts`.
- Every path that changes rotation ordering takes `pg_advisory_xact_lock(42_100_1)`. `setRecurringDaysOff` already does; do not add a second lock, a second transaction, or move the new check outside the existing one.
- Sunday (`0`) is store-closed, hardcoded, and is dropped during normalization. It must never consume a rep's day-off entry. The at-most-one check runs **after** that drop, so `[0, 3]` is one day off and is legal.
- Domain modules throw plain `Error`, never `TRPCError`. Follow that.
- `pnpm typecheck` is the only thing that typechecks `apps/api` — it ships via `tsx`, which strips types without checking them. Run it before every commit.
- The api suite reads `TEST_DATABASE_URL` (default `postgresql://localhost/phoneup_test`), never `DATABASE_URL`. It writes destructively.
- No migration. `rep_recurring_day_off` stays row-per-day; the constraint is application-level.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/api/src/domain/daysOff.ts` | Modify — add the at-most-one check to `setRecurringDaysOff`; later delete `getUpcomingShifts` | 1, 4 |
| `apps/api/src/domain/daysOff.test.ts` | Create — unit coverage for the rule, normalization, audit event and forward-only re-materialization | 1 |
| `apps/api/src/jobs/eligibility.test.ts` | Modify — two existing cases pass multi-day input that the new rule rejects | 1 |
| `apps/api/src/routers/rep.ts` | Modify — add `allDaysOff`; later delete `daysOff` | 2, 4 |
| `apps/api/src/routers/rep.test.ts` | Create — permission gate and shape of `allDaysOff` | 2 |
| `apps/web/src/pages/StaffList.tsx` | Modify — radio group replaces toggles, batch fetch replaces the per-rep loop | 3 |
| `apps/web/src/pages/StaffList.test.ts` | Modify — cover the new pure helpers | 3 |

Task order is chosen so every task leaves the whole suite green on its own. Task 2 is purely additive; Task 4 deletes `rep.daysOff` only after Task 3 has removed its last caller.

---

### Task 1: Enforce at most one recurring day off

**Files:**
- Modify: `apps/api/src/domain/daysOff.ts:22-56`
- Create: `apps/api/src/domain/daysOff.test.ts`
- Modify: `apps/api/src/jobs/eligibility.test.ts:387-402`, `apps/api/src/jobs/eligibility.test.ts:404-419`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `setRecurringDaysOff(db, { repId, daysOfWeek, actorUserId })` keeps its existing signature and `Promise<{ daysOff: number[] }>` return. It now rejects when more than one working day is requested.

**Background the implementer needs:**

`setRecurringDaysOff` today normalizes input on line 24 — `filter(d => d >= 1 && d <= 6)`, dedupe via `Set`, `sort()` — then opens a transaction, takes advisory lock `42_100_1`, reads the previous rows for the audit `before`, deletes all of the rep's rows, inserts the new ones, appends a `rep.days_off.set` audit event, and after the transaction commits calls `materializeShifts` forward from today. Do not restructure any of that. The only change is a guard.

The guard goes after normalization and before the transaction opens. Before, not inside, because there is nothing to roll back and holding the ordering lock to reject an argument is waste — a BDC agent assigning a lead waits on that lock.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/domain/daysOff.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { setRecurringDaysOff, getRecurringDaysOff } from './daysOff'

// Reuses reps the seed already created rather than inserting its own, matching
// bulkOverrideStatus.test.ts. Tests that insert sales_rep rows without deleting them
// accumulate across runs and have already caused a flake in this suite.
let repId: string
let managerUserId: string

beforeAll(async () => {
  const reps = await db.select().from(schema.salesRep)
  if (reps.length === 0) throw new Error('test database has no sales_rep rows — run the seed')
  repId = reps[0].id

  const [manager] = await db
    .insert(schema.appUser)
    .values({
      email: `days-off-test-manager-${Date.now()}@dealership.test`,
      passwordHash: 'x:y',
      role: 'MANAGER',
    })
    .returning()
  managerUserId = manager.id
})

beforeEach(async () => {
  await db.delete(schema.repRecurringDayOff).where(eq(schema.repRecurringDayOff.repId, repId))
})

describe('setRecurringDaysOff — at most one day', () => {
  it('accepts a single working day', async () => {
    const result = await setRecurringDaysOff(db, { repId, daysOfWeek: [3], actorUserId: managerUserId })
    expect(result.daysOff).toEqual([3])
    expect(await getRecurringDaysOff(db, repId)).toEqual([3])
  })

  it('accepts none', async () => {
    await setRecurringDaysOff(db, { repId, daysOfWeek: [3], actorUserId: managerUserId })
    const result = await setRecurringDaysOff(db, { repId, daysOfWeek: [], actorUserId: managerUserId })
    expect(result.daysOff).toEqual([])
    expect(await getRecurringDaysOff(db, repId)).toEqual([])
  })

  it('accepts Sunday plus one working day — Sunday is dropped, so that is one day off', async () => {
    // The store is closed Sunday. It needs no rep-level entry and must not consume one,
    // so [0, 3] is a rep off on Wednesday, not a rep off twice.
    const result = await setRecurringDaysOff(db, { repId, daysOfWeek: [0, 3], actorUserId: managerUserId })
    expect(result.daysOff).toEqual([3])
  })

  it('rejects two working days', async () => {
    await expect(
      setRecurringDaysOff(db, { repId, daysOfWeek: [4, 5], actorUserId: managerUserId }),
    ).rejects.toThrow(/at most one recurring day off/)
  })

  it('rejects every day of the week', async () => {
    await expect(
      setRecurringDaysOff(db, { repId, daysOfWeek: [1, 2, 3, 4, 5, 6], actorUserId: managerUserId }),
    ).rejects.toThrow(/at most one recurring day off/)
  })

  it('writes nothing at all when it rejects', async () => {
    await setRecurringDaysOff(db, { repId, daysOfWeek: [2], actorUserId: managerUserId })
    const auditBefore = await db.query.auditEvents.findMany({
      where: eq(schema.auditEvents.entityId, repId),
    })

    await expect(
      setRecurringDaysOff(db, { repId, daysOfWeek: [4, 5], actorUserId: managerUserId }),
    ).rejects.toThrow()

    // The prior day off survives untouched — a rejected call must not have deleted it.
    expect(await getRecurringDaysOff(db, repId)).toEqual([2])
    const auditAfter = await db.query.auditEvents.findMany({
      where: eq(schema.auditEvents.entityId, repId),
    })
    expect(auditAfter.length).toBe(auditBefore.length)
  })

  it('treats a duplicated day as one day', async () => {
    const result = await setRecurringDaysOff(db, { repId, daysOfWeek: [3, 3], actorUserId: managerUserId })
    expect(result.daysOff).toEqual([3])
  })
})
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm --filter @phoneup/api test -- daysOff.test.ts`

Expected: the four acceptance cases pass (existing behaviour), and `rejects two working days`, `rejects every day of the week` and `writes nothing at all when it rejects` FAIL — the calls resolve instead of throwing.

- [ ] **Step 3: Add the guard**

In `apps/api/src/domain/daysOff.ts`, immediately after the `const requested = ...` line and before `await db.transaction(...)`:

```ts
  // At most one recurring day off, checked after Sunday is dropped so [0, 3] — Sunday
  // plus Wednesday — reads as the one working day off it is. A plain Error, like every
  // other domain guard in this codebase; the router maps it and the client renders the
  // message. Checked before the transaction opens: there is nothing to roll back, and
  // holding the ordering lock to reject an argument makes a BDC agent wait to assign.
  if (requested.length > 1) {
    throw new Error(
      `a rep can have at most one recurring day off, got ${requested.length}: ${requested.join(', ')}`,
    )
  }
```

Update the doc comment above `setRecurringDaysOff` so it states the limit:

```ts
/**
 * Set a rep's recurring weekly day off — at most one, or none — and re-materialize their
 * FUTURE shift rows only; a past date is eligibility evidence and is never rewritten.
 * Manually-set PTO/SICK/TRAINING rows survive, because materializeShifts only touches
 * rows it generated itself. Multi-day absence belongs in those shift kinds, not here.
 */
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm --filter @phoneup/api test -- daysOff.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Run the whole api suite to find the multi-day callers**

Run: `pnpm --filter @phoneup/api test`

Expected: FAIL — two cases in `eligibility.test.ts` pass multi-day input that is now rejected. Confirm the two failures are exactly `re-materializing after a days-off change never rewrites a PAST date` and `audit-logs rep.days_off.set with before/after`. If any other test fails, stop and read it before changing anything.

- [ ] **Step 6: Fix the past-date test**

`apps/api/src/jobs/eligibility.test.ts:387`. It currently sets every weekday off so that a generator reaching backwards would flip the seeded past row from `WORK` to `OFF`. One day is enough if it is the past date's own weekday. Replace the body from the `// set every weekday off` comment through the `setRecurringDaysOff` call with:

```ts
    // Set the day off to the past date's OWN weekday — if the generator reached backwards,
    // that row specifically would flip to OFF. One day is all the rule now allows, and it
    // is the only day that could produce a false pass here anyway.
    const pastDow = new Date(`${pastDate}T12:00:00Z`).getUTCDay()
    await setRecurringDaysOff(db, { repId, daysOfWeek: [pastDow], actorUserId: managerUserId })
```

Note: `pastDow` can be `0` when the past date is a Sunday, which normalizes to no day off at all and would make the test vacuous. Guard it by picking a non-Sunday past date — change the `pastDate` line above from `shiftDate(today, -3)` to:

```ts
    // -3 lands on a Sunday one day in seven; Sunday normalizes away and would leave this
    // test asserting nothing. Step back until it is a working day.
    let pastDate = shiftDate(today, -3)
    while (new Date(`${pastDate}T12:00:00Z`).getUTCDay() === 0) pastDate = shiftDate(pastDate, -1)
```

(`pastDate` was `const`; it becomes `let`.)

- [ ] **Step 7: Fix the audit test**

`apps/api/src/jobs/eligibility.test.ts:404`. Change the second call and its expectation:

```ts
    await setRecurringDaysOff(db, { repId, daysOfWeek: [2], actorUserId: managerUserId })
    await setRecurringDaysOff(db, { repId, daysOfWeek: [4], actorUserId: managerUserId })
```

and further down:

```ts
    expect((latest.before as any).daysOfWeek).toEqual([2])
    expect((latest.after as any).daysOfWeek).toEqual([4])
```

- [ ] **Step 8: Run the whole api suite and typecheck**

Run: `pnpm --filter @phoneup/api test`
Expected: zero failures. Test count goes from 136 to 143 — the seven new cases in `daysOff.test.ts`; the two edited cases are rewritten in place, not added.

Run: `pnpm typecheck`
Expected: all five projects Done, no output after them.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/domain/daysOff.ts apps/api/src/domain/daysOff.test.ts apps/api/src/jobs/eligibility.test.ts
git commit -m "feat(api): limit a rep to one recurring day off

Checked after Sunday is dropped, so [0, 3] stays legal — that is a rep off
Wednesday, not a rep off twice. Checked before the transaction opens: there
is nothing to roll back, and holding the ordering lock to reject an argument
makes a BDC agent wait to assign a lead.

Two eligibility cases passed multi-day input to make their point and are
rewritten to single-day. The past-date case now sets the day off to the past
date's own weekday, which detects a backwards reach just as precisely, and
steps the date back off Sunday so normalization cannot make it vacuous.

Multi-day absence belongs in the PTO/SICK/TRAINING shift kinds, which the
materializer already refuses to overwrite."
```

---

### Task 2: Add `rep.allDaysOff`

**Files:**
- Modify: `apps/api/src/routers/rep.ts:8` (import), `apps/api/src/routers/rep.ts:30-38` (add the procedure next to `daysOff`)
- Create: `apps/api/src/routers/rep.test.ts`

**Interfaces:**
- Consumes: `getRecurringDaysOffForReps(db, repIds) => Promise<Map<string, number[]>>` from `apps/api/src/domain/daysOff.ts:66` — already written, never called.
- Produces: tRPC query `rep.allDaysOff`, no input, permission `schedule.manage`, returning `Record<string, number[]>` — repId to that rep's sorted days off. **Every rep in `sales_rep` is present**, with `[]` when they have no recurring day off. Task 3 depends on that guarantee.

**Background the implementer needs:**

`getRecurringDaysOffForReps` returns a `Map` and only contains reps that have at least one row. The procedure must widen that to every rep and convert to a plain object, because JSON has no `Map` and the client must not have to distinguish "no day off" from "not loaded."

This task is purely additive. `rep.daysOff` stays for now; Task 4 removes it once the web client no longer calls it.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routers/rep.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { t } from '../trpc/router'
import { repRouter } from './rep'
import type { Context } from '../trpc/context'
import type { Role } from '@phoneup/contracts'
import { setRecurringDaysOff } from '../domain/daysOff'

const fakeReqRes = { req: {} as Context['req'], res: {} as Context['res'] }

function fakeSession(userId: string, role: Role): NonNullable<Context['session']> {
  return { userId, role, mustChangePassword: false, sessionId: `test-session-${userId}` }
}

function caller(role: Role) {
  return t.createCallerFactory(repRouter)({ session: fakeSession('rep-router-test', role), ...fakeReqRes })
}

let repWithDayOff: string
let repWithout: string
let managerUserId: string

beforeAll(async () => {
  const reps = await db.select().from(schema.salesRep)
  if (reps.length < 2) throw new Error('test database needs at least two sales_rep rows — run the seed')
  repWithDayOff = reps[0].id
  repWithout = reps[1].id

  const [manager] = await db
    .insert(schema.appUser)
    .values({
      email: `rep-router-test-manager-${Date.now()}@dealership.test`,
      passwordHash: 'x:y',
      role: 'MANAGER',
    })
    .returning()
  managerUserId = manager.id

  await db.delete(schema.repRecurringDayOff).where(eq(schema.repRecurringDayOff.repId, repWithout))
  await setRecurringDaysOff(db, { repId: repWithDayOff, daysOfWeek: [3], actorUserId: managerUserId })
})

describe('rep.allDaysOff', () => {
  it('rejects a BDC agent — this is schedule.manage', async () => {
    await expect(caller('BDC').allDaysOff()).rejects.toThrow(/FORBIDDEN/)
  })

  it('rejects a REP', async () => {
    await expect(caller('REP').allDaysOff()).rejects.toThrow(/FORBIDDEN/)
  })

  it('returns a rep with a day off', async () => {
    const result = await caller('MANAGER').allDaysOff()
    expect(result[repWithDayOff]).toEqual([3])
  })

  it('includes a rep with no day off as an empty array, not as a missing key', async () => {
    // The client must not have to tell "no day off" apart from "not loaded".
    const result = await caller('MANAGER').allDaysOff()
    expect(result[repWithout]).toEqual([])
  })

  it('covers every rep on the roster', async () => {
    const result = await caller('MANAGER').allDaysOff()
    const reps = await db.select().from(schema.salesRep)
    expect(Object.keys(result).sort()).toEqual(reps.map((r: any) => r.id).sort())
  })
})
```

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm --filter @phoneup/api test -- rep.test.ts`
Expected: FAIL — `caller(...).allDaysOff is not a function`.

- [ ] **Step 3: Implement the procedure**

In `apps/api/src/routers/rep.ts`, extend the import on line 8:

```ts
import {
  getRecurringDaysOff,
  getRecurringDaysOffForReps,
  getUpcomingShifts,
  setRecurringDaysOff,
} from '../domain/daysOff'
```

and add the procedure directly after `daysOff`:

```ts
  /**
   * The whole days-off column in one query. The Staff List used to issue one `daysOff`
   * call per rep on every board realtime event — every assign, void and status change —
   * which on a 30-rep roster is 30 requests per event.
   *
   * Every rep is present, with `[]` when they have none: the client must never have to
   * tell "no day off" apart from "not loaded yet".
   */
  allDaysOff: publicProcedure.use(requirePerm('schedule.manage')).query(async () => {
    const reps = await db.select({ id: schema.salesRep.id }).from(schema.salesRep)
    const byRep = await getRecurringDaysOffForReps(
      db,
      reps.map((r) => r.id),
    )
    return Object.fromEntries(reps.map((r) => [r.id, byRep.get(r.id) ?? []])) as Record<string, number[]>
  }),
```

This needs `schema` in scope. Change the `@phoneup/db` import at the top of the file from `import { db } from '@phoneup/db'` to:

```ts
import { db, schema } from '@phoneup/db'
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm --filter @phoneup/api test -- rep.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Run the full api suite and typecheck**

Run: `pnpm --filter @phoneup/api test`
Expected: zero failures.

Run: `pnpm typecheck`
Expected: five projects Done.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routers/rep.ts apps/api/src/routers/rep.test.ts
git commit -m "feat(api): expose rep.allDaysOff, the whole column in one query

The Staff List issues one rep.daysOff call per rep on every board realtime
event — every assign, void and status change — which is ~30 requests per
event on this roster, each also carrying an upcoming-shifts list nothing
reads. getRecurringDaysOffForReps has been sitting in the domain unused
since it was written; this wires it up.

Every rep is present in the result with [] when they have no recurring day
off, so the client never has to tell 'none' apart from 'not loaded'."
```

---

### Task 3: Radio group and batch fetch on the Staff List

**Files:**
- Modify: `apps/web/src/pages/StaffList.tsx` — lines 66-75 (`WEEKDAYS`), 112 (state), 128-149 (`refresh`), 239-252 (`toggleDayOff`), 355-375 (the cell)
- Modify: `apps/web/src/pages/StaffList.test.ts`

**Interfaces:**
- Consumes: `rep.allDaysOff` from Task 2 — `Record<string, number[]>`, every rep present.
- Produces: two exported pure helpers on `StaffList.tsx`, so the web suite can test them without a DOM:
  - `selectedDayOff(days: number[]): number | null | 'AMBIGUOUS'` — `null` for none, the day for exactly one, `'AMBIGUOUS'` for more than one.
  - `dayOffPayload(dow: number | null): number[]` — `[]` for `null`, `[dow]` otherwise.

**Background the implementer needs:**

The days-off cell currently renders six `Button`s with `aria-pressed`, each calling `toggleDayOff(repId, dow)`, which computes the new set and fires `rep.setDaysOff` optimistically with rollback into a top-level `error` banner (rendered at line 322). That optimistic-with-rollback shape is correct and stays. Only the input widget and the payload arithmetic change.

`refresh()` currently maps the roster to one `query('rep.daysOff?input=...')` per rep inside `Promise.all`, swallowing per-rep failures with `catch { return [repId, []] }`. That whole block collapses to one call.

`WEEKDAYS` stays exactly as it is — Mon(1) through Sat(6), no Sunday. The radio group adds a "None" option that is not a weekday and so is not part of that array.

A rep can hold more than one stored day from before this change or from a direct database write. That renders with no radio selected plus a note naming the days, so the manager's next click is an explicit choice rather than a silent collapse to whichever day sorted first.

**The web suite has no DOM.** `apps/web/vitest.config.ts` sets `environment: 'node'`, and every existing case in `StaffList.test.ts` tests an exported pure function, never a rendered component. So the optimistic rollback on a failed mutation is **not** unit-testable here and no test is written for it — Step 10's browser check is what covers it. Do not add jsdom to this package to chase that one assertion; that is a larger decision than this task.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/pages/StaffList.test.ts`:

```ts
describe('selectedDayOff', () => {
  it('is null when a rep has no recurring day off', () => {
    expect(selectedDayOff([])).toBe(null)
  })

  it('is the day when a rep has exactly one', () => {
    expect(selectedDayOff([3])).toBe(3)
  })

  it('is AMBIGUOUS when a rep somehow has more than one', () => {
    // Legacy rows, or a direct database write. Rendering one of them would show a
    // schedule the database does not hold and let a stray click discard the other.
    expect(selectedDayOff([4, 5])).toBe('AMBIGUOUS')
  })
})

describe('dayOffPayload', () => {
  it('sends an empty array for None', () => {
    expect(dayOffPayload(null)).toEqual([])
  })

  it('sends a one-element array for a weekday', () => {
    expect(dayOffPayload(3)).toEqual([3])
  })
})
```

and extend the import on line 2:

```ts
import {
  reconcileSelection,
  splitByNoOp,
  currentStatusOf,
  reasonNoteFor,
  selectedDayOff,
  dayOffPayload,
} from './StaffList'
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm --filter @phoneup/web test`
Expected: FAIL — `selectedDayOff is not a function`.

- [ ] **Step 3: Add the two helpers**

In `apps/web/src/pages/StaffList.tsx`, directly below the `WEEKDAYS` constant:

```ts
/**
 * Which radio is selected for a rep. A rep gets one recurring day off or none, so more
 * than one stored day is data this UI cannot represent — surface it rather than picking
 * whichever sorted first, which would show a schedule the database does not hold and let
 * a stray click silently discard the other day.
 */
export function selectedDayOff(days: number[]): number | null | 'AMBIGUOUS' {
  if (days.length === 0) return null
  if (days.length === 1) return days[0]
  return 'AMBIGUOUS'
}

/** The `daysOfWeek` a radio selection sends. `null` is the None option. */
export function dayOffPayload(dow: number | null): number[] {
  return dow === null ? [] : [dow]
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm --filter @phoneup/web test`
Expected: 33 passed.

- [ ] **Step 5: Replace the per-rep fetch with the batch query**

In `refresh()`, replace the `if (!canManageSchedule) return` block and everything after it (lines 133-146) with:

```ts
        if (!canManageSchedule) return
        // One query for the whole column. This runs on every board realtime event, so the
        // per-rep loop it replaces was ~30 requests per assign, void and status change.
        setDaysOffByRep(await query<Record<string, number[]>>('rep.allDaysOff'))
```

- [ ] **Step 6: Replace `toggleDayOff` with `setDayOff`**

Replace lines 239-252 entirely:

```ts
  /** One mutation per selection, audit-logged as rep.days_off.set with before/after. */
  async function setDayOff(repId: string, dow: number | null) {
    const current = daysOffByRep[repId] ?? []
    const next = dayOffPayload(dow)
    setDaysOffByRep((prev) => ({ ...prev, [repId]: next })) // optimistic
    setError(null)
    setNotice(null)
    try {
      await mutate('rep.setDaysOff', { repId, daysOfWeek: next })
    } catch (err) {
      setDaysOffByRep((prev) => ({ ...prev, [repId]: current })) // roll back
      setError(err instanceof Error ? err.message : 'saving the day off failed')
    }
  }
```

- [ ] **Step 7: Replace the cell**

Replace the `canManageSchedule && (<td>...)` block at lines 355-375:

```tsx
            {canManageSchedule && (
              <td>
                {(() => {
                  const stored = daysOffByRep[r.repId] ?? []
                  const current = selectedDayOff(stored)
                  const ambiguous = current === 'AMBIGUOUS'
                  return (
                    <>
                      <div className="ui-row">
                        <label className="ui-radio">
                          <input
                            type="radio"
                            name={`day-off-${r.repId}`}
                            checked={current === null}
                            onChange={() => setDayOff(r.repId, null)}
                          />
                          None
                        </label>
                        {WEEKDAYS.map(({ dow, label }) => (
                          <label key={dow} className="ui-radio">
                            <input
                              type="radio"
                              name={`day-off-${r.repId}`}
                              checked={current === dow}
                              onChange={() => setDayOff(r.repId, dow)}
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                      {ambiguous && (
                        <p className="ui-hint">
                          {stored
                            .map((d) => WEEKDAYS.find((w) => w.dow === d)?.label ?? String(d))
                            .join(', ')}{' '}
                          stored — pick one
                        </p>
                      )}
                    </>
                  )
                })()}
              </td>
            )}
```

- [ ] **Step 8: Add the radio label style**

In `apps/web/src/styles/ui.css`, append:

```css
/* Day-off radios sit inline in a table cell; the gap keeps the dot off its label. */
.ui-radio {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  white-space: nowrap;
}
```

- [ ] **Step 9: Verify the whole web package**

Run: `pnpm --filter @phoneup/web test`
Expected: 33 passed.

Run: `pnpm typecheck`
Expected: five projects Done. In particular `apps/web` must be clean — the removed `toggleDayOff` has no remaining callers and `Button` is still used elsewhere in the file, so no import should go unused.

Run: `pnpm --filter @phoneup/web build`
Expected: clean, no new warnings.

- [ ] **Step 10: Check it in a browser**

Start the dev servers (`pnpm dev`), sign in as a manager, open the Staff List.

Confirm: each rep's row shows None + Mon–Sat radios; selecting one saves without a Save button and survives a reload; selecting None clears it; the radios in one row do not affect another row; and a rep given two days directly in the database (`insert into rep_recurring_day_off (rep_id, day_of_week) values (…, 4), (…, 5)`) renders with nothing selected and the "Thu, Fri stored — pick one" note. Delete those two fixture rows afterwards.

Also confirm the rollback, since no test covers it: stop the API server, click a radio, and check the selection snaps back and the error banner appears above the table. Restart the server afterwards.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/pages/StaffList.tsx apps/web/src/pages/StaffList.test.ts apps/web/src/styles/ui.css
git commit -m "feat(web): one recurring day off, as a radio group

Six toggle buttons become None + Mon-Sat radios. A radio click is a complete
intent, so the existing optimistic-save-and-roll-back path stays correct and
the queue item's Save button is not needed: it existed to make multi-select
safe, and there is no longer multi-select. 'Every day off' becomes
unreachable rather than guarded.

A rep holding more than one stored day — legacy rows, or a direct database
write — renders with nothing selected and the days named, so the next click
is the manager's explicit choice rather than a silent collapse to whichever
day sorted first.

refresh() now makes one rep.allDaysOff call instead of one rep.daysOff per
rep on every board realtime event."
```

---

### Task 4: Delete `rep.daysOff` and `getUpcomingShifts`

**Files:**
- Modify: `apps/api/src/routers/rep.ts` — remove the `daysOff` procedure and the now-unused imports
- Modify: `apps/api/src/domain/daysOff.ts:81-96` — remove `getUpcomingShifts`

**Interfaces:**
- Consumes: Task 3 removed the last caller of `rep.daysOff`.
- Produces: nothing. This is deletion only.

**Background the implementer needs:**

`rep.daysOff` returned `{ daysOfWeek, upcoming }`. `upcoming` came from `getUpcomingShifts`, which no caller ever read — it was fetched once per rep per refresh and discarded. With Task 3 done, the procedure itself has no caller either.

`getRecurringDaysOff` (single-rep) is **kept**. It is the natural read for a future rep-detail view, `daysOff.test.ts` asserts through it, and it costs nothing.

- [ ] **Step 1: Confirm there are no remaining callers**

Run:

```bash
grep -rn "rep\.daysOff\|getUpcomingShifts" apps packages --include=*.ts --include=*.tsx
```

Expected: only the definitions in `apps/api/src/routers/rep.ts` and `apps/api/src/domain/daysOff.ts`. If anything else appears, stop — Task 3 is incomplete.

- [ ] **Step 2: Delete the procedure**

In `apps/api/src/routers/rep.ts`, remove the whole `daysOff: publicProcedure...` block (its doc comment through the closing `}),`), and remove `getUpcomingShifts` and `repIdInputSchema` if nothing else uses them. Check `repIdInputSchema` with:

```bash
grep -n "repIdInputSchema" apps/api/src/routers/rep.ts
```

If `daysOff` was its only user, delete the `const repIdInputSchema = ...` line too. If that leaves `z` unused, delete the `zod` import as well — `materializeShifts` still takes a `z.object`, so it most likely stays.

- [ ] **Step 3: Delete the domain function**

In `apps/api/src/domain/daysOff.ts`, remove `getUpcomingShifts` and its doc comment (lines 81-96). Then clean the now-unused imports on line 1 — `and` and `gte` were used only by that function. Verify:

```bash
grep -n "and(\|gte(" apps/api/src/domain/daysOff.ts
```

If there are no hits, drop `and` and `gte` from the `drizzle-orm` import.

- [ ] **Step 4: Verify**

Run: `pnpm typecheck`
Expected: five projects Done. A missed import shows up here — `apps/api` is typechecked nowhere else.

Run: `pnpm test`
Expected: zero failures across all packages.

Run: `pnpm --filter @phoneup/web build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routers/rep.ts apps/api/src/domain/daysOff.ts
git commit -m "refactor(api): drop rep.daysOff and getUpcomingShifts

rep.allDaysOff took over the Staff List's only use of rep.daysOff. Its
'upcoming' field came from getUpcomingShifts, which no caller has ever read
— it was fetched once per rep per refresh and thrown away.

getRecurringDaysOff (single-rep) stays: it is the natural read for a future
rep-detail view and costs nothing."
```

---

## Final Verification

- [ ] `pnpm typecheck` — five projects Done
- [ ] `pnpm test` — zero failures
- [ ] `pnpm --filter @phoneup/web build` — clean
- [ ] `grep -rn "rep\.daysOff\|getUpcomingShifts" apps packages --include=*.ts --include=*.tsx` — no hits
- [ ] Staff List in a browser: radios save, None clears, rows are independent, a two-day rep shows the "pick one" note
- [ ] `docs/superpowers/specs/7-31-queue.md` — mark item 3 done, note that the Save button and all-week gate were not built and why

## Notes for the reviewer

Things this plan deliberately does not do, so they are not read as omissions:

- No `packages/core` rule module. The client cannot express two days, so there is no second evaluator to keep in sync, and a core module with one consumer is worse than none.
- No `expectedDaysOfWeek` optimistic concurrency and no conflict warning. Both were designed for a multi-toggle draft that no longer exists; a single radio click is atomic.
- No migration and no data backfill. `rep_recurring_day_off` stays row-per-day, so the limit is application-level and reversible. Existing multi-day reps are surfaced to a manager rather than collapsed by a script — there is no correct automatic answer to which day to keep.
- No policy config for the limit. It is one, hardcoded, the same way Sunday-closed is hardcoded.
