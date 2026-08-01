# Assignment Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dedicated Assign page with a header-opened assignment drawer that combines the existing assignment workflow and live roster, improves the result hierarchy, adds fast Skip presets, and presents skipped reps predictably without changing rotation ranking.

**Architecture:** Add presentation-only cycle metadata to `board.roster`, then move assignment UI into focused feature components backed by pure model helpers. Mount one accessible drawer from the app shell, keep the existing assignment/Skip/Void mutations intact, and remove all clipboard behavior from this workspace while leaving Rep Dashboard copying unchanged.

**Tech Stack:** React 19, TypeScript 6, Vite 8, Zustand, tRPC-style fetch helpers, Fastify API, Drizzle ORM, PostgreSQL, Vitest, oxlint, Playwright CLI.

## Global Constraints

- Preserve `rankReps`, assignment selection, cycle boundaries, monthly-counter accounting, advisory-lock timing, and the append-only ledger.
- Preserve guarded repeatable Skip: expected-rep validation, idempotency, BDC ownership, Manager/Admin override, audit logging, and same-lead passing.
- Do not add a database migration or frontend dependency.
- Team Dashboard is the non-Rep landing screen; Rep accounts land on My Dashboard.
- Assignment mutations remain blocked during Admin View-as; do not expose an actionable drawer in View-as.
- Closing an idle drawer discards local state without warning; closing is disabled during Assign, Skip, or Void.
- Skip presets are `Rep unavailable`, `Rep already assisting a customer`, `Customer requested another rep`, `Manager-directed pass`, and `Other`.
- Skip reasons remain Audit Log-only and must not appear in `board.roster`.
- `Served This Round` remains one bucket: skipped reps first with a compact yellow `Skipped` badge and neutral rows, followed by normally served reps; each subgroup is chronological.
- Remove assignment auto-copy, Copy phone, copied-phone notices, and assignment `Alt+C`; preserve phone-copy controls in Rep Dashboard/Rep Detail.
- Preserve the user's existing uncommitted edit in `docs/Revised consolidated action list.md` until the final documentation task deliberately reconciles it.
- Run with the repository-declared Node 22.x when available. If only Node 26.5.0 is available, record the engine mismatch with the results.

---

## Planned file structure

### API

- Modify `apps/api/src/routers/board.ts` — enrich the ranked response with presentation-only active-cycle metadata.
- Modify `apps/api/src/routers/board.test.ts` — exercise the real `board.roster` procedure and prove no Skip-reason leakage.

### Shared web UI

- Create `apps/web/src/ui/Drawer.tsx` — accessible focus-trapped drawer shell with busy-state close protection.
- Create `apps/web/src/ui/Drawer.test.tsx` — static semantic coverage plus pure close-guard coverage.
- Modify `apps/web/src/styles/ui.css` — drawer, assignment workspace, responsive, result hierarchy, and compact badge styles.

### Assignment feature

- Create `apps/web/src/pages/assignment/model.ts` — roster/result types and pure validation, bucketing, ordering, phone-format, and Skip-reason helpers.
- Create `apps/web/src/pages/assignment/model.test.ts` — focused pure-behavior tests.
- Create `apps/web/src/pages/assignment/RosterPanel.tsx` — four-bucket roster presentation.
- Create `apps/web/src/pages/assignment/RosterPanel.test.tsx` — semantic markup/order coverage.
- Create `apps/web/src/pages/assignment/SkipDialog.tsx` — preset selection, required Other detail, and deliberate confirmation.
- Create `apps/web/src/pages/assignment/SkipDialog.test.tsx` — preset/Other/static semantic coverage.
- Create `apps/web/src/pages/assignment/AssignmentDrawer.tsx` — assignment lifecycle, form/result transitions, mutations, realtime refresh, and Void integration.
- Create `apps/web/src/pages/assignment/AssignmentDrawer.test.tsx` — pure exported guards and server-rendered result/clipboard absence coverage.
- Delete `apps/web/src/pages/AssignScreen.tsx` after the app shell switches to the drawer.
- Delete `apps/web/src/pages/AssignScreen.test.ts` after its still-relevant cases move to the new focused test files.

### App shell and documentation

- Modify `apps/web/src/App.tsx` — landing-page rules, header action, inert app shell, drawer mounting, and dedicated Assign-route removal.
- Modify `apps/web/src/App.test.ts` — landing, fallback, View-as, and drawer-action guards.
- Modify `docs/Revised consolidated action list.md` — reconcile the user's note and record only implemented/verified follow-up work.

---

### Task 1: Add active-cycle roster presentation metadata

**Files:**
- Modify: `apps/api/src/routers/board.ts`
- Modify: `apps/api/src/routers/board.test.ts`

