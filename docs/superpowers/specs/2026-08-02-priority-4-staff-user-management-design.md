# Priority 4 staff and user management — design

## Decision

Priority 4 is a focused Staff List and User Management pass. It preserves the recently
completed assignment drawer, role-aware navigation, Management menu, page-heading focus,
responsive menu containment, AA color corrections, authentication recovery, password
visibility controls, dynamic announcements, and read-only Admin View-as behavior.

The old Priority 4 wording is partly stale. The store rule is already one optional recurring
day off, Monday through Saturday, and the server already enforces it. This pass does not
restore multi-day selection. It does change the presentation from always-visible,
immediately saved radios to one page-wide edit mode with staged Save/Cancel behavior.

This pass also corrects a status-authority rule discovered while reviewing the Staff List:
a manual activation is not an exemption from the activity requirement. A failing activity
report can deactivate a rep whom a manager manually activated. Activity reports never
reactivate reps; a passing report only leaves an already-active rep active.

## Current state

### Already complete and retained

- Staff List already has atomic bulk Reactivate/Deactivate actions, preset reasons,
  target-state no-op checks, per-rep actions, selection reconciliation, and one audit event
  per applied rep.
- Recurring days off already use one None/Mon–Sat radio group per rep, a batch read through
  `rep.allDaysOff`, a server-side at-most-one rule, and future-only shift materialization.
- User Management already separates enabled and inactive accounts, sorts both tables,
  prevents self-role changes, masks administrator-entered passwords, generates a temporary
  password server-side, and forces users to replace every administrator-issued password.
- Staff and user load failures already expose Retry; mutation outcomes already use alert or
  status live regions.
- User Management and Audit Log already live in the Manager+ Management menu. The page route
  is named User Management even though the page heading still says Users.

### Genuinely open

- The Staff List bulk toolbar is invisible until a checkbox is selected.
- The always-visible day-off radios create table clutter and make an accidental schedule
  change possible with one click.
- Neither management page explains its distinct operational purpose.
- User Management action labels do not explain the difference between generated and manually
  entered temporary passwords.
- Missing display-name copy looks like an instruction even though it is not interactive.
- Sort state belongs on the column header but is currently communicated only by arrow glyphs.
- Repeated row controls do not consistently name the affected rep or account.
- Manual status changes refresh only the initiating Staff List, while an activity-import
  deactivation publishes a realtime board refresh.
- Activity evaluation currently skips every `MANAGER_OVERRIDE`, and the import writer refuses
  to replace one. That incorrectly protects a manual activation from a later failing report.

## Goals

1. Make normal Staff List scanning compact and safe while keeping days-off editing quick.
2. Make bulk status actions discoverable before selection.
3. Explain the boundary between Staff List and User Management.
4. Make password actions and forced-change behavior clear before a manager clicks.
5. Give table sorting and repeated controls complete accessible names.
6. Give Staff List manual status mutations the same realtime refresh behavior as an
   activity-import deactivation.
7. Make a failing activity report authoritative over an earlier manual activation without
   allowing any report to reactivate a manually deactivated rep.

## Non-goals

- No navigation reordering, menu redesign, color-token change, assignment change, or new
  page-level responsive pattern.
- No database migration or recurring-day-off policy configuration.
- No multi-day recurring absence. PTO, SICK, and TRAINING remain dated shift kinds.
- No bulk account operations, display-name editor, or production display-name backfill.
- No change to password hashing, recovery tokens, account eligibility, role permissions, or
  the generic responses used to prevent account enumeration.
- No activity-import auto-reactivation. Passing the call requirement never turns an inactive
  rep active.
- No global navigation guard for an unsaved days-off draft. Cancel is the deliberate in-page
  discard action; leaving Staff List also discards uncommitted form state without changing
  server data.

## Staff List presentation

The heading stays **Staff List**. Directly below it, add:

> Manage rotation status, availability overrides, and one recurring day off for each rep.

When bulk selection is empty, show a persistent muted instruction near the table controls:

> Select reps with the checkboxes to reactivate or deactivate several at once.

