# Inline Skip and Guarded Assignment Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the shared assignment drawer with Skip reasons inline beneath the saved assignment result and prevent X, backdrop, or Escape from silently discarding assignment or Skip drafts.

**Architecture:** Resume from the partially implemented `codex/assignment-drawer` branch at design commit `f37d2f1`. Replace the modal-owning `SkipDialog` with a controlled inline editor, centralize assignment/Skip lifecycle and close decisions in `AssignmentDrawer`, reuse `Modal` only for destructive discard and Void confirmations, then mount the drawer from the app shell and remove the dedicated Assign page.

**Tech Stack:** React 19, TypeScript 6, Vite 8, Zustand, existing fetch helpers, Vitest in Node environment, oxlint, and Playwright CLI for real-browser interaction proof.

## Global Constraints

- Preserve `rankReps`, assignment selection, cycle boundaries, monthly-counter accounting, advisory-lock timing, and the append-only ledger.
- Preserve guarded repeatable Skip: expected-rep validation, idempotency, BDC ownership, Manager/Admin override, audit logging, and same-lead passing.
- Do not add a database migration or frontend dependency.
- Team Dashboard is the non-Rep landing screen; Rep accounts land on My Dashboard.
- Assignment mutations remain blocked during Admin View-as; do not expose an actionable drawer in View-as.
- Skip presets are exactly `Rep unavailable`, `Rep already assisting a customer`, `Customer requested another rep`, `Manager-directed pass`, and `Other`.
- Skip reasons remain Audit Log-only and must not appear in `board.roster` or the roster presentation.
- `Served This Round` remains one bucket: skipped reps first with a compact yellow `Skipped` badge and neutral rows, followed by normally served reps; each subgroup is chronological.
- Remove assignment auto-copy, Copy phone, copied-phone notices, and assignment `Alt+C`; preserve phone-copy controls in Rep Dashboard and Rep Detail.
- Skip reasons render inline beneath the assignment result. The normal Skip workflow must not open a nested modal.
- X, drawer-backdrop click, and Escape use one close-request path. Clean state closes immediately; dirty assignment or inline Skip state requires `Discard unsaved changes?`.
- `Keep editing`, discard-dialog backdrop, and discard-dialog Escape preserve the unchanged drawer. Only `Discard changes` clears and closes it.
- Assign, Skip, or Void in flight blocks every close path and does not open the discard warning.
- Preserve the user's uncommitted edit in `docs/Revised consolidated action list.md` until the final documentation task deliberately reconciles it.
- Run with Node 22.x when available. If only Node 26.5.0 is available, record the engine mismatch.

## Starting checkpoint

The following reviewed work already exists and must not be reimplemented:

- `04f4076` adds `servedAt` and `skippedThisCycle` after ranking.
- `f9a96b7` adds the pure assignment model and served display ordering.
- `f88a8aa` and `0003b56` add the accessible drawer primitive and strengthened semantics.
- `cfa7429` adds `RosterPanel` and the now-superseded modal `SkipDialog`.
- `5194c62` and `f37d2f1` record the approved inline-Skip and guarded-close design corrections.

This plan supersedes Tasks 4–7 of `docs/superpowers/plans/2026-08-01-assignment-drawer.md`. Tasks 1–3 and the `RosterPanel` portion of old Task 4 remain authoritative completed work.

## Planned file structure