**Interfaces:**
- Consumes: existing `rotationCycle`, `rrCycleAssignments`, and `assignmentEvents` rows.
- Produces: every `board.roster` row includes `servedAt: string | null` and `skippedThisCycle: boolean` after ranking is complete.
- Preserves: `rankReps(rankInputs)` input and output order.

- [ ] **Step 1: Write the failing real-router test**

Extend the board fixture with one active-cycle slot and a SKIP ledger event for `repWithSystemStatus`:

```ts
let fixtureCycleId: string
let fixtureSkipKey: string
const servedAt = new Date('2026-08-01T13:15:00.000Z')

const openCycle = await db.query.rotationCycle.findFirst({
  where: isNull(schema.rotationCycle.closedAt),
})
fixtureCycleId = openCycle?.id ?? (await db.insert(schema.rotationCycle).values({}).returning())[0].id
fixtureSkipKey = `board-test-skip-${stamp}`

await db.insert(schema.rrCycleAssignments).values({
  cycleId: fixtureCycleId,
  repId: repWithSystemStatus,
  assignedAt: servedAt,
})
await db.insert(schema.assignmentEvents).values({
  leadId: null,
  repId: repWithSystemStatus,
  eventType: 'SKIP',
  cycleNo: fixtureCycleId,
  creditDelta: -1,
  queueSnapshot: [],
  idempotencyKey: fixtureSkipKey,
})
```

Add an assertion through `caller().roster()`:

```ts
it('adds active-cycle service metadata without leaking the skip reason', async () => {
  const roster = await caller().roster()
  const entry = roster.find((row) => row.repId === repWithSystemStatus)

  expect(entry).toMatchObject({
    servedAt: servedAt.toISOString(),
    skippedThisCycle: true,
  })
  expect(entry).not.toHaveProperty('skipReason')
  expect(entry).not.toHaveProperty('reasonNote')
})
```

In `afterAll`, delete the fixture event and slot before deleting the rep rows:

```ts
await tx.delete(schema.assignmentEvents).where(eq(schema.assignmentEvents.idempotencyKey, fixtureSkipKey))
await tx.delete(schema.rrCycleAssignments).where(and(
  eq(schema.rrCycleAssignments.cycleId, fixtureCycleId),
  eq(schema.rrCycleAssignments.repId, repWithSystemStatus),
))
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @phoneup/api exec vitest run src/routers/board.test.ts --no-file-parallelism
```

Expected: the new test fails because `servedAt` and `skippedThisCycle` are absent.

- [ ] **Step 3: Add presentation maps without touching ranking**

In `computeRoster`, build maps from the already-selected active cycle:

```ts
const servedAtByRep = new Map(servedThisCycle.map((row: any) => [row.repId, row.assignedAt]))
const skipEvents = cycle
  ? await db.query.assignmentEvents.findMany({
      where: and(
        eq(schema.assignmentEvents.cycleNo, cycle.id),
        eq(schema.assignmentEvents.eventType, 'SKIP'),
      ),
    })
  : []
const skippedRepIds = new Set(skipEvents.flatMap((event: any) => event.repId ? [event.repId] : []))
```

Return those maps beside the unchanged ranked data:

```ts
return { ranked: rankReps(rankInputs), decidedByRep, servedAtByRep, skippedRepIds }
```

Merge only at the response layer:

```ts
servedAt: servedAtByRep.get(r.repId)?.toISOString() ?? null,
skippedThisCycle: skippedRepIds.has(r.repId),
```

- [ ] **Step 4: Run focused API tests and type checking**

Run:

```bash
pnpm --filter @phoneup/api exec vitest run src/routers/board.test.ts src/domain/skipLead.test.ts --no-file-parallelism
pnpm --filter @phoneup/api typecheck
```

Expected: all selected tests and API type checking pass.

- [ ] **Step 5: Commit the API contract increment**

```bash
git add apps/api/src/routers/board.ts apps/api/src/routers/board.test.ts
git commit -m "feat(roster): expose active-cycle service metadata"
```

---

### Task 2: Extract and test the assignment presentation model

**Files:**
- Create: `apps/web/src/pages/assignment/model.ts`
- Create: `apps/web/src/pages/assignment/model.test.ts`

**Interfaces:**
- Consumes: `board.roster` rows with `servedAt` and `skippedThisCycle`.
- Produces: `RosterEntry`, `AssignResult`, `bucketRoster`, `sortServedForDisplay`, `assignFormErrors`, `assignEnterAction`, `canSubmitWithRoster`, `canSubmitSkip`, `formatAssignmentTime`, `formatPhone`, `resultGuidance`, `SKIP_PRESETS`, and `resolveSkipReason`.
- Used by: `RosterPanel`, `SkipDialog`, and `AssignmentDrawer` in later tasks.

- [ ] **Step 1: Write failing model tests**

Create cases that define the new metadata and ordering:

```ts
it('puts skipped reps first, then keeps each served subgroup chronological', () => {
  const served = sortServedForDisplay([
    entry({ repId: 'normal-late', servedThisCycle: true, servedAt: '2026-08-01T14:00:00Z' }),
    entry({ repId: 'skipped-late', servedThisCycle: true, skippedThisCycle: true, servedAt: '2026-08-01T13:00:00Z' }),
    entry({ repId: 'normal-early', servedThisCycle: true, servedAt: '2026-08-01T12:00:00Z' }),
    entry({ repId: 'skipped-early', servedThisCycle: true, skippedThisCycle: true, servedAt: '2026-08-01T11:00:00Z' }),
  ])
  expect(served.map((row) => row.repId)).toEqual([
    'skipped-early',
    'skipped-late',
    'normal-early',
    'normal-late',
  ])
})

it('formats the customer phone for the confirmation without copying it', () => {
  expect(formatPhone('+13015550142')).toBe('(301) 555-0142')
})

it('requires detail only for Other skip reasons', () => {
  expect(resolveSkipReason('Rep unavailable', '')).toBe('Rep unavailable')
  expect(resolveSkipReason('Other', '')).toBeNull()
  expect(resolveSkipReason('Other', 'Rep is in training')).toBe('Other: Rep is in training')
})
```

Move the existing non-leaky bucket, form validation, keyboard flow, submission guards, time formatting, and duplicate/unassigned guidance cases from `AssignScreen.test.ts` into this file. Delete the `copyOutcomeMessage` test instead of recreating it.

- [ ] **Step 2: Run the new model test and verify RED**

Run:

```bash
pnpm --filter @phoneup/web exec vitest run src/pages/assignment/model.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the exact shared types and pure helpers**

Create the response types, reusing the exact domain snapshot contract:

```ts
import type { RepRankInput } from '@phoneup/core'

export type RosterEntry = RepRankInput & {
  displayName: string
  decidedBy: 'SYSTEM' | 'MANAGER_OVERRIDE' | null
  servedAt: string | null
  skippedThisCycle: boolean
}

export type AssignResult = {
  leadId: string
  assignedRepId: string | null
  queueSnapshot: RepRankInput[]
  duplicatePhone: boolean
  customerName: string
  assignedAt: string
}
```

Implement presentation-only served ordering:

```ts
export function sortServedForDisplay(entries: RosterEntry[]): RosterEntry[] {
  return [...entries].sort((a, b) => {
    if (a.skippedThisCycle !== b.skippedThisCycle) return a.skippedThisCycle ? -1 : 1
    const timeOrder = (a.servedAt ?? '').localeCompare(b.servedAt ?? '')
    return timeOrder || a.repId.localeCompare(b.repId)
  })
}
```

Make `bucketRoster` call this helper only for eligible served reps. Preserve input order for Next Up, On Deck, and Unavailable.

```ts
export function bucketRoster(roster: RosterEntry[]) {
  const eligible = roster.filter((entry) => entry.isEligible)
  const unserved = eligible.filter((entry) => !entry.servedThisCycle)
  const [nextUp, ...onDeck] = unserved
  return {
    nextUp: nextUp ?? null,
    onDeck,
    served: sortServedForDisplay(eligible.filter((entry) => entry.servedThisCycle)),
    unavailable: roster.filter((entry) => !entry.isEligible),
  }
}
```

Add the confirmation-only phone formatter; this function has no clipboard side effect:

```ts
export function formatPhone(phoneE164: string): string {
  const digits = phoneE164.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  if (digits.length !== 10) return phoneE164
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
}
```

Define the preset tuple and resolver:

```ts
export const SKIP_PRESETS = [
  'Rep unavailable',
  'Rep already assisting a customer',
  'Customer requested another rep',
  'Manager-directed pass',
  'Other',
] as const

export type SkipPreset = typeof SKIP_PRESETS[number]

export function resolveSkipReason(preset: SkipPreset | null, otherDetail: string): string | null {
  if (!preset) return null
  if (preset !== 'Other') return preset
  const detail = otherDetail.trim()
  return detail ? `Other: ${detail}` : null
}
```

Move the existing non-clipboard pure helpers without changing their user-facing copy.

- [ ] **Step 4: Run model tests and web type checking**

Run:

```bash
pnpm --filter @phoneup/web exec vitest run src/pages/assignment/model.test.ts
pnpm --filter @phoneup/web typecheck
```

Expected: all model tests and web type checking pass.

- [ ] **Step 5: Commit the presentation model**

```bash
git add apps/web/src/pages/assignment/model.ts apps/web/src/pages/assignment/model.test.ts
git commit -m "refactor(assignments): extract drawer presentation model"
```

---

### Task 3: Build the accessible drawer primitive

**Files:**
- Create: `apps/web/src/ui/Drawer.tsx`
- Create: `apps/web/src/ui/Drawer.test.tsx`
- Modify: `apps/web/src/styles/ui.css`

**Interfaces:**
- Consumes: `open`, `title`, `busy`, `onClose`, and `children` props.
- Produces: `Drawer` plus exported pure helper `canCloseDrawer(busy: boolean): boolean`.
- Guarantees: `role="dialog"`, `aria-modal="true"`, focus trap, idle Escape/backdrop/Close dismissal, busy close prevention, and focus restoration.

- [ ] **Step 1: Write failing semantic and guard tests**

```tsx
it('renders one named modal drawer and disables Close while busy', () => {
  const html = renderToStaticMarkup(
    createElement(Drawer, {
      open: true,
      title: 'Assign lead',
      busy: true,
      onClose: () => {},
      children: createElement('p', null, 'Drawer body'),
    }),
  )
  expect(html).toContain('role="dialog"')
  expect(html).toContain('aria-label="Assign lead"')
  expect(html).toContain('disabled=""')
})