The existing selected-count toolbar replaces that instruction after the first selection. Its
actions, confirmation modal, preset reasons, atomic status behavior, and Clear action remain
unchanged.

Above the recurring-day-off column, show this edit guidance when the user can manage the
schedule:

> Choose None or one recurring day off, Monday through Saturday. Changes are saved together.

Read-only View-as never renders the Edit days off activator or editable radios.

## Page-wide recurring-day-off editor

### View mode

View mode is the default. The recurring-day-off cell contains text, not a form control:

- no stored day: **None**
- one stored day: its abbreviated weekday, such as **Wed**
- legacy multi-day state: the actual stored values plus **needs correction**, such as
  **Thu, Fri — needs correction**

The legacy state must never be collapsed visually to the first stored day. It remains
truthful until a manager resolves it.

One **Edit days off** button above the table enters edit mode. The button is available only
when `schedule.manage` is effective and the session is not in read-only View-as.

### Edit mode

Edit mode replaces every view-mode day value with the existing None/Mon–Sat radio group.
The draft is initialized from the loaded `rep.allDaysOff` result. A legacy multi-day row has
no selected radio and retains the instruction naming its stored values.

Changing a radio updates only the local day-off draft. It does not call `rep.setDaysOff`,
change rotation order, append an audit event, or materialize shifts.

The editor toolbar contains:

- a count such as **3 unsaved changes**;
- **Save days off**, disabled when nothing differs from the loaded baseline;
- **Cancel**, always available while no save is in flight.

Cancel discards the entire draft and returns to view mode. It does not require a confirmation
because no server state has changed.

### Refresh behavior

Realtime events continue to replace `board.roster` data while edit mode is open. Manual
Reactivate/Deactivate changes, bulk status changes, assignment events, and activity-import
deactivations all update visible roster and active-status data normally. No status or
availability field is copied into or protected by the days-off draft.

The only staged values are recurring-day-off selections. Draft entries are keyed by active
rep ID: a rep removed from the refreshed roster is removed from the draft, and a newly
appearing rep is initialized from the latest saved day-off response. Save sends only rows
that still exist in the current roster and differ from their current loaded baseline.

### Save lifecycle

Save submits the full new value for every changed rep in one request. While it is pending:

- the radio groups, Save, and Cancel are disabled;
- the submit label reads **Saving…**;
- a repeated activation cannot issue a second request.

On success, the returned values become the new baseline, edit mode closes, and a polite live
status announces **Recurring days off saved for N reps.** One successful save publishes one
realtime eligibility update so other connected clients refresh.

On failure, the editor stays open, the draft remains intact, and the existing alert region
shows a user-facing error. The manager can correct the draft, retry, or cancel.

## Batch days-off contract and transaction

Add a contract for a bounded batch of complete per-rep selections:

```ts
{
  changes: Array<{
    repId: string
    daysOfWeek: number[]
  }>
}
```

Requirements:

- `changes` contains 1–200 entries with unique UUID rep IDs.
- Each `daysOfWeek` is the complete requested set, not a toggle operation.
- The domain normalizes each set by dropping Sunday, rejecting values outside 0–6, deduping,
  and sorting before enforcing at most one working day.
- Every target must still be an active roster rep when the locked transaction runs. An
  unknown or inactive target rejects the whole request as stale.

Add `rep.bulkSetDaysOff` under `schedule.manage`. Extract one transaction-aware application
helper so `rep.setDaysOff` can remain backward compatible without duplicating the rule.

The batch mutation takes the existing rotation advisory lock once. Within one database
transaction it:

1. validates every target and normalized selection;
2. reads every current recurring-day-off value;
3. skips values that are already identical;
4. replaces the rows for every changed rep;
5. appends one `rep.days_off.set` event per changed rep with the same before/after shape used
   today;
6. re-materializes generated future shifts for all changed reps while retaining the same
   transaction and lock.

Extract a locked, transaction-aware shift-materialization helper from the existing public
`materializeShifts` wrapper. The wrapper retains its current transaction-and-lock behavior;
the days-off batch calls the helper directly so a failed re-materialization rolls back the
day-off rows and their audit events as one unit. Past shifts and manual PTO/SICK/TRAINING
rows remain untouched.

