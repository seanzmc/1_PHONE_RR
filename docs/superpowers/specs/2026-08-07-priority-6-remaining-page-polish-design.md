# Priority 6 remaining page polish — design

**Date:** 2026-08-07
**Status:** Proposed design, pending approval. No Priority 6 implementation or verification is
claimed by this document.

## Decision

Priority 6 is a bounded UI and read-model polish pass. It clarifies existing data, makes existing
navigation discoverable, makes clipboard feedback truthful, replaces internal import terminology
with manager language, and replaces front-facing audit UUIDs with legible record identities.

The pass does not change what any metric counts, who can view another rep, how an activity import is
evaluated or committed, how a status is changed, or what an audit event stores. It uses the existing
Dashboard summary, Rep Detail queries and mutations, Import Activity result, Staff List page state,
and an additive presentation layer on `audit.list`.

## Current state

### Already complete and retained

- Team Dashboard already loads month-to-date totals, current-cycle progress, today's ineligible and
  override counts, and per-rep ups. It preserves the last good summary through refresh failures and
  ignores stale request completions.
- `board.dashboardSummary` already defines the values. Phone-ups come from void-correct monthly
  counters; CRM sales are the sum of imported `sold` values; reassignments count `REASSIGN_IN`
  events; call-rule deactivations count distinct `WEEK_DQ` episodes; today's counts are limited to
  active rep accounts.
- Manager and Admin users already have `rep.view`; BDC and Rep users do not. The existing Rep Detail
  API correctly rejects attempts to open another rep without that permission.
- Rep Detail already uses digits-only clipboard text, shows manager/rep-specific status guidance,
  saves dirty notes, and keeps Rep note access read-only.
- Import Activity already has a side-effect-free preview, explicit log-only/deactivate/cancel
  outcomes, stale-preview protection, and an accurate committed `deactivatedCount`.
- Staff List is already the single audited place for lifting a suspension early.
- Audit Log already has readable actions and field-level summaries, retains raw before/after JSON
  under **Technical details**, and restricts the page to Manager and Admin users.

### Genuinely open

- Several Team Dashboard hints describe implementation terms rather than the user-facing meaning,
  and the two today metrics have no definition.
- Managers and Admins can select rep names on Team Dashboard, but the page gives no visible
  instruction that the names open Rep Detail. The same callback is currently supplied for roles
  whose API permission cannot open another rep.
- Rep Detail empty states describe an absence without explaining when content will appear. Editable
  note fields have no prompt.
- Rep Detail sets **Copied** before the clipboard promise resolves, swallows rejection, and never
  clears the success state.
- Three Import Activity summary rows use internal terminology, and a successful deactivation ends
  without a direct route to Staff List.
- Audit Log renders primary `entityId` values and UUID-valued rep fields such as `assignedRepId`,
  `skippedRepId`, and `repId` in the normal card even when the referenced account, rep, or lead has a
  legible identity.

## Goals

1. Explain every Team Dashboard metric in plain language without changing its query or value.
2. Make Manager/Admin rep drill-down visible and specific without exposing a dead-end control to BDC
   or Rep users.
3. Tell Rep Detail users when empty sections will populate and what an editable lead note is for.
4. Report clipboard success only after a resolved write, show a visible failure, and clear temporary
   success feedback.
5. Replace the remaining Import Activity jargon and take a manager directly to Staff List after real
   deactivations.
6. Keep UUIDs out of the normal Audit Log presentation whenever a truthful account, rep, lead,
   import, or policy label can be shown instead.

## Non-goals

- No database schema, migration, audit-event write, metric calculation, import decision,
  status-authority, realtime, or permission change. `audit.list` may add display-only resolution
  fields; its filters, ordering, pagination, stored event payload, and authority remain unchanged.
- No change to assignment ranking, cycle progress, monthly counters, or the meaning of an up.
- No decision about whether the CRM `Sold` column is daily or cumulative. The UI explains the
  application's current sum of imported values; real-report verification remains a separate
  operational gate.
- No lead-level Sold action or sales attribution work.
- No new router or URL-based navigation. The existing in-memory page state remains the navigation
  mechanism.
- No redesign of Staff List, the Assignment Drawer roster, Rep Detail tables, Import Activity
  preview/decision behavior, or non-primary button variants.
- No global clipboard abstraction or rewrite of other copy controls. Priority 6 fixes the named Rep
  Detail path only.
- No new icon or UI dependency.
- No actor/target snapshot migration. Audit labels resolve from current records; the immutable event
  UUIDs and raw payloads remain the durable identity under **Technical details**.
- No customer-name lead search, filter redesign, or inference that every UUID belongs to a rep.
- No shared `Card` or `Button` visual change.