- Create `apps/web/src/pages/assignment/SkipReasonEditor.tsx` — controlled inline preset/detail presentation and explicit confirmation.
- Create `apps/web/src/pages/assignment/SkipReasonEditor.test.tsx` — rendered semantics plus pure confirmation guard coverage.
- Delete `apps/web/src/pages/assignment/SkipDialog.tsx` and `SkipDialog.test.tsx` — remove the nested Skip modal.
- Modify `apps/web/src/pages/assignment/RosterPanel.tsx` and its test — own rep-name rendering locally so deleting `AssignScreen` cannot break it.
- Modify `apps/web/src/pages/assignment/model.ts` and its test — add trimmed dirty-draft helpers.
- Modify `apps/web/src/ui/Drawer.tsx` and its test — top-right X and inactive-under-confirmation protection.
- Modify `apps/web/src/ui/Modal.tsx`; create `Modal.test.tsx` — support safe initial focus and destructive submit styling without changing existing callers.
- Create `apps/web/src/pages/assignment/DiscardChangesDialog.tsx` and its test — exact warning copy and safe/destructive actions.
- Create `apps/web/src/pages/assignment/AssignmentDrawer.tsx` and its test — assignment, inline Skip, Void, roster, guarded close, and reset lifecycle.
- Modify `apps/web/src/styles/ui.css` — inline editor, result hierarchy, close X, and responsive workspace.
- Modify `apps/web/src/App.tsx` and `App.test.ts` — role-safe landing, header action, drawer mount, and route removal.
- Delete `apps/web/src/pages/AssignScreen.tsx` and `AssignScreen.test.ts` after all behavior is moved.
- Modify `docs/Revised consolidated action list.md` only after implementation and verification pass.

---

### Task 1: Replace the Skip modal with a controlled inline editor

**Files:**
- Create: `apps/web/src/pages/assignment/SkipReasonEditor.tsx`
- Create: `apps/web/src/pages/assignment/SkipReasonEditor.test.tsx`
- Modify: `apps/web/src/pages/assignment/RosterPanel.tsx`
- Modify: `apps/web/src/pages/assignment/RosterPanel.test.tsx`
- Modify: `apps/web/src/styles/ui.css`
- Delete: `apps/web/src/pages/assignment/SkipDialog.tsx`
- Delete: `apps/web/src/pages/assignment/SkipDialog.test.tsx`

**Interfaces:**

```ts
export type SkipReasonEditorProps = {
  repName: string
  preset: SkipPreset | null
  otherDetail: string
  skipping: boolean
  error: string | null
  readOnly: boolean
  onPresetChange: (preset: SkipPreset) => void
  onOtherDetailChange: (detail: string) => void
  onCancel: () => void
  onConfirm: (reasonNote: string) => void
}

export function canConfirmSkip(
  preset: SkipPreset | null,
  otherDetail: string,
  skipping: boolean,
  readOnly: boolean,
): boolean
```

`SkipReasonEditor` is always inline when rendered; it has no `open` prop, local state, `Modal`, backdrop, or Escape handler. `AssignmentDrawer` owns whether it exists and all preset/detail lifecycle state.

- [ ] **Step 1: Write the failing inline-editor tests**

Create `SkipReasonEditor.test.tsx` with hand-derived markup assertions:

```tsx
it('renders the Skip workflow inline without another dialog', () => {
  const html = renderToStaticMarkup(createElement(SkipReasonEditor, {
    repName: 'Raul Valle',
    preset: null,
    otherDetail: '',
    skipping: false,
    error: null,
    readOnly: false,
    onPresetChange: () => {},
    onOtherDetailChange: () => {},
    onCancel: () => {},
    onConfirm: () => {},
  }))

  expect(html).toContain('Skip Raul Valle')
  expect(html).toContain('Rep unavailable')
  expect(html).toContain('Manager-directed pass')
  expect(html).toContain('Skip rep and pass lead')
  expect(html).not.toContain('role="dialog"')
  expect(html).not.toContain('aria-modal="true"')
})

it('requires Other detail and blocks confirmation while busy or read-only', () => {
  expect(canConfirmSkip('Other', '', false, false)).toBe(false)
  expect(canConfirmSkip('Other', 'Rep is in training', false, false)).toBe(true)
  expect(canConfirmSkip('Rep unavailable', '', true, false)).toBe(false)
  expect(canConfirmSkip('Rep unavailable', '', false, true)).toBe(false)
})
```

Extend `RosterPanel.test.tsx` to prove rep names still render as buttons when `onOpenRep` is provided after removing its `AssignScreen` import.

- [ ] **Step 2: Run the tests and verify RED**

```bash
pnpm --filter @phoneup/web exec vitest run src/pages/assignment/SkipReasonEditor.test.tsx src/pages/assignment/RosterPanel.test.tsx
```

Expected: `SkipReasonEditor` module is missing. The roster regression may remain green until the ownership move.

- [ ] **Step 3: Implement the controlled editor**

