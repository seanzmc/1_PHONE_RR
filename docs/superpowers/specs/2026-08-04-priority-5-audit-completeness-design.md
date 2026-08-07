# Priority 5 audit completeness

**Date:** 2026-08-04
**Status:** The backend checkpoint is implemented on `main` through `363af90`; do not reimplement
it. The Audit Log web slice was implemented locally on August 6, 2026 with focused tests, type
checking, lint, and a production build passing. The authenticated local Manager Audit Log flow
passed at desktop and true 390×844 mobile viewports, and the clean-database final integration gate
passed under Node 22.22.3. All requested local browser verification is complete; deployment and
production verification remain separate gates.

## Decision

Priority 5 completes the existing Manager/Admin Audit Log without changing its authority or
turning it into a second operational ledger.

This pass makes queued submissions idempotent, adds an audit event to each newly created lead in
the assignment transaction, makes the existing event stream filterable by action, actor, affected
record, and date, and replaces the creation-event dash with natural missing-state copy. It
preserves the append-only `audit_events` table, the assignment ledger as the source of truth for
rotation accounting, and the existing Manager/Admin-only `audit.view` permission.

Lead-level sold status remains deferred. This spec defines the audit requirement that a future
sold-status design must satisfy, but it does not add a Sold control, route, permission, lead
column, metric, or reconciliation rule.

## Current state

### Already complete and retained

- `audit_events` is append-only and stores actor, action, entity type/id, before/after JSON,
  and timestamp.
- `audit.list` requires `audit.view`, returns newest-first rows, retains inactive historical
  actors through a left join, and paginates 50 rows at a time.
- Audit Log presents readable action labels and short field-level summaries while retaining
  raw JSON under **Technical details**.
- Reassign, explicit Skip, Void, account access and role changes, password events, rep status,
  recurring days off, lead notes, activity imports and corrections, and policy changes already
  append audit rows.
- Priority 2's explicit operator Skip is recorded as `lead.skip`. Automatic eligibility skips
  in the assignment ledger are rotation mechanics, not separate manager actions, and remain
  outside `audit_events`.
- Reassign, Skip, and Void events use the lead as their primary affected entity.

### Implemented and verified backend checkpoint — do not reimplement

- `a6f5831`: `assignLead` appends the assigned or queued lead audit row and writes a zero-credit
  `QUEUE` ledger event carrying the original idempotency key for no-eligible outcomes.
- `bf9b8bd`: `audit.list` accepts the specified action, actor, primary affected record, and New
  York date filters; `audit.filterOptions` supplies the current native-select choices.
- `363af90`: `voidLead` ignores zero-credit `QUEUE` events when deciding whether a successor cycle
  has been consumed. When that successor is queue-only, it closes rather than deletes the
  successor to retain the append-only event's required cycle reference, then reopens the prior
  cycle. A truly empty successor retains the existing delete-and-reopen behavior.

### Implemented local web checkpoint

- `apps/web/src/pages/AuditLog.tsx` now stages action, actor, primary affected record, and date
  controls until Apply; Clear and Apply reset pagination, while paging retains committed filters.
- The page loads native-select choices from `audit.filterOptions`, accepts an exact lead UUID,
  clears a staged affected ID when its kind changes, and distinguishes filtered and unfiltered
  empty states.
- List refreshes retain the last successful rows, suppress stale request completions, disable
  repeated Apply/pagination while pending, announce updates through a polite status region, and
  retain a visible Retry path after failure.
- Creation, removal, missing-field, and unexpected-null states now use the specified natural
  language. `lead.assign` and `lead.queue` have explicit readable labels while unknown actions
  retain the existing humanized fallback.
- `apps/web/src/styles/ui.css` adds the responsive filter grid and narrow Audit Log containment;
  the existing top-aligned, stacking `ui-audit-diff` layout remains intact.

### Genuinely open

- No lead-level sold-status action exists. CRM-imported `rep_daily_activity.sold` is an aggregate
  and cannot yet be reconciled to individual leads.

## Goals

1. Make queued submissions idempotent and record each newly created lead exactly once in the same
   transaction that creates it.