## Team Dashboard

### Metric definitions

Keep the existing labels, values, grouping, period, and order. Replace or add the hint beneath each
value with the following copy:

| Metric | Required hint |
| --- | --- |
| **Phone-ups assigned** | **Phone-ups currently credited this month; voided assignments are removed.** |
| **CRM sales** | **Sum of the CRM Sold values imported for active reps this month.** |
| **Reassignments** | **Lead reassignments completed this month.** |
| **Call-rule deactivations** | **One per weekly call-rule suspension, not one per inactive day.** |
| **Cycle progress** | **Active reps served in the current rotation cycle; the cycle restarts after everyone is served.** |
| **Ineligible today** | **Active reps out of rotation today, for any reason.** |
| **Overrides today** | **Manager status changes recorded for today.** |

These hints explain the current backend response. Do not derive alternate values in the client or
add tooltips that hide the definition from keyboard or touch users.

### Rep drill-down affordance

For Manager and Admin users, place this visible muted instruction directly inside **Ups per rep
(this month)** before the list:

> Select a rep name to view their leads, activity, and status for the month.

Each selectable name remains a native button styled as a link. Add a visible trailing arrow to the
button and give it a target-specific accessible name such as **View Taylor Morgan's rep details**.
The numeric ups value and current descending order remain unchanged.

The drill-down affordance is conditional on `rep.view`, not merely `board.view`. `App.tsx` passes
`onOpenRep` to Team Dashboard only when the effective user can view another rep. BDC and Rep users
continue to see the team totals and plain rep names, but no drill-down instruction, arrow, or
interactive name that the server would reject. This is presentation-level permission alignment;
the existing server checks remain authoritative.

Selecting a Manager/Admin rep name uses the current `openRep` path, opens that rep's existing Rep
Detail screen, and retains the current return-to-Team-Dashboard behavior and page-heading focus.

## Rep Detail

### Empty states and note prompt

Replace the two empty states exactly:

- Leads: **No ups yet this month — new phone-ups appear here as they're assigned.**
- Daily activity: **Call numbers appear here after the daily CRM import.**

Add **Note for this lead…** as the placeholder for writable note textareas. The placeholder is a
prompt, not a stored value: it is never submitted unless the user types it. Read-only note rendering,
dirty detection, Save visibility, trimming/null behavior, audit logging, and permissions remain
unchanged.

### Clipboard feedback contract

Copy continues to write `digitsOnly(customerPhoneE164)`. The UI follows four explicit states:

1. **Idle:** the row button reads **Copy**.
2. **Pending:** after activation and before the promise settles, the attempted row reads
   **Copying…** and repeated copy activation is disabled.
3. **Success:** only a resolved `navigator.clipboard.writeText` changes that row to **Copied** and
   announces **Phone number copied.** through a polite status region.
4. **Failure:** rejection leaves the button as **Copy** and shows the visible alert **Couldn't copy
   the phone number. Select the number and copy it manually.** No success announcement is emitted.

Successful feedback clears after approximately two seconds, returning the button to **Copy**. A new
attempt clears prior copy feedback. The timer is replaced when a later success occurs and is cleaned
up when Rep Detail unmounts so an old callback cannot change a later screen. A failed attempt remains
visible until the user retries, navigates away, or another attempt replaces it.

Copy state stays local to Rep Detail and identifies the attempted lead. A late resolution from an
older attempt must not overwrite feedback for a newer attempt. Use the existing React state/effect
patterns; do not add a dependency or pretend a clipboard write succeeded through an unverified
fallback.

## Import Activity

### Summary language

Keep the table structure, counts, names, badges, result data, and zero-result dash. Change only the
three cryptic rows:

| Current presentation | Required presentation when count is nonzero |
| --- | --- |
| **Not in the file** / **0 unless manually corrected** | Row label **Reps missing from report**. Badge **No numbers found**. Detail: **This file had no activity numbers for these reps. The import records 0 unless a hand-entered correction already exists; correct their activity on the rep's page if they worked:** followed by the names. |
| **Unmatched names** / **not imported** | Row label **Names not matched to staff**. Badge **Not imported**. Detail: **These report names did not match a Staff List display name. Check the spelling:** followed by the names. |
| **Manual rows preserved** | Row label **Hand-entered corrections kept**. Detail: **This file did not overwrite saved corrections for:** followed by the names. |

The first sentence describes import behavior rather than eligibility. Missing, unmatched, and not
evaluated remain separate rows because they are distinct outcomes. Do not collapse them or change
the imported values.

### Staff List next step