Render a normal section beneath the result:

```tsx
<section className="ui-skip-editor ui-stack" aria-labelledby="skip-editor-title">
  <div className="ui-skip-editor-head">
    <div>
      <p className="ui-eyebrow">Pass this lead</p>
      <h3 id="skip-editor-title">Skip {repName}</h3>
    </div>
    <Button size="sm" onClick={onCancel} disabled={skipping}>Cancel</Button>
  </div>
  <p>The same lead will pass to the next available rep. This rep stays served for the current round.</p>
  <div className="ui-skip-presets" role="group" aria-label="Skip reason">
    {SKIP_PRESETS.map((option) => (
      <Button
        key={option}
        className={option === preset ? 'ui-skip-preset-selected' : 'ui-skip-preset'}
        size="sm"
        aria-pressed={option === preset}
        disabled={skipping || readOnly}
        onClick={() => onPresetChange(option)}
      >
        {option}
      </Button>
    ))}
  </div>
  {preset === 'Other' && (
    <Field label="Other reason" error={error}>
      <Input
        value={otherDetail}
        onChange={(event) => onOtherDetailChange(event.target.value)}
        disabled={skipping || readOnly}
        placeholder="Describe the reason"
      />
    </Field>
  )}
  {preset !== 'Other' && error && <p className="ui-error" role="alert">{error}</p>}
  <Button
    variant="primary"
    onClick={() => {
      const reason = resolveSkipReason(preset, otherDetail)
      if (reason) onConfirm(reason)
    }}
    disabled={!canConfirmSkip(preset, otherDetail, skipping, readOnly)}
  >
    {skipping ? 'Skipping…' : 'Skip rep and pass lead'}
  </Button>
</section>
```

Move `RosterRepName` into `RosterPanel.tsx` as a local function with the same optional-button behavior. Delete both `SkipDialog` files. Add only compact inline-editor layout styles; do not add a second overlay, skipped-row background, or raw palette values.

- [ ] **Step 4: Run focused checks**

```bash
pnpm --filter @phoneup/web exec vitest run src/pages/assignment/model.test.ts src/pages/assignment/RosterPanel.test.tsx src/pages/assignment/SkipReasonEditor.test.tsx
pnpm --filter @phoneup/web typecheck
pnpm --filter @phoneup/web lint
git diff --check
```

Expected: all focused tests, typecheck, lint exit, and diff check pass. Existing Fast Refresh warnings may remain; no new warning category is accepted.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/assignment/SkipReasonEditor.tsx apps/web/src/pages/assignment/SkipReasonEditor.test.tsx apps/web/src/pages/assignment/RosterPanel.tsx apps/web/src/pages/assignment/RosterPanel.test.tsx apps/web/src/pages/assignment/SkipDialog.tsx apps/web/src/pages/assignment/SkipDialog.test.tsx apps/web/src/styles/ui.css
git commit -m "refactor(assignments): keep skip reasons inline"
```

---

### Task 2: Add dirty-draft close primitives and discard confirmation

**Files:**
- Modify: `apps/web/src/pages/assignment/model.ts`
- Modify: `apps/web/src/pages/assignment/model.test.ts`
- Modify: `apps/web/src/ui/Drawer.tsx`
- Modify: `apps/web/src/ui/Drawer.test.tsx`
- Modify: `apps/web/src/ui/Modal.tsx`
- Create: `apps/web/src/ui/Modal.test.tsx`
- Create: `apps/web/src/pages/assignment/DiscardChangesDialog.tsx`
- Create: `apps/web/src/pages/assignment/DiscardChangesDialog.test.tsx`
- Modify: `apps/web/src/styles/ui.css`

**Interfaces:**

```ts
export function hasAssignmentDraft(name: string, phone: string, notes: string): boolean
export function hasSkipDraft(open: boolean, preset: SkipPreset | null, otherDetail: string): boolean
export function shouldConfirmDrawerClose(input: {
  formActive: boolean
  name: string
  phone: string
  notes: string
  skipOpen: boolean
  skipPreset: SkipPreset | null
  skipOtherDetail: string
}): boolean