2. Let a Manager or Admin narrow the Audit Log by exact action, exact actor, one affected rep,
   user, or lead, and an inclusive New York calendar-date range.
3. Keep filter results deterministic and offset pagination correct for a stable result set.
4. Make creation and removal states read naturally in both the summary and Technical details
   while preserving the current responsive diff layout.
5. Establish a mandatory audit contract for any later lead sold-status feature without
   implementing or pre-deciding that feature.

## Non-goals

- No Sold button, lead sold field, sale-attribution rule, CRM reconciliation, dashboard metric,
  or new permission.
- No changes to assignment ranking, cycle order, counters, or realtime publication. The only
  assignment-ledger change is the zero-credit `QUEUE` event required to protect queued
  idempotency; the ledger's accounting and reconciliation rules do not change.
- No audit export, retention policy, bulk deletion, editing, or hash chain.
- No BDC or Rep access to Audit Log.
- No full-text search across raw JSON and no inference of affected records from arbitrary JSON
  keys.
- No actor-name or target-name snapshot migration. Historical labels continue to resolve from
  current records, with an ID fallback when a record can no longer be resolved.
- No database migration or dependency is expected. Add an index only if a measured query plan
  shows the existing internal-store volume needs one.

## Lead creation audit contract

### Actions

`assignLead` records one of two human actions for a newly created lead:

| Result | Audit action | Readable label |
|---|---|---|
| Lead assigned to a rep | `lead.assign` | Assigned lead |
| Lead retained because nobody is eligible | `lead.queue` | Queued unassigned lead |

Both use:

```ts
{
  actorUserId: input.actorUserId,
  entityType: 'lead',
  entityId: lead.id,
  before: null,
  after: {
    status: 'ASSIGNED' | 'UNASSIGNED',
    assignedRepId: string | null,
    assignmentMode: 'ROTATION' | 'MANAGER_OVERRIDE' | 'NO_ELIGIBLE_REP'
  }
}
```

`assignmentMode` is `MANAGER_OVERRIDE` only when a supplied `forcedRepId` is accepted,
`ROTATION` for the normal ranked selection, and `NO_ELIGIBLE_REP` for the unassigned queue.
The payload does not duplicate customer name, phone, notes, the ranking snapshot, or the
idempotency key. Those values either contain unnecessary customer data or belong to the
operational lead/assignment records rather than the human-facing audit summary.

### Atomicity and idempotency

The audit insert occurs inside the existing advisory-locked `assignLead` transaction, after
the lead has been created and before the transaction returns. A failed audit insert rolls back
the customer/lead, queue or cycle rows, assignment ledger, and counters with the rest of the
operation.

The no-eligible path also appends an `assignment_events` row with `eventType = 'QUEUE'`, the queued
lead ID, `repId = null`, the current cycle ID and queue snapshot, `creditDelta = 0`, and the
submission's original idempotency key. `QUEUE` is added to the Drizzle text-enum typing; the
database column is already text, so this requires no migration. It neither consumes a cycle slot
nor changes a counter, and reconciliation continues to use the sum of `creditDelta`.

Every cycle-state consumer must likewise treat `QUEUE` as non-consuming. In particular,
`voidLead`'s check for activity in the open successor cycle must ignore `QUEUE` rows. When voiding
the assignment that closed the prior cycle, a queue-only successor is closed rather than deleted
because its append-only `QUEUE` row has a required cycle foreign key; a truly empty successor is
still deleted. `ASSIGN`, automatic cycle `SKIP`, and other genuinely cycle-consuming events retain
their existing behavior.

The existing idempotency short-circuit remains first and now finds both assigned and queued
outcomes. Reusing either completed outcome's idempotency key returns its prior lead without
appending a ledger or audit row. Realtime publication remains after commit and is unchanged.

This event complements rather than replaces `assignment_events`: the assignment ledger remains
authoritative for credits, skips, cycle membership, and rotation reconstruction.

## Filter contract

### `audit.list` input

Extend the current input backward-compatibly:

```ts
{
  limit?: number                 // existing 1-100, default 50
  offset?: number                // existing non-negative offset
  action?: string                // exact audit action
  actorUserId?: string           // exact app_user UUID
  affected?: {
    kind: 'USER' | 'REP' | 'LEAD'
    id: string                   // exact UUID
  }
  fromDate?: string              // YYYY-MM-DD
  toDate?: string                // YYYY-MM-DD
}
```

Empty strings are omitted by the client, UUIDs and real calendar dates are validated, and a
range with `fromDate > toDate` is rejected. Either date may be supplied alone.

All predicates combine with AND. Ordering stays `created_at DESC, id DESC`, and `hasMore` is
computed only after applying every predicate. `offset` therefore belongs to the committed
filter set, not to the unfiltered stream. Pages have no duplicates or omissions while that result
set remains stable. A newly appended event between page requests may shift offsets; live-stream
snapshot pagination or cursor pagination is outside this internal-tool pass.

The date controls are inclusive New York calendar dates. The API compares `created_at` against
PostgreSQL-computed boundaries: `fromDate::date::timestamp AT TIME ZONE 'America/New_York'` as the
inclusive lower bound, and `(toDate::date + 1)::timestamp AT TIME ZONE 'America/New_York'` as the
exclusive upper bound. The strings are validated as real calendar dates before the query. This
must not rely on JavaScript date conversion or the API host, browser, or database session
timezone.

### Affected-record meaning

Affected-record filtering is based on the event's primary `entityType` and `entityId`, not on
incidental IDs inside before/after JSON:

| Filter kind | Matching audit entity types |
|---|---|
| `USER` | `app_user` |
| `REP` | `sales_rep`, `rep_daily_status`, and `rep_daily_activity` for `activity.metric.edit` |
| `LEAD` | `lead` |

Bulk `activity.import` events are excluded from REP matching. Their current entity ID is a
required storage anchor, not a truthful claim that the import affected only that rep. Policy
events do not match an affected user/rep/lead filter.

This definition means a lead assignment is found by selecting the lead, while the assigned rep
remains visible in its change summary. Making one event belong to several filter targets would
require a normalized audit-subject relation and is outside this pass.

### Filter choices

Add one Manager/Admin-only read procedure under the existing audit router:

- `audit.filterOptions` returns distinct action values present in `audit_events`, distinct actors
  who have events, and current users and reps for the affected-record selects. Actors include
  inactive accounts and use display name with email fallback; an unresolved historic actor uses
  its UUID. Current user/rep labels include a short ID suffix where needed to distinguish duplicate
  visible labels. Actions are sorted by readable label and people by displayed identity.

There is no asynchronous affected-record search or custom combobox in this pass. The client sends
only the UUID selected from the current user/rep options or a validated exact lead UUID. Historical
user/rep IDs that no longer resolve remain visible on events but are not added to the current-record
selects. Customer-name lead search can be designed later if actual manager use demonstrates a need.

Unknown future action strings automatically appear in `filterOptions` and retain the existing
humanized-label fallback. Adding a new action must not require changing the filter contract.

## Audit Log experience

Place one responsive filter region between the page introduction and the event list. It contains:

- **Action type** select, default **All action types**;
- **Actor** select, default **All actors**;
- **Affected kind** select, default **Any affected record**;
- a native **Affected user** or **Affected rep** select for those kinds, or an exact **Lead ID**
  UUID input for Lead;
- **From date** and **To date** native date inputs;
- primary **Apply filters** and secondary **Clear filters** actions.

Controls are staged until Apply. Applying or clearing resets the offset to zero and issues one
list request. Pagination retains the committed filters. While a request is pending, keep the
last successful results visible, disable repeated Apply/pagination, and expose **Updating audit
log…** through a polite status region. A failure keeps the committed controls and last successful
results, shows the existing alert with Retry, and never relabels stale rows as current results.

When no event matches, show **No audit events match these filters.** The existing unfiltered
empty state remains **No audit events yet.** A compact result line states **Showing N events on
this page** and, when any filter is active, exposes a **Clear filters** shortcut. It does not imply
that `audit.list` computed a total matching count.