Return the normalized saved values and changed rep IDs. The client uses the response rather
than assuming its draft was accepted.

## Status refresh and activity authority

### Realtime publication

After their transaction commits, `rep.overrideStatus` and `rep.bulkOverrideStatus` each
publish one `ELIGIBILITY_UPDATED` event on the existing board realtime channel. Publication
must remain outside the database transaction. The initiating Staff List may still call its
local refresh; duplicate refresh prompts are safe because both reads are authoritative and
side-effect free.

This makes manual activation/deactivation visible to connected Staff Lists, dashboards, and
assignment rosters in the same way as an activity-import deactivation.

### One-way activity precedence

Replace the blanket “manager override always wins” rule with an outcome-specific rule:

- A `MANAGER_OVERRIDE` **ELIGIBLE** row remains eligible only until authoritative activity
  evaluation says the rep is ineligible.
- A failing activity result may replace that row with `SYSTEM` **INELIGIBLE** and apply the
  existing through-Saturday ineligible tail.
- A passing activity result performs no activation write. It leaves an already-active rep
  active and never replaces a `MANAGER_OVERRIDE` **INELIGIBLE** row.
- A manually deactivated rep remains inactive until a manager explicitly reactivates them.

Apply the rule consistently in both eligibility paths:

- `prepareDailyActivity` no longer excludes an existing manager override merely because of
  its source. A manager-active rep is evaluated normally. A manager-inactive rep may remain
  listed as not actionable because the import cannot reactivate them.
- The activity-import status upsert may overwrite manager-active with system-inactive, but
  it must not overwrite manager-inactive with eligible.
- `evaluateRepEligibility` uses the same outcome rule, so a background evaluation cannot
  disagree with the reviewed import path.

`LOG_ONLY` remains exactly that: it writes activity and eligibility evidence without changing
any status. Preview-token freshness, the shared advisory lock, manager review, and the choice
between `LOG_ONLY` and `LOG_AND_DEACTIVATE` remain unchanged.

Update the precedence statement in `CLAUDE.md`; it currently says a manager override always
wins and explicitly instructs maintainers to preserve that behavior.

## User Management presentation

Change the page heading from **Users** to **User Management** and add:

> Manage accounts, roles, temporary passwords, and sign-in access.

Retain the Enabled accounts and Inactive accounts sections. Account disabled continues to
mean the user cannot sign in; rep inactive continues to mean the employee is temporarily out
of rotation. This pass does not merge those concepts or change either filter.

Use these labels:

| Current | New |
|---|---|
| Reset password | Generate temporary password |
| Set manually | Set temporary password… |
| TEMP PASSWORD | PASSWORD CHANGE REQUIRED |
| Set name | (no display name) |

The missing-name copy stays muted and non-interactive.

The Add account initial-password hint and the manual-reset modal both state that an
administrator-issued password is temporary and the user must replace it at next sign-in.
The generated-password result retains its shown-once warning, copy control, forced-change
explanation, and password-not-stored-in-readable-form explanation.

All password inputs remain `PasswordInput` fields with field-specific Show/Hide labels and
`autocomplete="new-password"`. This pass must not restore plain-text password inputs.

## Accessible table controls

Extend the shared `Table` header API backward-compatibly so a caller can place
`aria-sort="ascending"` or `aria-sort="descending"` on the active `<th>`. Inactive sortable
headers omit `aria-sort`. Visible arrow glyphs remain as a sighted cue, but they are not the
only state communication.

Each sort button is named **Sort by [column]**. Repeated controls name their target:

- **Role for Taylor Reed**
- **Disable Taylor Reed** / **Enable Taylor Reed**
- **Generate temporary password for Taylor Reed**
- **Set temporary password for Taylor Reed**
- **Reactivate Taylor Reed** / **Deactivate Taylor Reed**
- **Recurring day off for Taylor Reed** on each row's radio group

Use display name when present and email as the accessible target fallback. Existing visible
cell copy still shows **(no display name)** rather than substituting email into the Name
column. The existing **Select Taylor Reed** and **Select all reps** checkbox names remain.

## Files and execution paths