it('allows close only while idle', () => {
  expect(canCloseDrawer(false)).toBe(true)
  expect(canCloseDrawer(true)).toBe(false)
})
```

- [ ] **Step 2: Run the drawer test and verify RED**

Run:

```bash
pnpm --filter @phoneup/web exec vitest run src/ui/Drawer.test.tsx
```

Expected: FAIL because `Drawer` is not defined.

- [ ] **Step 3: Implement the drawer shell**

Follow `Modal.tsx`'s existing focusable-selector and Tab-wrap behavior. The public shape is:

```tsx
export type DrawerProps = {
  open: boolean
  title: string
  busy?: boolean
  onClose: () => void
  children: ReactNode
}

export function canCloseDrawer(busy: boolean): boolean {
  return !busy
}
```

Render the shell only when open:

```tsx
<div className="ui-drawer-backdrop" onMouseDown={handleBackdropMouseDown}>
  <section
    className="ui-drawer"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    ref={panelRef}
    onKeyDown={handleKeyDown}
  >
    <header className="ui-drawer-header">
      <h2>{title}</h2>
      <Button aria-label={`Close ${title}`} onClick={onClose} disabled={busy}>Close</Button>
    </header>
    {children}
  </section>
</div>
```

Escape and backdrop clicks call `onClose` only when `canCloseDrawer(!!busy)` is true. Capture the previously focused element on open and restore it during effect cleanup.

- [ ] **Step 4: Add structural and responsive drawer CSS**

Add token-based classes:

```css
.ui-drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: color-mix(in srgb, var(--color-text) 32%, transparent);
}
.ui-drawer {
  position: absolute;
  inset: 0 0 0 auto;
  width: min(920px, 92vw);
  overflow: auto;
  background: var(--color-bg);
  border-left: 2px solid var(--color-accent);
  box-shadow: var(--shadow-lg);
}
@media (max-width: 700px) {
  .ui-drawer { width: 100vw; }
}
@media (prefers-reduced-motion: no-preference) {
  .ui-drawer { animation: ui-drawer-enter 160ms ease-out; }
}
```

Use existing tokens; do not add raw palette values.

- [ ] **Step 5: Run drawer tests, web typecheck, and lint**

```bash
pnpm --filter @phoneup/web exec vitest run src/ui/Drawer.test.tsx
pnpm --filter @phoneup/web typecheck
pnpm --filter @phoneup/web lint
```

Expected: test and typecheck pass; lint exits zero with no new warning category.

- [ ] **Step 6: Commit the drawer primitive**

```bash
git add apps/web/src/ui/Drawer.tsx apps/web/src/ui/Drawer.test.tsx apps/web/src/styles/ui.css
git commit -m "feat(ui): add accessible assignment drawer shell"
```

---

### Task 4: Build the roster panel and Skip preset dialog

**Files:**
- Create: `apps/web/src/pages/assignment/RosterPanel.tsx`
- Create: `apps/web/src/pages/assignment/RosterPanel.test.tsx`
- Create: `apps/web/src/pages/assignment/SkipDialog.tsx`
- Create: `apps/web/src/pages/assignment/SkipDialog.test.tsx`
- Modify: `apps/web/src/styles/ui.css`

**Interfaces:**
- `RosterPanel({ roster, hasLoadedRoster, loadError, onRetry, onOpenRep })` renders all four buckets.
- `SkipDialog({ open, repName, skipping, error, readOnly, onClose, onConfirm })` calls `onConfirm(reasonNote)` only from its explicit submit action.
- Consumes: helpers and types from `assignment/model.ts`.

- [ ] **Step 1: Write failing roster semantic/order tests**

```tsx
it('uses one Served This Round bucket with badge-only skipped identification', () => {
  const html = renderToStaticMarkup(createElement(RosterPanel, {
    roster: [
      entry({ repId: 'normal', displayName: 'Normal Rep', servedThisCycle: true, servedAt: '2026-08-01T12:00:00Z' }),
      entry({ repId: 'skipped', displayName: 'Skipped Rep', servedThisCycle: true, skippedThisCycle: true, servedAt: '2026-08-01T13:00:00Z' }),
    ],
    hasLoadedRoster: true,
    loadError: false,
    onRetry: () => {},
  }))

  expect(html.match(/Served This Round/g)).toHaveLength(1)
  expect(html.indexOf('Skipped Rep')).toBeLessThan(html.indexOf('Normal Rep'))
  expect(html).toContain('Skipped</span>')
  expect(html).not.toContain('skip reason')
})
```

Also preserve tests for Next Up drill-down markup, On Deck numbering from 2, unavailable reasons, loading, stale-last-good warning, total-load failure, and Retry.

- [ ] **Step 2: Write failing Skip dialog tests**

Test the static preset labels and exported submit guard:

```tsx
expect(html).toContain('Rep unavailable')
expect(html).toContain('Rep already assisting a customer')
expect(html).toContain('Customer requested another rep')
expect(html).toContain('Manager-directed pass')
expect(html).toContain('Other')
expect(canConfirmSkip('Other', '', false, false)).toBe(false)
expect(canConfirmSkip('Other', 'Rep is in training', false, false)).toBe(true)
expect(canConfirmSkip('Rep unavailable', '', true, false)).toBe(false)
```

- [ ] **Step 3: Run both new files and verify RED**

```bash
pnpm --filter @phoneup/web exec vitest run src/pages/assignment/RosterPanel.test.tsx src/pages/assignment/SkipDialog.test.tsx
```

Expected: FAIL because both components are missing.

- [ ] **Step 4: Implement `RosterPanel` from the existing four-bucket markup**

Use `bucketRoster(roster)` and keep `RosterRepName` as a button only when `onOpenRep` exists. Render served rows as neutral `<li>` elements:

```tsx
<li key={entry.repId} className="ui-roster-row">
  <RosterRepName entry={entry} onOpenRep={onOpenRep} />
  {entry.skippedThisCycle && <Badge tone="warn">Skipped</Badge>}
  <span className="ui-muted">{entry.monthlyLoad} ups MTD</span>