Every control has an explicit accessible name. Changing affected kind clears any staged affected
ID so a hidden value cannot be applied under a different kind. At 390 pixels the filter controls
stack without horizontal page overflow; the event cards and existing pagination remain in their
current order.

## Creation and removal formatting

Keep the short summary as the primary interface and raw JSON as secondary evidence.

- `before = null`, record-shaped `after`: **Created with N recorded fields**.
- record-shaped `before`, `after = null`: **Record removed**.
- a missing field within two existing records: **Not set**, preserving current behavior.
- Technical details for a creation: Before reads **Record did not exist**.
- Technical details for a removal: After reads **Record no longer exists**.
- An unexpected standalone null that is not classifiable from the opposite side reads
  **No state recorded**.

Preserve the current dedicated `ui-audit-diff` layout: its columns are already top-aligned,
Before stacks above After below 640 pixels, and long JSON wraps or scrolls inside the card. Do
not regress those behaviors and do not use `—` to represent record existence.

Add readable action labels for `lead.assign` and `lead.queue`. Preserve every existing label,
including `lead.skip` as **Skipped rep and passed lead**.

## Future sold-status gate

The current imported `sold` count remains a per-rep CRM metric. Priority 5 does not reinterpret
it or add a lead-level status.

One invariant applies to any future lead sold-state mutation: it must append a lead-primary audit
event in the same transaction, with complete before and after sold state. The future feature's
design must choose its action name, fields, correction model, permissions, reconciliation, and
tests. Priority 5 does not pre-decide or document those choices in `CLAUDE.md`.

## Implementation surface and checkpoint

Completed on `main`; preserve these files and contracts rather than scheduling them again:

- `apps/api/src/domain/assignLead.ts` (`a6f5831`)
- assignment-domain tests covering assigned, forced, queued, idempotent, and rollback paths
- `packages/db/src/schema/ledger.ts` for the `QUEUE` event type
- `apps/api/src/routers/audit.ts` (`bf9b8bd`)
- `apps/api/src/routers/audit.test.ts`
- `apps/api/src/domain/voidLead.ts` (`363af90`)
- `apps/api/src/domain/voidLead.test.ts`, including the queue-only successor regression

Implemented locally in the web checkpoint:

- `apps/web/src/pages/AuditLog.tsx`
- `apps/web/src/pages/AuditLog.test.ts`
- `apps/web/src/styles/ui.css`
- `docs/Revised consolidated action list.md`
- `packages/db/src/seed.ts` now seeds the New York business date rather than the UTC calendar date,
  so the guarded fixture remains eligible during the post-midnight-UTC evening window.

Remaining local verification surface is limited to the explicitly unrun browser cases; no
additional Audit Log product implementation is currently identified.

No database migration, route rename, permission, navigation, realtime, or dependency change is
expected. The bounded assignment-ledger change is the typed zero-credit `QUEUE` event above.

## Validation

### Recorded verification for the completed backend checkpoint

Do not repeat this backend-only verification unless later work changes one of the completed
backend paths above:

- On August 6, 2026, `363af90` passed all 8 focused `voidLead` tests under Node 22.23.2 against a
  freshly migrated and seeded guarded PostgreSQL test database. This includes the queue-only
  successor regression, ordinary empty-successor reopening, idempotency, counter/slot rollback,
  concurrent Void plus Assign, and queued-lead Void behavior.
- A second fresh guarded database passed workspace type checking, all 59 test files and 470 tests
  (contracts 11, core 18, API 275, web 166), and the production web build under Node 22.23.2.
- `git diff --check` passed, `main` matched `origin/main` at `363af90`, and GitHub CI run
  `31074689872` completed successfully.
- No browser pass was needed for `363af90` because it changed backend cycle-state behavior and its
  regression test only; this is not deployment or production verification.

### Backend contract to preserve

These are regression requirements for the completed backend checkpoint, not outstanding
implementation tasks:

- Normal, forced, and no-eligible assignment outcomes append the specified action and payload in
  the assignment transaction.
- The no-eligible outcome appends one zero-credit `QUEUE` ledger row carrying the lead ID and
  original idempotency key without consuming a cycle slot or changing counters.
