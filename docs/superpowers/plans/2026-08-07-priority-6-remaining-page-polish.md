# Priority 6 Remaining Page Polish — Execution Tasks and Checkpoints

**Date:** 2026-08-07  
**Status:** Tasks 1–5 are implemented and focused-test verified locally. Tasks 6–8, deployment, and production verification remain open.
**Source of truth:** `docs/superpowers/specs/2026-08-07-priority-6-remaining-page-polish-design.md`

## Goal

Complete the remaining page-level polish without changing business rules, permissions, stored audit evidence, metric calculations, import decisions, status authority, or the in-memory navigation model.

## Execution model

- Complete one task below as an independently useful slice, then stop at its checkpoint before starting another slice.
- Use test-first changes: add or update the focused proof, confirm it fails for the missing behavior, implement the smallest change, and rerun only the affected tests.
- Preserve existing successful evidence for unchanged behavior. Do not repeat broad or browser verification until the final integration checkpoints.
- Use the repository-declared Node 22.x runtime and pnpm 11.17.0.
- Do not commit, deploy, or production-verify unless separately requested.

## Non-negotiable boundaries

- No schema, migration, dependency, contract-package, runbook, audit-write, metric-query, import-decision, status, realtime, or authorization changes.
- `audit.list` may add display-only fields while preserving its current filters, ordering, pagination, canonical IDs, and raw `before`/`after` data.
- Do not add URL routing, a global clipboard abstraction, a new icon library, or shared `Card`/`Button` visual changes.
- Do not redesign Staff List, Assignment Drawer, Rep Detail tables, Import Activity decisions, or non-primary buttons.
- Keep exact UUIDs in Audit Log Technical details and in canonical filter requests; remove them only from the normal event-card presentation when specified.
- Keep deployment and production verification as separate gates.

## Dependency map

| Task | Slice | Depends on | Browser verification |
| --- | --- | --- | --- |
| 1 | Team Dashboard copy and permission-aligned rep drill-down | None | **Required in Task 7** |
| 2 | Rep Detail empty states, note prompt, and truthful clipboard feedback | None | **Required in Task 7** |
| 3 | Import Activity manager language and Staff List next step | None | **Required in Task 7** |
| 4 | Additive Audit Log API read model | None | Not directly; prove with API tests |
| 5 | Audit Log human-readable event cards | Task 4 | **Required in Task 7** |
| 6 | Local integration gate | Tasks 1–5 | No; prerequisite for Task 7 |
| 7 | Authenticated browser checkpoint | Task 6 | **This is the browser gate** |
| 8 | Documentation handoff | Tasks 6–7, using only completed evidence | No new browser run |

---

## Task 1 — Team Dashboard definitions and authorized rep drill-down

**Browser verification:** Required in Task 7 at desktop and mobile sizes, including a Manager flow and one BDC or REP permission check.

**Files**

- Modify: `apps/web/src/pages/Dashboard.tsx`
- Modify: `apps/web/src/pages/Dashboard.test.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.ts`

**Required behavior**

- [x] Add these exact metric hints without hiding them in tooltips:
  - **Phone-ups assigned:** **Phone-ups currently credited this month; voided assignments are removed.**
  - **CRM sales:** **Sum of the CRM Sold values imported for active reps this month.**
  - **Reassignments:** **Lead reassignments completed this month.**
  - **Call-rule deactivations:** **One per weekly call-rule suspension, not one per inactive day.**
  - **Cycle progress:** **Active reps served in the current rotation cycle; the cycle restarts after everyone is served.**
  - **Ineligible today:** **Active reps out of rotation today, for any reason.**
  - **Overrides today:** **Manager status changes recorded for today.**
- [x] Preserve all current values, labels, order, period, sorting, and stale-request behavior; do not derive replacement values in the client.
- [x] When `onOpenRep` is present, render the instruction: **Select a rep name to view their leads, activity, and status for the month.**
- [x] Keep authorized rep names as native buttons styled as links, add a visible trailing arrow, and give each a target-specific accessible name such as **View Taylor Morgan's rep details**.
- [x] When `onOpenRep` is absent, render plain names with no instruction, arrow, button, or dead-end control.
- [x] In `App.tsx`, pass `onOpenRep` only when the effective role has `rep.view`. Ensure read-only View-as uses effective permissions rather than the signed-in ADMIN's real permissions.
- [x] Preserve the current `openRep` path, Team Dashboard return behavior, and page-heading focus.

**Focused proof**