</li>
```

Do not add a skipped-row background class or a second bucket.

- [ ] **Step 5: Implement `SkipDialog` with one deliberate submit**

Keep preset/detail state local and reset it whenever `open` or `repName` changes. Derive the audit string with `resolveSkipReason`:

```ts
export function canConfirmSkip(
  preset: SkipPreset | null,
  otherDetail: string,
  skipping: boolean,
  readOnly: boolean,
): boolean {
  return !!resolveSkipReason(preset, otherDetail) && !skipping && !readOnly
}
```

The preset controls only select; the Modal submit button calls:

```ts
const reason = resolveSkipReason(preset, otherDetail)
if (reason) onConfirm(reason)
```

- [ ] **Step 6: Add only necessary panel/preset styles**

Add neutral roster-row layout, compact reason buttons, selected reason state, and compact yellow badge positioning. Reuse `Badge tone="warn"`; do not add a full-row skipped treatment.

- [ ] **Step 7: Run focused tests, typecheck, and lint**

```bash
pnpm --filter @phoneup/web exec vitest run src/pages/assignment/model.test.ts src/pages/assignment/RosterPanel.test.tsx src/pages/assignment/SkipDialog.test.tsx
pnpm --filter @phoneup/web typecheck
pnpm --filter @phoneup/web lint
```

Expected: all focused tests pass and there are no new lint failures.

- [ ] **Step 8: Commit the two focused components**

```bash
git add apps/web/src/pages/assignment/RosterPanel.tsx apps/web/src/pages/assignment/RosterPanel.test.tsx apps/web/src/pages/assignment/SkipDialog.tsx apps/web/src/pages/assignment/SkipDialog.test.tsx apps/web/src/styles/ui.css
git commit -m "feat(assignments): add roster panel and skip presets"
```

---

### Task 5: Build the assignment workspace inside the drawer

**Files:**
- Create: `apps/web/src/pages/assignment/AssignmentDrawer.tsx`
- Create: `apps/web/src/pages/assignment/AssignmentDrawer.test.tsx`
- Modify: `apps/web/src/styles/ui.css`

**Interfaces:**
- `AssignmentDrawer({ open, onClose, onOpenRep })` owns the form/result lifecycle and renders `Drawer`, `RosterPanel`, and `SkipDialog`.
- Uses existing endpoints: `board.roster`, `assignment.assign`, `assignment.skip`, and `assignment.void`.
- Tracks `resultPhoneE164` locally so the same phone remains visible across repeated Skip results without extending the mutation response.

- [ ] **Step 1: Write failing result and busy-state tests**

Export small pure helpers so the no-DOM test environment can verify the lifecycle:

```ts
it('treats any assignment mutation as drawer-busy', () => {
  expect(isAssignmentBusy(true, false, false)).toBe(true)
  expect(isAssignmentBusy(false, true, false)).toBe(true)
  expect(isAssignmentBusy(false, false, true)).toBe(true)
  expect(isAssignmentBusy(false, false, false)).toBe(false)
})