`ActivityImport` accepts an `onOpenStaff` callback from `App.tsx`. After a committed
`LOG_AND_DEACTIVATE` result with `deactivatedCount > 0`, add this sentence to the success card:

> Suspensions run through Saturday. To reactivate someone early, open the Staff List.

Render **Open Staff List** as a real button beside **Process another report**. It invokes the callback
and uses the existing `setPage('staff')` navigation path. The Staff List heading receives the current
page-change focus behavior. Do not mutate or clear a status as part of navigation.

For `LOG_ONLY` and zero-deactivation results, retain the activity-logged success state and do not
show the suspension copy or Staff List action. **Process another report** retains its current local
reset behavior in every result state.

## Audit Log human-readable references

### Presentation rule

The normal event card must not show a raw UUID when the application can resolve a trustworthy human
identity. This applies to both the primary affected-record line and UUID values summarized from the
event's before/after payload.

The visible examples from the current screen become:

- **App user · `c0caf…`** becomes **Account · Sean McCann · seanzmc9613@gmail.com**.
- **Lead · `7bd69…`** becomes **Lead · Customer Name · (555) 123-4567** using that lead's customer.
- **Assigned Rep Id: `21600…` → `f5ae…`** becomes **Assigned rep: Rep Name A → Rep Name B**.
- **Skipped Rep Id: Not set → `21600…`** becomes **Skipped rep: Not set → Rep Name A**.

Use the current display name plus email for accounts. Use the sales rep display name plus their
linked account email for reps, so duplicate names remain distinguishable without exposing UUIDs.
Use customer name plus the existing readable phone format for leads. These are current-record labels,
not historical snapshots; the immutable ID remains available in Technical details.

### Additive `audit.list` read model

After the current filtered, ordered page has been selected, `audit.list` resolves only IDs present on
that page. Collect unique IDs and load their labels in bulk; do not issue a query per event or per
field.

Each returned item keeps its existing `entityType`, `entityId`, `before`, and `after` fields and adds:

```ts
{
  entityDisplay: {
    kind: string
    label: string
  }
  referenceLabels: Record<string, string> // UUID -> readable current-record label
}
```

The API builds `entityDisplay` by the event's actual meaning:

| Event target | Visible kind and label |
| --- | --- |
| `app_user` | **Account** · display name plus email, or email when no display name exists |
| `lead` | **Lead** · customer name plus readable phone number |
| `sales_rep` or `rep_daily_status` | **Rep** · rep display name plus linked account email |
| `rep_daily_activity` with `activity.metric.edit` | **Rep activity** · rep display name plus linked account email |
| `rep_daily_activity` with `activity.import` | **Activity import** · imported business date from the event payload |
| `work_requirement_policy` | **Activity policy** · **Call requirement settings** |

`activity.import` is deliberately special. Its stored `entityId` is an implementation anchor using
the first available rep, not a truthful claim that the import affected that rep. Never resolve that
anchor into a rep name in the visible card.

For the current payload inventory, collect rep references from `assignedRepId`, `skippedRepId`, and
`repId` in both `before` and `after`. Resolve them through `sales_rep` and its linked account. The
client uses `referenceLabels` only for UUID-shaped values and never guesses a record type from the
UUID itself.

If a current account, rep, lead, or customer record cannot be resolved, show **Record unavailable**
in the normal card. Do not fall back to a full or shortened UUID there. Unknown future entity types
retain a humanized kind plus **Record unavailable** until an explicit resolver is added.

### Event-card rendering

Replace the current right-side `{entity type} · {entityId}` metadata with
`{entityDisplay.kind} · {entityDisplay.label}`. Allow the label to wrap at narrow widths; preserve the
existing actor, timestamp, action label/code, card order, and responsive layout.

Make change-summary formatting field-aware:

- `assignedRepId` is labelled **Assigned rep**;
- `skippedRepId` is labelled **Skipped rep**;
- `repId` is labelled **Rep**;
- resolved UUID values use the corresponding `referenceLabels` value;
- null and missing values retain **Not set**;
- an unresolved UUID value reads **Record unavailable**, never the raw UUID.

Do not alter the stored before/after JSON. Expand **Technical details** to identify the raw
`entityType` and `entityId` alongside the existing raw Before and After blocks. This keeps exact IDs
available for support and database investigation without making them the primary interface.

The existing affected-record filters continue to submit canonical UUIDs internally. Their control
shape and exact Lead ID input are outside this presentation correction.

## Files and execution paths

Expected implementation surface:

- `apps/web/src/App.tsx`
- `apps/web/src/App.test.ts`
- `apps/web/src/pages/Dashboard.tsx`
- `apps/web/src/pages/Dashboard.test.ts`
- `apps/web/src/pages/RepDetail.tsx`
- `apps/web/src/pages/RepDetail.test.ts`
- `apps/web/src/pages/ActivityImport.tsx`
- `apps/web/src/pages/activityImportFlow.test.ts` or one focused Activity Import presentation test
- `apps/api/src/routers/audit.ts`
- `apps/api/src/routers/audit.test.ts`
- `apps/web/src/pages/AuditLog.tsx`
- `apps/web/src/pages/AuditLog.test.ts`

The implementation may keep presentation helpers in the existing page files rather than creating
new production modules. No contract package, database schema, migration, runbook, dependency, or
generated artifact should change.

## Validation

### Focused web tests

- Team Dashboard renders every exact metric hint above.
- With `onOpenRep`, the per-rep section renders its instruction, visible arrow, target-specific
  accessible name, current ups value, and callback target. Without it, names are plain text and the
  drill-down instruction and controls are absent.
- App wiring exposes Team Dashboard drill-down only when the effective role has `rep.view`; read-only
  View-as continues to use effective permissions.
- Rep Detail renders both exact empty states and the note placeholder without turning the
  placeholder into a draft value.
- A deferred clipboard promise shows pending state. Resolution alone produces **Copied** and the
  polite announcement; fake timers return it to **Copy** after approximately two seconds.
- Clipboard rejection never renders **Copied**, exposes the exact visible alert, and permits a retry.
  A stale older completion cannot replace a newer attempt's feedback.
- Import Activity renders the three required row labels, badges, and explanations for representative
  nonzero results while keeping the three outcomes separate.
- A committed nonzero deactivation renders **Open Staff List** and invokes the supplied callback.
  Log-only and zero-deactivation results do not render that action.
- `audit.list` resolves account, rep, lead, rep-activity, activity-import, and policy targets exactly
  as specified, using bounded bulk queries after pagination rather than N+1 lookups.
- Account, rep, and lead events retain raw IDs in the response but return legible
  `entityDisplay` values. Missing records return **Record unavailable**.
- `activity.import` uses its business date and never presents the storage-anchor rep as the affected
  person.
- `assignedRepId`, `skippedRepId`, and `repId` values resolve to rep names in visible change
  summaries, including different before/after reps. Null stays **Not set** and unresolved UUIDs do
  not leak into the normal card.
- Technical details retain the exact entity type/ID and raw before/after JSON. Existing permissions,
  filters, pagination, ordering, action labels, empty states, stale-data handling, and responsive
  diff behavior remain passing.

### Package checks

Run focused Audit router and web presentation tests while implementing. After the slice is complete,
use the repository-declared Node 22.x runtime and a guarded test database for the affected API path;
then run the web package's complete test suite, workspace typecheck, web lint, production build, and
`git diff --check`. Run one broader serial workspace suite only if the audit read-model change or
shared typing crosses beyond the focused proof.

### Browser verification

Use one authenticated local Manager flow at 1024x768 and 390x844:

1. Verify all Dashboard hints remain legible, cards retain the responsive grid, and rep names clearly
   open the intended Rep Detail and return to Team Dashboard.
2. Verify the two Rep Detail empty states, note placeholder, successful copy/reset, and a simulated
   clipboard rejection with visible manual-copy guidance.
3. Exercise representative Import Activity summary data for missing, unmatched, and preserved rows;
   commit a fixture deactivation and verify **Open Staff List** reaches the existing management page.
4. Open account, lead Skip/Reassign/Void, rep-status, metric-correction, activity-import, and policy
   events in Audit Log. Confirm the normal cards use the specified names and dates with no UUIDs,
   duplicate rep names remain distinguishable, and unresolved records say **Record unavailable**.
5. Expand Technical details and confirm the exact entity ID and unchanged raw Before/After payload
   remain available. At 390 pixels, long names/email/phone labels wrap without horizontal overflow.

Use one BDC or Rep Team Dashboard check to confirm rep names are non-interactive and no drill-down
instruction is shown. Retain prior proof for unchanged import decision, permissions, navigation,
responsive menus, and realtime behavior instead of repeating it.

Deployment and production verification are separate gates and must not be inferred from local tests
or browser evidence.

## Success criteria

Priority 6 is complete when every Team Dashboard count explains its current meaning, authorized rep
drill-down is visible without advertising forbidden navigation, Rep Detail empty and clipboard states
give truthful next steps, Import Activity uses manager-readable outcome language and links real
deactivations to Staff List, and Audit Log uses legible record identities instead of UUIDs in its
normal cards—without changing stored audit evidence, backend business rules, permissions, card/button
visuals, or the app's existing navigation model.