export type DrawerProps = {
  open: boolean
  title: string
  busy?: boolean
  inactive?: boolean
  onClose: () => void
  children: ReactNode
}

export type ModalProps = {
  // existing props remain
  initialFocus?: 'submit' | 'cancel'
  submitTone?: 'primary' | 'danger'
}
```

- [ ] **Step 1: Write failing dirty-state tests**

Add literal cases to `model.test.ts`:

```ts
it('treats only non-whitespace assignment input as a draft', () => {
  expect(hasAssignmentDraft('   ', '\n', '\t')).toBe(false)
  expect(hasAssignmentDraft('Kev Tom', '', '')).toBe(true)
  expect(hasAssignmentDraft('', '3015550142', '')).toBe(true)
  expect(hasAssignmentDraft('', '', 'Call after 3')).toBe(true)
})

it('protects only a started inline Skip editor', () => {
  expect(hasSkipDraft(false, 'Rep unavailable', 'detail')).toBe(false)
  expect(hasSkipDraft(true, null, '   ')).toBe(false)
  expect(hasSkipDraft(true, 'Rep unavailable', '')).toBe(true)
  expect(hasSkipDraft(true, null, 'Rep is in training')).toBe(true)
})

it('does not warn for a saved result unless a Skip draft is active', () => {
  expect(shouldConfirmDrawerClose({
    formActive: false,
    name: 'already submitted',
    phone: '3015550142',
    notes: 'already submitted',
    skipOpen: false,
    skipPreset: null,
    skipOtherDetail: '',
  })).toBe(false)
})
```

- [ ] **Step 2: Write failing Drawer, Modal, and warning semantics tests**

`Drawer.test.tsx` must assert one accessible X, `canCloseDrawer(false, false) === true`, `canCloseDrawer(true, false) === false`, and `canCloseDrawer(false, true) === false`. `Modal.test.tsx` must assert `submitTone="danger"` produces the existing danger class and the safe cancel label is present. `DiscardChangesDialog.test.tsx` must assert the exact title, message, `Keep editing`, and `Discard changes` copy.

- [ ] **Step 3: Run and verify RED**

```bash
pnpm --filter @phoneup/web exec vitest run src/pages/assignment/model.test.ts src/ui/Drawer.test.tsx src/ui/Modal.test.tsx src/pages/assignment/DiscardChangesDialog.test.tsx
```

Expected: missing helpers/component/props fail for the new behavior.

- [ ] **Step 4: Implement the pure guards**

```ts
export function hasAssignmentDraft(name: string, phone: string, notes: string): boolean {
  return [name, phone, notes].some((value) => value.trim().length > 0)
}

export function hasSkipDraft(open: boolean, preset: SkipPreset | null, otherDetail: string): boolean {
  return open && (!!preset || otherDetail.trim().length > 0)
}