it('renders a rep-first result with phone and no clipboard affordance', () => {
  const html = renderToStaticMarkup(createElement(AssignmentResult, {
    result: assignedResult,
    repName: 'Raul Valle',
    phoneE164: '+13015550142',
    canSkip: true,
    canVoid: true,
    busy: false,
    onSkip: () => {},
    onVoid: () => {},
  }))
  expect(html.indexOf('Raul Valle')).toBeLessThan(html.indexOf('Kev Tom'))
  expect(html).toContain('(301) 555-0142')
  expect(html).not.toContain('Copy phone')
  expect(html).not.toContain('Alt+C')
})
```

- [ ] **Step 2: Run the drawer feature test and verify RED**

```bash
pnpm --filter @phoneup/web exec vitest run src/pages/assignment/AssignmentDrawer.test.tsx
```

Expected: FAIL because `AssignmentDrawer` and `AssignmentResult` do not exist.

- [ ] **Step 3: Move existing assignment state and mutations into `AssignmentDrawer`**

Start from the proven `AssignScreen` behavior, but remove these imports and all dependent state/effects/functions:

```ts
import { digitsOnly, useClipboardStore } from '../../state/clipboardStore'
```

Specifically do not recreate `lastCopiedPhone`, `copyFailed`, `copyNotice`, `copyOutcomeMessage`, `handleCopyClick`, `navigator.clipboard.writeText`, or the `Alt+C` window listener.

Keep:

- roster load/retry and realtime subscription;
- form validation and keyboard progression;
- UUID idempotency per assignment and per Skip dialog opening;
- shared mutation error translation;
- existing Alt+V behavior;
- duplicate and unassigned guidance.

Add `voiding` state so busy protection covers Void:

```ts
export function isAssignmentBusy(assigning: boolean, skipping: boolean, voiding: boolean): boolean {
  return assigning || skipping || voiding
}
```

- [ ] **Step 4: Keep phone display local across Skip**

Before the assignment mutation, compute `phoneE164`. On success:

```ts
setResultPhoneE164(phoneE164)
setLastResult(result)
```

Do not clear `resultPhoneE164` when Skip returns a new `AssignResult`; clear it only when the drawer unmounts or Void clears the result.

- [ ] **Step 5: Implement the rep-first result and form-to-result transition**

Render either the form or result in the work column:

```tsx
<div className="ui-assignment-work">
  {lastResult
    ? <AssignmentResult
        result={lastResult}
        repName={lastResult.assignedRepId ? nameById.get(lastResult.assignedRepId) ?? lastResult.assignedRepId : null}
        phoneE164={resultPhoneE164}
        canSkip={canSkip}
        canVoid={canVoid}
        busy={busy}
        onSkip={openSkip}
        onVoid={() => setVoidReasonOpen(true)}
      />
    : <AssignmentForm ... />}
</div>
```

For an assigned lead, `AssignmentResult` renders this order: `Assigned to`, large rep name, customer plus formatted phone, assignment time, guidance, Skip, Void. It renders no phone-copy behavior.

- [ ] **Step 6: Wire `SkipDialog` and preserve repeated Skip**

Pass the chosen `reasonNote` to the unchanged mutation input:

```ts
async function handleSkip(reasonNote: string) {
  if (!lastResult?.assignedRepId || !skipKey || !canSkip) return
  setSkipping(true)
  setSkipError(null)
  try {
    const result = await mutate<AssignResult>('assignment.skip', {
      leadId: lastResult.leadId,
      expectedRepId: lastResult.assignedRepId,
      reasonNote,
      idempotencyKey: skipKey,
    })
    setLastResult(result)
    setSkipReasonOpen(false)
    refreshRoster()
  } catch (error) {
    setSkipError(mutationErrorMessage(error, 'This rep could not be skipped. Try again.'))
  } finally {
    setSkipping(false)
  }
}
```

After success, Skip remains available for the newly assigned rep. Opening it creates a new UUID; retrying the same in-flight attempt retains its key.

- [ ] **Step 7: Prevent closing while any mutation is active**

Pass the combined busy state to `Drawer` and use an idle-only wrapper:

```ts
const busy = isAssignmentBusy(assigning, skipping, voiding)
const requestClose = () => {
  if (!busy) onClose()
}
```

The app shell will unmount `AssignmentDrawer` after `onClose`, naturally clearing all local state.

- [ ] **Step 8: Add assignment workspace/result CSS**

Use a desktop two-column grid with the work area first and roster second:

```css
.ui-assignment-drawer-body {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(320px, .9fr);
}
.ui-assignment-rep-name {
  color: var(--color-accent);
  font-family: var(--font-display);
  font-size: clamp(2rem, 4vw, 3.5rem);
  line-height: 1;
}
@media (max-width: 700px) {
  .ui-assignment-drawer-body { grid-template-columns: 1fr; }
}
```

Place the form's primary Assign button beneath Notes. Do not recreate the sticky-above-form action.

- [ ] **Step 9: Run assignment feature tests and web checks**

```bash
pnpm --filter @phoneup/web exec vitest run src/pages/assignment/model.test.ts src/pages/assignment/RosterPanel.test.tsx src/pages/assignment/SkipDialog.test.tsx src/pages/assignment/AssignmentDrawer.test.tsx
pnpm --filter @phoneup/web typecheck
pnpm --filter @phoneup/web lint
```

Expected: all focused tests pass; no clipboard-oriented assignment test remains.

- [ ] **Step 10: Commit the drawer workspace**

```bash
git add apps/web/src/pages/assignment/AssignmentDrawer.tsx apps/web/src/pages/assignment/AssignmentDrawer.test.tsx apps/web/src/styles/ui.css
git commit -m "feat(assignments): move assignment workflow into drawer"
```

---

### Task 6: Integrate the drawer into the app shell and remove the page

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.ts`
- Delete: `apps/web/src/pages/AssignScreen.tsx`
- Delete: `apps/web/src/pages/AssignScreen.test.ts`