- [x] Update Dashboard tests to assert every exact hint and both interactive/non-interactive rep-list variants.
- [x] Update App tests to cover ADMIN/MANAGER access, BDC/REP absence, and effective-role View-as behavior.
- [x] Run:
  - `pnpm --filter @phoneup/web exec vitest run src/pages/Dashboard.test.ts src/App.test.ts`

### Checkpoint 1

Stop when the focused tests pass and confirm:

- Dashboard values and ordering did not change.
- Only effective roles with `rep.view` receive the callback.
- No server permission or navigation model changed.

**Checkpoint recorded 2026-08-07, reverified with Tasks 1–5:** Task 1 implementation is complete locally. Under Node 22.22.3 and pnpm 11.17.0, the consolidated focused web command passed with 6 test files and 57 tests, including `Dashboard.test.ts` and `App.test.ts` (20 Task 1 tests). Dashboard values and ordering remain server-owned and unchanged; only effective roles with `rep.view` receive `onOpenRep`; and the existing in-memory `openRep` path, permissions, and navigation model remain unchanged. Task 7 desktop/mobile browser verification, the Task 6 integration gate, deployment, and production verification remain unclaimed.

---

## Task 2 — Rep Detail guidance and clipboard state machine

**Browser verification:** Required in Task 7 at desktop and mobile sizes, including successful copy/reset and simulated clipboard rejection.

**Files**

- Modify: `apps/web/src/pages/RepDetail.tsx`
- Modify: `apps/web/src/pages/RepDetail.test.ts`

**Required behavior**

- [x] Replace the lead empty state with: **No ups yet this month — new phone-ups appear here as they're assigned.**
- [x] Replace the activity empty state with: **Call numbers appear here after the daily CRM import.**
- [x] Add **Note for this lead…** only as the placeholder on writable note textareas.
- [x] Preserve read-only notes, dirty detection, trimming/null behavior, Save visibility, permissions, and audit behavior.
- [x] Continue copying `digitsOnly(customerPhoneE164)`.
- [x] Model copy feedback per attempted lead as Idle, Pending, Success, or Failure:
  - Pending: **Copying…**, with repeated activation disabled.
  - Success only after the clipboard promise resolves: **Copied** plus polite **Phone number copied.** announcement.
  - Failure: button returns to **Copy** and visible alert reads **Couldn't copy the phone number. Select the number and copy it manually.**
- [x] Clear prior feedback at the beginning of every new attempt.
- [x] Clear successful feedback after approximately two seconds.
- [x] Replace the success timer after a later success and clean it up on unmount.
- [x] Prevent a late completion from an older attempt from overwriting a newer attempt's feedback.
- [x] Keep failure visible until retry, replacement by another attempt, or navigation away. Do not add an unverified fallback that reports success.

**Focused proof**

- [x] Assert the exact empty-state and placeholder copy, including that the placeholder does not become a draft value.
- [x] Use a deferred clipboard promise to prove Pending appears before settlement.
- [x] Use fake timers to prove resolved writes alone produce Success and return to Idle after about two seconds.
- [x] Prove rejection never produces **Copied**, shows the exact alert, and allows retry.
- [x] Prove an older late resolve/reject cannot replace feedback for the latest attempt.
- [x] Run:
  - `pnpm --filter @phoneup/web exec vitest run src/pages/RepDetail.test.ts`

### Checkpoint 2

Stop when the focused test passes and confirm:

- Clipboard success is never optimistic.
- The timer and stale-promise guards are covered.
- No other copy control or clipboard store was changed.

**Checkpoint recorded 2026-08-07:** Task 2 implementation is complete locally. The focused command passed with 1 test file and 17 tests. `pnpm --filter @phoneup/web typecheck` passed; web lint completed with 57 warnings and 0 errors; and `git diff --check` passed. The implementation changed only `RepDetail.tsx` and `RepDetail.test.ts`; no other copy control or clipboard store changed. Task 7 desktop/mobile browser verification, the Task 6 integration gate, deployment, and production verification remain unclaimed.

---

## Task 3 — Import Activity language and Staff List next step

**Browser verification:** Required in Task 7 for representative summary rows and a committed nonzero deactivation leading to Staff List.

**Files**