export function shouldConfirmDrawerClose(input: {
  formActive: boolean
  name: string
  phone: string
  notes: string
  skipOpen: boolean
  skipPreset: SkipPreset | null
  skipOtherDetail: string
}): boolean {
  return (input.formActive && hasAssignmentDraft(input.name, input.phone, input.notes))
    || hasSkipDraft(input.skipOpen, input.skipPreset, input.skipOtherDetail)
}
```

- [ ] **Step 5: Upgrade shared shells minimally**

Change `canCloseDrawer` to `!busy && !inactive`. Render `×` in the header button with `aria-label="Close Assign lead"`, disable it for either guard, and set the drawer section `inert` while `inactive` so the discard modal is the only active focus boundary.

Add refs in `Modal` so `initialFocus="cancel"` focuses the safe cancel action without changing the default focus behavior of existing callers. Map `submitTone="danger"` to `ui-btn-danger`; keep default `primary`.

Update the stale `Modal` comment so it describes a shared confirmation primitive rather than “the one modal in the app.” Raise `.ui-modal-backdrop` above the drawer (`z-index: 110`, with the drawer remaining at 90) so discard and Void confirmations cannot render behind the shelf.

Create `DiscardChangesDialog`:

```tsx
export function DiscardChangesDialog({ open, onKeepEditing, onDiscard }: {
  open: boolean
  onKeepEditing: () => void
  onDiscard: () => void
}) {
  return (
    <Modal
      open={open}
      title="Discard unsaved changes?"
      onClose={onKeepEditing}
      onSubmit={onDiscard}
      submitLabel="Discard changes"
      submitTone="danger"
      cancelLabel="Keep editing"
      initialFocus="cancel"
      hint="Keep editing preserves everything in this drawer."
    >
      <p>Closing will clear the information you entered.</p>
    </Modal>
  )
}
```

- [ ] **Step 6: Run focused checks**

```bash
pnpm --filter @phoneup/web exec vitest run src/pages/assignment/model.test.ts src/ui/Drawer.test.tsx src/ui/Modal.test.tsx src/pages/assignment/DiscardChangesDialog.test.tsx
pnpm --filter @phoneup/web typecheck
pnpm --filter @phoneup/web lint
git diff --check
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/assignment/model.ts apps/web/src/pages/assignment/model.test.ts apps/web/src/ui/Drawer.tsx apps/web/src/ui/Drawer.test.tsx apps/web/src/ui/Modal.tsx apps/web/src/ui/Modal.test.tsx apps/web/src/pages/assignment/DiscardChangesDialog.tsx apps/web/src/pages/assignment/DiscardChangesDialog.test.tsx apps/web/src/styles/ui.css
git commit -m "feat(assignments): guard drawer draft closure"
```

---

### Task 3: Build the complete assignment workspace in the drawer

**Files:**
- Create: `apps/web/src/pages/assignment/AssignmentDrawer.tsx`
- Create: `apps/web/src/pages/assignment/AssignmentDrawer.test.tsx`
- Modify: `apps/web/src/styles/ui.css`

**Interfaces:**

```ts
export type AssignmentDrawerProps = {
  open: boolean
  onClose: () => void
  onOpenRep?: (repId: string) => void
}

export type AssignmentResultProps = {
  result: AssignResult
  repName: string | null
  phoneE164: string
  canSkip: boolean
  canVoid: boolean
  busy: boolean
  skipEditorOpen: boolean
  onSkip: () => void
  onVoid: () => void
  children?: ReactNode
}

export function isAssignmentBusy(assigning: boolean, skipping: boolean, voiding: boolean): boolean
```

The component owns assignment form state, result phone, roster/realtime state, inline Skip state, Void state, mutation keys, and the discard dialog. It uses unchanged endpoints `board.roster`, `assignment.assign`, `assignment.skip`, and `assignment.void`.

- [ ] **Step 1: Write failing lifecycle/result tests**

Add tests for:

```tsx
it('renders a rep-first saved result and no clipboard affordance', () => {
  const html = renderToStaticMarkup(createElement(AssignmentResult, {
    result: assignedResult,
    repName: 'Raul Valle',
    phoneE164: '+13015550142',
    canSkip: true,
    canVoid: true,
    busy: false,
    skipEditorOpen: true,
    onSkip: () => {},
    onVoid: () => {},
    children: createElement('p', null, 'Inline Skip editor'),
  }))
  expect(html.indexOf('Raul Valle')).toBeLessThan(html.indexOf('Kev Tom'))
  expect(html).toContain('(301) 555-0142')
  expect(html).toContain('Inline Skip editor')
  expect(html).not.toContain('Copy phone')
  expect(html).not.toContain('Alt+C')
})

it('treats every assignment mutation as close-blocking', () => {
  expect(isAssignmentBusy(true, false, false)).toBe(true)
  expect(isAssignmentBusy(false, true, false)).toBe(true)
  expect(isAssignmentBusy(false, false, true)).toBe(true)
  expect(isAssignmentBusy(false, false, false)).toBe(false)
})
```

- [ ] **Step 2: Run and verify RED**

```bash
pnpm --filter @phoneup/web exec vitest run src/pages/assignment/AssignmentDrawer.test.tsx
```

Expected: the drawer workspace module is missing.

- [ ] **Step 3: Move the proven assignment lifecycle without clipboard behavior**

Move roster load/retry, realtime refresh, field validation, keyboard progression, idempotency, mutation error translation, duplicate/unassigned guidance, and Alt+V from `AssignScreen`.

Do not import `digitsOnly` or `useClipboardStore`. Do not recreate `lastCopiedPhone`, clipboard writes, copied notices, Copy phone, assignment Alt+C, or `copyOutcomeMessage`.

Place the primary Assign action beneath Notes. Store the normalized phone in `resultPhoneE164` on successful assignment and preserve it across repeated Skip results; clear it only on Void or drawer unmount.

- [ ] **Step 4: Implement controlled inline Skip state**

Use these state transitions:

```ts
function openSkip() {
  if (!lastResult?.assignedRepId || !canSkip || busy) return
  setSkipEditorOpen(true)
  setSkipPreset(null)
  setSkipOtherDetail('')
  setSkipError(null)
  setSkipKey(crypto.randomUUID())
}