- A queue-only open successor cycle does not prevent `voidLead` from reopening the prior cycle;
  existing cycle-consuming events continue to prevent that reopen.
- Reusing an assigned or queued outcome's idempotency key returns the prior lead without duplicate
  lead, queue, ledger, or audit rows.
- An injected audit-insert failure rolls back every write made by the assignment transaction and
  publishes no realtime event. Reuse the transaction-proxy pattern already present in
  `overrideStatus.test.ts` rather than adding test infrastructure.
- Existing audit tests remain passing as the broader suite gate; implementation proof stays
  focused on assignment outcomes, list predicates, formatting, and permissions.
- BDC and Rep callers remain forbidden from every audit read procedure.
- Each filter works alone and all filters work together; pagination remains newest-first with the
  ID tie-breaker and has no duplicates or omissions for a stable result set.
- Actor choices retain inactive actors. Current user and rep choices resolve to exact IDs; lead
  filtering accepts an exact UUID; activity-import storage anchors are never offered as targets.
- From/to boundaries include the intended New York dates across ordinary and daylight-saving
  transitions, regardless of process timezone.
- Invalid UUIDs, invalid dates, reversed ranges, and incomplete affected-kind selections are
  rejected or omitted as specified.

### Web

- Apply and Clear reset pagination and send exactly the committed filters; Previous/Next retain
  them.
- Pending and failed loads preserve the last successful results and accurately announce stale or
  updating state.
- Filtered and unfiltered empty states are distinct.
- Action and actor options include current stored values, and unknown action names retain readable
  fallback formatting.
- Affected-kind changes clear stale IDs; native user/rep selects and the exact lead UUID input send
  the intended canonical target and support clearing.
- Creation, removal, missing-field, and unexpected-null states use the exact natural-language
  copy above; raw JSON remains available.
- Static markup and browser accessibility inspection verify filter labels, live status/error
  regions, focus order, and pagination state.

### Recorded verification for the local web checkpoint

- On August 6, 2026 under Node 22.22.3, the focused Audit Log suite passed 9/9 tests. The complete
  web suite also passed all 25 files and 170 tests.
- Workspace type checking passed. Web lint exited successfully with 53 warnings and no errors;
  the warnings are the repository's existing Fast Refresh/export style class, including helpers
  exported from `AuditLog.tsx` for tests. The production web build passed, producing the Vite
  client bundle, and `git diff --check` passed.
- The one attempted final workspace suite was not accepted as the integration gate: contracts
  passed 11/11, core 18/18, web 170/170, and API 274/275, but
  `activityImportDecision.test.ts` expected the latest `activity.import` audit payload and read a
  stale null payload from the shared database. The same run printed extensive pre-existing
  counter drift, so this was not the freshly migrated and seeded guarded database required by
  this spec. Per the bounded workflow, the contaminated fixture was not repeatedly rerun.
- These results were followed by the authenticated local Manager browser pass recorded below. They
  are not deployment or production verification.

### Recorded authenticated Manager browser verification

- On August 6, 2026, the Audit Log flow passed with the existing `phoneup_browser_test` fixture and
  a Manager account. Pending migrations were applied first because the local fixture lacked the
  current `is_protected` column.
- At 1280×633, Audit Log opened through Management navigation and rendered all seven fixture events
  newest-first. Action, actor, affected-kind, and date controls were present and labeled. Filtering
  by **Skipped rep and passed lead** sent `action: "lead.skip"` and returned exactly three matching
  events; Clear restored all seven. Technical details expanded to readable Before/After JSON.
- At a true 390×844 viewport, filter controls stacked in one column, Apply/Clear filled the
  available width, and all seven cards wrapped without horizontal overflow. The measured document
  width was 390 pixels. No overlap or clipping was observed at either viewport.
- `audit.list` and `audit.filterOptions` returned HTTP 200. There were no failed HTTP requests,
  network-loading failures, Audit Log console errors, alerts, or uncaught JavaScript exceptions.
  Two transient board WebSocket close-before-connect warnings occurred during automated page
  navigation but did not affect Audit Log traffic or rendering.