- Modify: `apps/web/src/pages/ActivityImport.tsx`
- Modify: `apps/web/src/pages/activityImportFlow.test.ts`, or add one focused presentation test beside it
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.ts`

**Required behavior**

- [x] Keep table structure, counts, names, result data, badges' existing tones, and zero-result dashes.
- [x] Rename **Not in the file** to **Reps missing from report**.
- [x] For a nonzero missing count, use badge **No numbers found** followed by: **This file had no activity numbers for these reps. The import records 0 unless a hand-entered correction already exists; correct their activity on the rep's page if they worked:** and then the affected names.
- [x] Rename **Unmatched names** to **Names not matched to staff**.
- [x] For a nonzero unmatched count, use badge **Not imported** followed by: **These report names did not match a Staff List display name. Check the spelling:** and then the affected names.
- [x] Rename **Manual rows preserved** to **Hand-entered corrections kept** and show: **This file did not overwrite saved corrections for:** followed by the affected names.
- [x] Keep missing, unmatched, not evaluated, and corrected rows separate; do not alter imported values or eligibility behavior.
- [x] Add an `onOpenStaff` callback to `ActivityImport` and wire it in `App.tsx` to the existing `setPage('staff')` path.
- [x] Only after a committed `LOG_AND_DEACTIVATE` with `deactivatedCount > 0`, show: **Suspensions run through Saturday. To reactivate someone early, open the Staff List.**
- [x] In that same state, render a real **Open Staff List** button beside **Process another report** and invoke the callback without mutating status or clearing import data first.
- [x] Do not show the suspension copy or Staff List action for `LOG_ONLY` or a zero-deactivation result.
- [x] Preserve **Process another report** and its current local reset behavior in every result state.

**Focused proof**

- [x] Render representative nonzero summary rows and assert the three exact labels, badges, explanations, and names.
- [x] Assert all outcomes remain separate and zero-result rows still show a dash.
- [x] Assert only a nonzero committed deactivation renders and invokes **Open Staff List**.
- [x] Assert App wiring reaches Staff List and retains page-heading focus behavior.
- [x] Run:
  - `pnpm --filter @phoneup/web exec vitest run src/pages/activityImportFlow.test.ts src/App.test.ts`
  - Include any new focused Activity Import test file in this command.

### Checkpoint 3

Stop when the focused tests pass and confirm:

- Import preview/commit semantics are unchanged.
- Navigation has no status side effect.
- Log-only and zero-deactivation results do not advertise reactivation work.

**Checkpoint recorded 2026-08-07:** Task 3 implementation is complete locally. The focused command included `ActivityImport.test.ts` and passed with 3 test files and 19 tests. `pnpm --filter @phoneup/web typecheck` passed, and `git diff --check` passed. Import preview/commit calls and eligibility data were unchanged; **Open Staff List** only changes the in-memory page to `staff`, without resetting import state or writing status. `LOG_ONLY` and zero-deactivation results retain **Process another report** but show no suspension guidance or Staff List action. Task 7 browser verification, the Task 6 integration gate, deployment, and production verification remain unclaimed.

---

## Task 4 — Add the Audit Log display-only API read model

**Browser verification:** Not required directly. Prove this backend slice with focused API tests; Task 5's rendered use of the read model is browser-verified in Task 7.

**Files**

- Modify: `apps/api/src/routers/audit.ts`
- Modify: `apps/api/src/routers/audit.test.ts`

**Output added to each existing `audit.list` item**

```ts
entityDisplay: {
  kind: string
  label: string
}
referenceLabels: Record<string, string>
```

The existing `entityType`, `entityId`, `before`, and `after` fields remain unchanged.

**Required behavior**

- [x] Select and paginate audit rows first; collect and resolve only IDs present on that returned page.
- [x] Resolve each record class in bounded bulk queries, never one query per event or field.
- [x] Build primary display identities as follows:
  - `app_user`: **Account** plus current display name and email, or email alone.
  - `lead`: **Lead** plus current customer name and readable phone.
  - `sales_rep` and `rep_daily_status`: **Rep** plus current rep display name and linked account email.
  - `rep_daily_activity` with `activity.metric.edit`: **Rep activity** plus rep display name and linked account email.
  - `rep_daily_activity` with `activity.import`: **Activity import** plus the imported business date from the event payload.
  - `work_requirement_policy`: **Activity policy** plus **Call requirement settings**.
- [x] Never present the storage-anchor rep as the target of `activity.import`.
- [x] Collect `assignedRepId`, `skippedRepId`, and `repId` UUID references from both `before` and `after` and resolve them through `sales_rep` plus the linked account.
- [x] Use labels that distinguish duplicate rep names by including linked account email.
- [x] Return **Record unavailable** for missing current records and unknown future entity types; do not return a shortened/full UUID as a display fallback.
- [x] Keep IDs and raw event payloads intact for support and filtering.
- [x] Preserve current auth, filters, date boundaries, ordering, offset/limit behavior, and `hasMore` calculation.

**Focused proof**

- [x] Cover account, lead, rep, rep-status, rep-activity metric edit, activity import, and policy event targets.
- [x] Cover missing account/rep/lead records and an unknown entity type.
- [x] Cover `assignedRepId`, `skippedRepId`, and `repId` in both sides, including different before/after reps and duplicate display names.
- [x] Assert raw `entityType`, `entityId`, `before`, and `after` remain exact.
- [x] Assert `activity.import` uses its business date and not its anchor rep.
- [x] Prove resolution happens after pagination and uses a bounded number of bulk queries rather than N+1 lookups.
- [x] With a guarded test database whose name contains `test`, run serially:
  - `pnpm --filter @phoneup/api exec vitest run src/routers/audit.test.ts --no-file-parallelism`

### Checkpoint 4

Stop when the focused API test passes and record:

- Test database name used.
- Focused test count/result.
- Evidence that raw event identity and payloads remain unchanged.
- Evidence that query count is bounded by resolver type, not page length.

**Checkpoint recorded 2026-08-07:** Task 4 implementation is complete locally. Against guarded database `phoneup_test`, under Node 22.23.2 and pnpm 11.17.0, the serial focused command passed with 1 test file and 17 tests. The response keeps exact canonical `entityType`, `entityId`, `before`, and `after` values while adding display-only `entityDisplay` and `referenceLabels`. Resolution runs after the page slice and invokes each account, rep, and lead bulk loader at most once for the page, independent of page length. `git diff --check` passed. Task 5 rendering, the Task 6 integration gate, deployment, and production verification remain unclaimed.

---

## Task 5 — Render human-readable Audit Log cards

**Browser verification:** Required in Task 7 at desktop and mobile sizes, including resolved, duplicate-name, unavailable-record, and Technical details cases.

**Files**

- Modify: `apps/web/src/pages/AuditLog.tsx`
- Modify: `apps/web/src/pages/AuditLog.test.ts`

**Required behavior**

- [x] Extend the client item type to consume `entityDisplay` and `referenceLabels` from Task 4.
- [x] Replace normal-card `{entityType} · {entityId}` with `{entityDisplay.kind} · {entityDisplay.label}` and allow long labels to wrap.
- [x] Keep actor, timestamp, action label/code, event order, filters, pagination, stale-data handling, and responsive card structure unchanged.
- [x] Make change-summary formatting field-aware:
  - `assignedRepId` → **Assigned rep**
  - `skippedRepId` → **Skipped rep**
  - `repId` → **Rep**
- [x] Resolve UUID-shaped values only through `referenceLabels`; never guess a record type from a UUID.
- [x] Keep null/missing values as **Not set**.
- [x] Display **Record unavailable** for an unresolved UUID in a normal summary, never the UUID.
- [x] Keep normal handling for non-UUID values and the existing three-change summary limit.
- [x] Expand **Technical details** to show exact raw `entityType` and `entityId` alongside the existing raw Before/After blocks.
- [x] Do not alter or sanitize the raw Before/After JSON shown in Technical details.

**Focused proof**

- [x] Render account, lead, rep, import, and policy labels without front-facing UUIDs.
- [x] Assert field-specific labels and resolved before/after rep values.
- [x] Assert null remains **Not set** and unresolved UUIDs become **Record unavailable**.
- [x] Assert Technical details contain exact raw type, ID, Before, and After data.
- [x] Retain existing action, filter, pagination, empty-state, and responsive-diff tests.
- [x] Run:
  - `pnpm --filter @phoneup/web exec vitest run src/pages/AuditLog.test.ts`

### Checkpoint 5

Stop when the focused web test passes and confirm:

- No normal event card exposes a resolvable or unresolved UUID.
- Exact IDs remain available under Technical details.
- Canonical UUID filter input remains unchanged.

**Checkpoint recorded 2026-08-07:** Task 5 implementation is complete locally. The focused command passed with 1 test file and 13 tests. `pnpm --filter @phoneup/web typecheck` passed, and `git diff --check` passed. Normal event cards consume the Task 4 display read model and expose neither resolved nor unresolved UUIDs; exact canonical entity IDs and unchanged raw Before/After payloads remain available under **Technical details**. Existing canonical UUID filter input, event ordering, pagination, stale-data handling, and responsive card structure remain unchanged. Task 6 integration, Task 7 desktop/mobile browser verification, deployment, and production verification remain unclaimed.

---

## Task 6 — Local integration gate

**Browser verification:** Not part of this task. This checkpoint must pass before Task 7 starts.

Run this only after Tasks 1–5 pass independently.

**Preflight**

- [ ] Confirm Node is 22.x and pnpm is 11.17.0.
- [ ] Recheck `git status --short` and preserve all pre-existing user changes.
- [ ] Confirm the API test database is guarded and its name contains `test` before running destructive API tests.

**Validation**

- [ ] Run the focused API Audit router test once against the guarded database if it has not already passed on the final code.
- [ ] Run the complete web suite once: `pnpm --filter @phoneup/web test`.
- [ ] Run workspace typecheck once: `pnpm typecheck`.
- [ ] Run web lint once: `pnpm --filter @phoneup/web lint`.
- [ ] Run the production build once: `pnpm build`.
- [ ] Run `git diff --check`.
- [ ] Run the broader serial workspace suite only if final shared typing or the Audit read-model integration crosses beyond the focused proof: `pnpm -r --workspace-concurrency=1 test -- --no-file-parallelism`.

### Checkpoint 6

Stop and report exact command results. Do not proceed to browser or deployment verification if any required gate fails. After one review/fix round, rerun only checks invalidated by the fix.

---

## Task 7 — Authenticated local browser checkpoint

**Browser verification:** Required. This task is the consolidated browser gate for Tasks 1, 2, 3, and 5.

Run only after Checkpoint 6 passes. Use a local Manager fixture at 1024×768 and 390×844, plus one BDC or REP Dashboard permission check. Retain existing evidence for unchanged flows.

- [ ] Team Dashboard: verify all hints remain visible and legible, cards remain responsive, Manager rep names clearly open the intended Rep Detail, return behavior works, and page-heading focus is retained.
- [ ] BDC/REP Team Dashboard: verify names are plain text and no drill-down instruction, arrow, or interactive control appears.
- [ ] Rep Detail: verify both empty states, note placeholder, successful copy/pending/reset behavior, and a simulated clipboard rejection with manual-copy guidance.
- [ ] Import Activity: exercise representative nonzero missing, unmatched, and preserved summary rows; commit a fixture deactivation; verify **Open Staff List** reaches Staff List without changing status during navigation.
- [ ] Audit Log: inspect representative account, lead Skip/Reassign/Void, rep-status, metric-correction, activity-import, and policy events. Verify normal cards contain readable labels and no UUIDs.
- [ ] Audit Log edge cases: verify duplicate rep names remain distinguishable and an unresolved record reads **Record unavailable**.
- [ ] Technical details: verify exact raw entity type/ID and unchanged Before/After data remain available.
- [ ] Mobile: verify long name/email/phone labels wrap at 390 pixels without horizontal overflow.

### Checkpoint 7

Record viewport, role, fixture, scenarios passed, artifacts retained, and any untested case. Do not infer deployment or production behavior from this evidence.

---

## Task 8 — Documentation handoff

**Browser verification:** No new run. Record only the evidence produced by Task 7 and any explicit gaps.

Only after implementation evidence exists:

- [ ] Mark completed checkboxes in this plan without claiming unrun validation.
- [ ] Update `docs/Revised consolidated action list.md` and `docs/open-ui-7-31.md` only for Priority 6 items proven complete.
- [ ] Record exact test counts, runtime versions, lint warnings if any, browser scope, and explicit deployment/production status.
- [ ] Inspect `git diff --stat`, `git diff`, and `git status --short` to confirm only intended implementation, tests, and documentation changed.
- [ ] Leave unrelated pre-existing modified/untracked files untouched.

### Final completion checkpoint

Priority 6 is locally complete only when:

- Every Dashboard metric has its exact plain-language definition.
- Rep drill-down is visible only to effective roles with `rep.view`.
- Rep Detail empty, note, pending, success, failure, timeout, cleanup, and stale-copy states are proven.
- Import Activity uses the required manager language and only real deactivations expose the Staff List next step.
- Audit Log normal cards use truthful current-record identities with no UUID fallback, while Technical details preserve exact durable IDs and raw payloads.
- Focused tests, the complete web suite, workspace typecheck, web lint, production build, and diff check pass under Node 22.x.
- Required authenticated local browser checks pass at desktop and mobile sizes.
- Deployment and production verification remain explicitly unclaimed until separately performed.