function cancelSkip() {
  if (skipping) return
  setSkipEditorOpen(false)
  setSkipPreset(null)
  setSkipOtherDetail('')
  setSkipError(null)
  setSkipKey('')
}
```

`handleSkip(reasonNote)` passes the same lead with `expectedRepId` and the current key. On success, update `lastResult`, collapse/reset the editor, and refresh roster. On failure, keep the editor, preset, detail, key, and friendly inline error for retry. Opening Skip again for the new rep creates a new UUID.

- [ ] **Step 5: Implement the shared close request**

```ts
const busy = isAssignmentBusy(assigning, skipping, voiding)
const dirty = shouldConfirmDrawerClose({
  formActive: lastResult === null,
  name,
  phone,
  notes,
  skipOpen: skipEditorOpen,
  skipPreset,
  skipOtherDetail,
})

function requestClose() {
  if (busy) return
  if (dirty) {
    setDiscardChangesOpen(true)
    return
  }
  onClose()
}
```

Pass `requestClose` to `Drawer`, `busy` to its busy prop, and `discardChangesOpen || voidReasonOpen` to its inactive prop. This blocks the drawer's X/backdrop/Escape while either legitimate nested confirmation owns focus. `Keep editing`, discard-dialog backdrop, and discard-dialog Escape call `setDiscardChangesOpen(false)`. `Discard changes` closes the dialog and calls the app-shell `onClose`; unmounting clears every local state value. A saved result with no open Skip draft is clean even if submitted form strings remain in state.

- [ ] **Step 6: Render the two-column workspace**

The left work column renders the form or `AssignmentResult`. When `skipEditorOpen`, render `SkipReasonEditor` beneath the still-visible result. The right column renders `RosterPanel`. The desktop grid is `minmax(0, 1.1fr) minmax(320px, .9fr)` and becomes one column at 700px with work before roster.

While the inline editor is open, omit the result's `Skip rep` action so a second click cannot reset a reason in progress. Cancel or successful Skip collapses the editor and makes `Skip rep` available again.

- [ ] **Step 7: Run feature checks**

```bash
pnpm --filter @phoneup/web exec vitest run src/pages/assignment/model.test.ts src/pages/assignment/RosterPanel.test.tsx src/pages/assignment/SkipReasonEditor.test.tsx src/pages/assignment/DiscardChangesDialog.test.tsx src/pages/assignment/AssignmentDrawer.test.tsx
pnpm --filter @phoneup/web typecheck
pnpm --filter @phoneup/web lint
git diff --check
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/assignment/AssignmentDrawer.tsx apps/web/src/pages/assignment/AssignmentDrawer.test.tsx apps/web/src/styles/ui.css
git commit -m "feat(assignments): move assignment workflow into drawer"
```

---

### Task 4: Integrate the drawer into the app shell and remove the page

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.ts`
- Delete: `apps/web/src/pages/AssignScreen.tsx`
- Delete: `apps/web/src/pages/AssignScreen.test.ts`

**Interfaces:**

```ts
export type Page = 'staff' | 'dashboard' | 'users' | 'audit' | 'me' | 'rep' | 'import' | 'password'
export function landingPage(role: Role): Page
export function canOpenAssignmentDrawer(canAssign: boolean, viewAsUserId: string | null): boolean
export function repBackPage(origin: Page | null, role: Role): Page
```

- [ ] **Step 1: Write failing role and drawer-action tests**