**Interfaces:**
- Produces: header-opened `AssignmentDrawer`, role-safe `landingPage(role)`, and `canOpenAssignmentDrawer(canAssign, viewAsUserId)`.
- Preserves: rep drill-down navigation and return-to-origin behavior.

- [ ] **Step 1: Write failing app-shell helper tests**

Replace Assign-route assumptions with explicit landing and drawer rules:

```ts
it('lands non-Reps on Team Dashboard and Reps on My Dashboard', () => {
  expect(landingPage('ADMIN')).toBe('dashboard')
  expect(landingPage('MANAGER')).toBe('dashboard')
  expect(landingPage('BDC')).toBe('dashboard')
  expect(landingPage('REP')).toBe('me')
})

it('does not expose an actionable assignment drawer during View-as', () => {
  expect(canOpenAssignmentDrawer(true, null)).toBe(true)
  expect(canOpenAssignmentDrawer(true, 'viewed-user')).toBe(false)
  expect(canOpenAssignmentDrawer(false, null)).toBe(false)
})

it('falls back from rep detail to the role-safe landing page', () => {
  expect(repBackPage(null, 'BDC')).toBe('dashboard')
  expect(repBackPage(null, 'REP')).toBe('me')
})
```

- [ ] **Step 2: Run App tests and verify RED**

```bash
pnpm --filter @phoneup/web exec vitest run src/App.test.ts
```

Expected: FAIL because the new helpers and dashboard fallback do not exist.

- [ ] **Step 3: Remove `assign` from page routing and add role-safe landing helpers**

Use:

```ts
export type Page = 'staff' | 'dashboard' | 'users' | 'audit' | 'me' | 'rep' | 'import' | 'password'

export function landingPage(role: Role): Page {
  return role === 'REP' ? 'me' : 'dashboard'
}

export function canOpenAssignmentDrawer(canAssign: boolean, viewAsUserId: string | null): boolean {
  return canAssign && viewAsUserId === null
}
```

Initialize the page to `dashboard`; derive a Rep-safe active page after the session is known. Update password completion, View-as selection/exit, and rep-detail fallback to use `landingPage` instead of `'assign'`.

- [ ] **Step 4: Add the header action and drawer mount**

Add `assignmentOpen` state. Render one primary header action only when `canOpenAssignmentDrawer(canAssign, viewAsUserId)`:

```tsx
<Button variant="primary" onClick={() => setAssignmentOpen(true)}>
  Assign lead
</Button>
```

Wrap the existing nav/banner/main shell and make it inert while the drawer is open:

```tsx
<div className="ui-app-shell" inert={assignmentOpen ? true : undefined}>
  {/* existing nav, banner, and main */}
</div>
{assignmentOpen && (
  <AssignmentDrawer
    open
    onClose={() => setAssignmentOpen(false)}
    onOpenRep={(repId) => {
      setAssignmentOpen(false)
      openRep(repId)
    }}
  />
)}
```

- [ ] **Step 5: Make navigation match the approved landing model**

- Show `My Dashboard` only when the effective viewed role is `REP`.
- Show `Team Dashboard` for non-Rep roles with `board.view`.
- Remove the old Assign navigation/page button.
- Preserve all other navigation items and profile actions unchanged in this task.

- [ ] **Step 6: Delete the superseded page after imports/tests move**

Delete `AssignScreen.tsx` and `AssignScreen.test.ts`. Verify no source references remain:

```bash
rg -n "AssignScreen|activePage === 'assign'|setPage\('assign'\)|copyOutcomeMessage" apps/web/src
```

Expected: no matches.

- [ ] **Step 7: Run the full web suite, typecheck, lint, and build**

```bash
pnpm --filter @phoneup/web test
pnpm --filter @phoneup/web typecheck
pnpm --filter @phoneup/web lint
pnpm --filter @phoneup/web build
```

Expected: all tests, typecheck, lint exit, and production build pass. Existing Fast Refresh warnings may remain but no new warning category is accepted.

- [ ] **Step 8: Commit app-shell integration**

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.ts apps/web/src/pages/AssignScreen.tsx apps/web/src/pages/AssignScreen.test.ts
git commit -m "feat(navigation): open assignments from the app header"
```

---

### Task 7: Reconcile documentation and run final proof

**Files:**
- Modify: `docs/Revised consolidated action list.md`
- Verify all files changed by Tasks 1–6.

**Interfaces:**
- Produces: status-bearing documentation that distinguishes implemented, locally verified, deployed, and production-verified work.
- Preserves: the user's current action-list correction until implementation evidence justifies replacing it.

- [ ] **Step 1: Update the action list only after implementation checks pass**

Reconcile the current user note instead of overwriting it mechanically. Record these completed follow-ups:

```md
- [x] Replace the dedicated Assign page with a global BDC+ assignment drawer containing the form and live roster.
- [x] Restore the primary Assign action beneath the form and preserve submit-time-only rotation locking.
- [x] Make assignment confirmation rep-first, show customer plus phone, and remove assignment-workspace clipboard behavior.
- [x] Add preset Skip reasons while preserving deliberate confirmation and Audit Log-only reason visibility.
- [x] Present skipped reps first inside one neutral Served This Round list with a compact Skipped badge.
```

Update the Priority 2/3 completion notes with exact local validation evidence. Do not claim deployed or production-verified.

- [ ] **Step 2: Run formatting and focused affected gates**

```bash
git diff --check
pnpm --filter @phoneup/api exec vitest run src/routers/board.test.ts src/domain/assignLead.test.ts src/domain/skipLead.test.ts --no-file-parallelism
pnpm --filter @phoneup/web test
pnpm typecheck
pnpm --filter @phoneup/web lint
pnpm --filter @phoneup/web build
```

Expected: affected API tests, all web tests, workspace typecheck, lint exit, build, and diff check pass.

- [ ] **Step 3: Run the full API suite serially and attribute failures**

```bash
pnpm --filter @phoneup/api exec vitest run --no-file-parallelism
```

Expected: no new failure attributable to this work. If the known four `voidLead.test.ts` failures remain, compare the exact file at the pre-implementation commit before classifying them as baseline; do not broaden this task to repair them.

- [ ] **Step 4: Run the authenticated BDC browser flow**

Using the Playwright CLI against the local web/API and test database:

1. Verify BDC starts on Team Dashboard and sees header `Assign lead`.
2. Open the drawer; verify Customer name receives focus and background app shell is inert.
3. Enter customer, phone, and notes; verify Assign is beneath the form and names Next Up.
4. Submit; verify the rep name is dominant, customer and formatted phone follow, and no automatic clipboard call, Copy button, copied notice, or `Alt+C` behavior exists.
5. Open Skip; verify all five presets, `Other` detail requirement, named-rep copy, and disabled confirm before a complete reason.
6. Submit one preset Skip; verify the same lead passes, the drawer remains open, and the skipped rep is first in the single `Served This Round` list with only the yellow `Skipped` badge.
7. Open another Skip to prove repeated deliberate Skip remains available; cancel without submitting.
8. Close the drawer; verify Team Dashboard ups refresh. Reopen and verify a clean form.
9. Verify Manager/Admin access, REP absence of Assign, View-as absence of an actionable drawer, keyboard focus restoration, Escape, and narrow-screen full-screen layout.

Do not touch production or deploy during this validation.

- [ ] **Step 5: Inspect final scope and repository state**

```bash
git status --short
git diff --stat
git diff --check
rg -n "navigator\.clipboard|Copy phone|Alt\+C|copyOutcomeMessage" apps/web/src/pages/assignment apps/web/src/App.tsx
```

Expected: clipboard scan has no matches in the assignment workspace; only intended implementation files, the deliberately updated action list, and any pre-existing user-owned/untracked files remain.

- [ ] **Step 6: Commit the verified documentation update**

```bash
git add docs/Revised\ consolidated\ action\ list.md
git commit -m "docs(assignments): record drawer workflow completion"
```

- [ ] **Step 7: Final handoff**

Report:

- commits created on `main` and that nothing was pushed;
- exact automated and browser results;
- Node version used versus the declared 22.x engine;
- any parent-reproduced API failures;
- deployment/production verification still outstanding;
- preserved user-owned files and the untracked `.superpowers/` companion artifacts.