- Local API and Vite processes were stopped and the temporary Manager session was removed after the
  pass. The mobile screenshot is `output/audit-log-verification/manager-mobile-390.png`.
- This initial fixture contained only seven events, so the pagination and remaining edge cases were
  retained for the separate targeted pass below. This local proof is not deployment or production
  verification.

### Recorded remaining browser verification

- A subsequent local pass against `phoneup_browser_test` completed every requested uncovered case.
  It added 55 temporary pagination audit events and removed all of them afterward, returning the
  fixture to its original seven audit events.
- A combined action-plus-actor filter returned zero rows and displayed **No audit events match these
  filters.**
- Pagination retained the committed filters: Page 1 displayed 50 filtered events with Previous
  disabled and Next enabled; Page 2 displayed the remaining five events with Previous enabled and
  Next disabled.
- A simulated `audit.list` network failure preserved the last successful rows, exposed a
  keyboard-operable Retry control, and Retry cleared the alert and restored 50 events.
- A real Admin could access Audit Log. Admin View-as BDC showed the read-only banner and removed
  Assign Lead, Management, and Audit Log controls.
- Enter activated Apply, Next, and Retry. The Audit Log heading received programmatic focus with
  `tabindex="-1"`. Pending requests announced **Updating audit log…** through `role="status"`
  with `aria-live="polite"`; Apply and pagination controls disabled while pending and prior rows
  remained visible; load failure used `role="alert"`.
- New artifacts are `output/audit-log-verification/pagination-page-1.png`,
  `pagination-page-2.png`, `combined-no-results.png`, `load-failure-retry.png`, and
  `admin-view-as-bdc.png`. API and Vite were stopped after the pass; ports 3000 and 5173 had no
  listeners. No product code changed. Previously passing Manager desktop/mobile, individual filter,
  Clear, and Technical Details cases, plus BDC/Rep API denial tests, were retained rather than
  repeated. This is local evidence, not deployment or production verification.

### Recorded clean-database final integration gate

- On August 6, 2026 under Node 22.22.3, a freshly created local PostgreSQL database was migrated and
  seeded before running the serial workspace gate.
- The first fresh attempt exposed a fixture boundary bug rather than an Audit Log failure: after
  midnight UTC but before midnight in New York, `seed.ts` created rep shifts and statuses for the
  UTC date while assignment eligibility queried the New York business date. That left the fresh
  fixture with no eligible reps and caused six assignment/void assertions to fail.
- `packages/db/src/seed.ts` now derives its date through the shared `businessDate` helper. A new
  replacement database confirmed all three seeded status rows used the current New York business
  date before the gate was retried once.
- Workspace type checking passed. All 59 test files and 474 tests passed: contracts 11, core 18,
  API 275, and web 170. Web lint completed with the established 53 Fast Refresh/export warnings and
  no errors. The production web build and `git diff --check` also passed.
- The disposable guarded databases were removed after validation. This remains local integration
  evidence, not deployment or production verification.

### Local verification completion

- Do not rerun the completed backend-only matrix before web implementation unless a backend path
  changes. The final serial workspace gate and affected package checks are complete.
- The recorded Manager desktop/mobile and targeted edge-case passes cover the requested Audit Log
  browser matrix. Do not repeat successful cases without new evidence that invalidates them.
- Existing API permission tests retain BDC and Rep denial coverage; the targeted browser pass also
  confirmed that read-only Admin View-as BDC cannot reach Audit Log or management controls.

Deployment and production verification remain separate gates and must not be inferred from local
tests or browser proof.

## Success criteria

Priority 5's implementable portion is complete when every newly created assigned or queued lead
has exactly one transactionally consistent audit event; Manager/Admin can reliably filter the
append-only stream by action, actor, one primary affected user/rep/lead, and inclusive New York
date range; creation/removal details use natural language and a responsive top-aligned layout; and
all existing audit coverage, permissions, assignment authority, and recent UI behavior remain
unchanged.

Lead-level sold status remains a separate product decision. If it is later built, Priority 5 is
not fully satisfied unless that mutation appends a same-transaction lead audit event with complete
before and after sold state.