```ts
it('lands non-Reps on Team Dashboard and Reps on My Dashboard', () => {
  expect(landingPage('ADMIN')).toBe('dashboard')
  expect(landingPage('MANAGER')).toBe('dashboard')
  expect(landingPage('BDC')).toBe('dashboard')
  expect(landingPage('REP')).toBe('me')
})

it('does not expose assignment actions during View-as', () => {
  expect(canOpenAssignmentDrawer(true, null)).toBe(true)
  expect(canOpenAssignmentDrawer(true, 'viewed-user')).toBe(false)
  expect(canOpenAssignmentDrawer(false, null)).toBe(false)
})

it('uses role-safe rep-detail fallback', () => {
  expect(repBackPage(null, 'BDC')).toBe('dashboard')
  expect(repBackPage(null, 'REP')).toBe('me')
})
```

- [ ] **Step 2: Run and verify RED**

```bash
pnpm --filter @phoneup/web exec vitest run src/App.test.ts
```

- [ ] **Step 3: Replace route state with drawer state**

Initialize `page` to `dashboard`, derive the effective role-safe landing page after session load, remove `assign` from `Page`, and replace every password/View-as/rep fallback that used `assign` with `landingPage(role)`.

Render a primary global header button only when `canOpenAssignmentDrawer(canAssign, viewAsUserId)`. Mount `AssignmentDrawer` after the app shell. While open, set the nav/banner/main wrapper inert. `onOpenRep` closes the drawer and uses the existing rep-detail origin behavior.

Show `My Dashboard` only for the effective REP role. Show `Team Dashboard` for non-Rep roles with `board.view`. Preserve all unrelated navigation and profile behavior.

- [ ] **Step 4: Delete the superseded page and scan references**

```bash
rg -n "AssignScreen|activePage === 'assign'|setPage\('assign'\)|SkipDialog|copyOutcomeMessage|navigator\.clipboard|Copy phone|Alt\+C" apps/web/src
```

Expected: no assignment-workspace matches. Rep Dashboard/Rep Detail phone-copy controls may still match outside assignment paths and must remain.

- [ ] **Step 5: Run the full web gate**

```bash
pnpm --filter @phoneup/web test
pnpm --filter @phoneup/web typecheck
pnpm --filter @phoneup/web lint
pnpm --filter @phoneup/web build
git diff --check
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.ts apps/web/src/pages/AssignScreen.tsx apps/web/src/pages/AssignScreen.test.ts
git commit -m "feat(navigation): open assignments from the app header"
```

---

### Task 5: Reconcile documentation and run final proof

**Files:**
- Modify: `docs/Revised consolidated action list.md`
- Verify: every file changed by this plan and completed predecessor tasks.

**Execution workspace:** After Task 4 passes its review gate, the controller must inspect `git diff --name-only main..codex/assignment-drawer` and confirm `docs/Revised consolidated action list.md` is absent. Then fast-forward `main` to the reviewed branch with `git merge --ff-only codex/assignment-drawer`. The user's existing unstaged action-list edit remains in the main checkout because Tasks 1–4 do not touch that file. Run Task 5 from `/Users/seandm/Projects/1_PHONE_RR` on `main`, reconcile that live edit, and commit only after verification.

- [ ] **Step 0: Integrate reviewed implementation without touching the user document**

From the main checkout:

```bash
git diff --name-only main..codex/assignment-drawer
drawer_merge_tmp=$(mktemp -d)
git diff -- docs/Revised\ consolidated\ action\ list.md > "$drawer_merge_tmp/action-list-before.patch"
git merge --ff-only codex/assignment-drawer
git diff -- docs/Revised\ consolidated\ action\ list.md > "$drawer_merge_tmp/action-list-after.patch"
cmp "$drawer_merge_tmp/action-list-before.patch" "$drawer_merge_tmp/action-list-after.patch"
```

Expected: the branch range does not contain the action list, the fast-forward succeeds, and `cmp` proves the user's unstaged action-list diff is byte-for-byte unchanged. Leave the temporary evidence directory in place until final handoff, then report its exact path so it can be removed safely. Stop instead of stashing or overwriting if those conditions are not true.

- [ ] **Step 1: Run affected automated gates before documentation claims**