Expected implementation surface:

- `apps/web/src/pages/StaffList.tsx`
- `apps/web/src/pages/StaffList.test.ts`
- `apps/web/src/pages/UserManagement.tsx`
- `apps/web/src/pages/UserManagement.test.ts`
- `apps/web/src/ui/index.tsx`
- `apps/web/src/ui/index.test.ts`
- `packages/contracts/src/schemas.ts`
- contract tests covering the new batch input
- `apps/api/src/routers/rep.ts`
- `apps/api/src/domain/daysOff.ts`
- `apps/api/src/domain/daysOff.test.ts`
- `apps/api/src/jobs/eligibility.ts`
- `apps/api/src/jobs/eligibility.test.ts`
- `apps/api/src/jobs/activityImportDecision.ts`
- `apps/api/src/jobs/activityImportDecision.test.ts`
- `apps/api/src/domain/overrideStatus.ts`
- `apps/api/src/domain/bulkOverrideStatus.ts`
- relevant realtime tests
- `CLAUDE.md`

No schema, migration, route-name, permission, or dependency change is expected.

## Validation

### Contract and API

- Batch input rejects duplicates, more than 200 rows, invalid IDs, invalid weekdays, and more
  than one normalized working day.
- Sunday is removed before the one-day count, preserving the existing `[0, 3] -> [3]` rule.
- A mixed valid batch writes all changed reps, skips identical values, appends one audit event
  per changed rep, and materializes all changed reps' future shifts.
- An invalid/stale target or injected mid-batch/materialization failure leaves day-off rows,
  generated shifts, and audit events unchanged.
- Past shifts and manual PTO/SICK/TRAINING rows survive.
- BDC and Rep callers cannot read or mutate schedule management endpoints.
- Manual single and bulk status changes publish once after commit and never publish after a
  rolled-back mutation.
- A failing report deactivates a manager-active rep and records system authority.
- A passing report leaves a manager-active rep active.
- Neither a passing nor failing report reactivates a manager-inactive rep.
- `LOG_ONLY` never changes status regardless of the prior decision source.
- Background eligibility and reviewed import produce the same result for manager-active and
  manager-inactive starting states.

### Web

- View mode renders compact saved values and truthful legacy multi-day copy, with no radios.
- Edit activates every row's group, initializes the draft, and performs no mutation on a
  radio change.
- Save is disabled for a clean draft, sends only changed active reps, blocks repeated submit,
  and exits with a live success announcement.
- Cancel restores the loaded values without a request.
- A save failure preserves the draft and displays an alert.
- Realtime roster/status updates render during edit mode without modifying day-off choices.
- Removed reps are excluded from the draft and save payload; new reps initialize safely.
- Read-only View-as has no day-off edit activator.
- Static-markup tests verify `aria-sort`, targeted row-control names, targeted radio-group
  names, password labels, and purpose copy.

### Full and browser verification

- Run focused contract, API, web, and realtime suites, followed by the full serial workspace
  test suite, type checking, web lint, production build, and `git diff --check`.
- Use the repository-declared Node 22.x for final validation, or explicitly record any
  mismatch.
- In an authenticated local browser, verify Manager and Admin behavior at 1024x768 and
  390x844: compact view mode, page-wide editing, dirty count, Save, Cancel, failure retention,
  bulk-action guidance, password-action distinctions, sort announcements, and target-specific
  accessible names.
- Recheck read-only Admin View-as and navigation/menu containment at both widths.
- Verify two connected clients receive manual status and saved day-off changes without a page
  reload.

Deployment and production verification are separate from this implementation pass and must
not be claimed from local evidence.

## Success criteria

Priority 4 is complete when normal Staff List scanning no longer exposes editable day-off
radios, a manager can stage and atomically save or cancel a page-wide edit, in-scope manual
status changes refresh connected clients, failing activity evidence can reverse manual
activation without ever auto-reactivating anyone, Staff List and User Management explain
their distinct jobs, password actions are unambiguous, and sortable/repeated controls expose
their state and target to assistive technology—without changing the recently completed
application navigation, assignment, authentication, permissions, responsive layout, or
visual tokens.