```bash
git diff --check
pnpm --filter @phoneup/api exec vitest run src/routers/board.test.ts src/domain/assignLead.test.ts src/domain/skipLead.test.ts --no-file-parallelism
pnpm --filter @phoneup/web test
pnpm typecheck
pnpm --filter @phoneup/web lint
pnpm --filter @phoneup/web build
```

Expected: affected API tests, all web tests, workspace typecheck, lint exit, build, and diff check pass.

- [ ] **Step 2: Run and attribute the full serial API suite**

```bash
pnpm --filter @phoneup/api exec vitest run --no-file-parallelism
```

If the known four `voidLead.test.ts` failures remain, run that exact file at merge base `f283f9c` before classifying them as baseline. Do not broaden this task to repair unrelated failures.

- [ ] **Step 3: Run the authenticated local BDC browser flow**

Using Playwright CLI and the test database:

1. Verify BDC lands on Team Dashboard and sees header `Assign lead`.
2. Open the drawer; verify Customer name focus, inert app shell, top-right X, and work-before-roster layout.
3. Enter whitespace-only values and verify X, backdrop, and Escape close immediately.
4. Enter a real character in each assignment field one at a time. For X, backdrop, and Escape, verify `Discard unsaved changes?`, exact message, initial focus on `Keep editing`, safe button/backdrop/Escape preservation, and explicit destructive discard.
5. Assign a lead; verify Assign is beneath Notes, the rep name dominates, customer plus formatted phone follows, and no clipboard call/button/notice/Alt+C exists.
6. Verify the saved result closes cleanly. Reopen and create another assignment for remaining Skip checks.
7. Expand inline Skip beneath the result; verify no nested Skip dialog, all five presets, Other detail requirement, selection without auto-submit, and one explicit confirmation.
8. Begin a Skip draft and verify X/backdrop/Escape use the same discard guard. Keep editing and confirm the reason remains unchanged.
9. Submit Skip; verify the same lead passes, the drawer stays open, editor collapses, new rep is emphasized, and the skipped rep is first in one neutral Served This Round list with only the yellow badge.
10. Expand Skip again to prove repeatability, then Cancel and confirm the drawer stays open.
11. Verify mutation-time X/backdrop/Escape blocking, focus restoration, Manager/Admin access, REP absence, View-as absence, and full-screen narrow layout.

Do not deploy or touch production.

- [ ] **Step 4: Reconcile the action list**

Preserve the user's intent while replacing the temporary incomplete note with evidence-backed items:

```md
- [x] Replace the dedicated Assign page with a global BDC+ assignment drawer containing the form and live roster.
- [x] Keep preset Skip reasons inline beneath the assignment result with deliberate confirmation and Audit Log-only reason visibility.
- [x] Guard X, backdrop, and Escape against losing non-whitespace assignment or Skip drafts; saved and clean state close normally.
- [x] Restore the primary Assign action beneath the form and preserve submit-time-only rotation locking.
- [x] Make assignment confirmation rep-first, show customer plus phone, and remove assignment-workspace clipboard behavior.
- [x] Present skipped reps first inside one neutral Served This Round list with a compact Skipped badge.
```

Record exact local tests/browser proof, Node version, and that deployment/production verification remain outstanding.

- [ ] **Step 5: Inspect final scope**

```bash
git status --short
git diff --stat f283f9c..HEAD
git diff --check f283f9c..HEAD
rg -n "SkipDialog|navigator\.clipboard|Copy phone|Alt\+C|copyOutcomeMessage" apps/web/src/pages/assignment apps/web/src/App.tsx
```

Expected: no stale modal/clipboard matches in the assignment workspace; only intended tracked changes and the protected main-checkout user edit remain.

- [ ] **Step 6: Commit documentation**

```bash
git add docs/Revised\ consolidated\ action\ list.md
git commit -m "docs(assignments): record drawer workflow completion"
```

- [ ] **Step 7: Final handoff**

Report commits integrated onto `main`, nothing pushed, automated/browser results, Node 26.5.0 versus declared 22.x if unchanged, parent-reproduced API failures, the production-verification boundary, and preserved user-owned files.
