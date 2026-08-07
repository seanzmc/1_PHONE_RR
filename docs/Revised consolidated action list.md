# Revised consolidated action list

## Priority 1 — Login and password recovery — Complete

- [x] Add accessible Show/Hide password controls to every password field.
- [x] Remove the temporary-password field from forced first-login setup.
- [x] Add a visible “Forgot password?” link and a 30-minute, single-use email recovery flow for active users, while preserving Manager/Admin-assisted password reset.
- [x] Add confirmation after a voluntary password change.
- [x] Translate raw authentication and password errors into actionable language.

Completed and deployed on August 1, 2026 in `44d1cd4`. Focused validation passed 25 API tests and 12 web tests. Production Resend delivery was confirmed, including the eligible-user restriction and single-use reset link.

## Priority 2 — Assignment workflow — Complete

- [x] Replace the dedicated Assign page with a global BDC+ assignment drawer containing the form and live roster.
- [x] Keep preset Skip reasons inline beneath the assignment result with deliberate confirmation and Audit Log-only reason visibility.
- [x] Guard X, backdrop, and Escape against losing non-whitespace assignment or Skip drafts; saved and clean state close normally.
- [x] Restore the primary Assign action beneath the form and preserve submit-time-only rotation locking.
- [x] Make assignment confirmation rep-first, show customer plus phone, and remove assignment-workspace clipboard behavior.
- [x] Present skipped reps first inside one neutral Served This Round list with a compact Skipped badge.

Completed locally on August 2, 2026. Affected assignment API tests passed 14/14; final-review focused web tests passed 49/49; approved-exception Drawer/AssignmentDrawer/Modal tests passed 19/19; all web tests passed 132/132; and workspace type checking, web lint, and the production web build exited successfully. Authenticated local browser proof covered BDC assignment and repeatable inline Skip, every clean and guarded close path, mutation-time close blocking, exact focus restoration, result and served-list presentation, Manager/Admin access, REP and view-as absence, and the 390-pixel full-screen layout. The final-review rerun additionally verified mounted focus targets after Assign, Skip, Cancel, and Void; discard-dialog requester restoration through its safe action, backdrop, and Escape; assignment time and rep-first hierarchy; and a submit label that tracks the fresh current Next Up rep. The approved-exception rerun reproduced Chromium moving focus to BODY before the terminal backdrop click, proved exact requester restoration for dirty backdrop, X, and Escape paths with drafts intact, and measured the 12px assignment timestamp at 5.866:1 against its browser-computed background. The full serial API suite passed 196/197; its sole Sunday-sensitive `userManagement.test.ts` failure reproduced unchanged at parent `f283f9c`, while all seven `voidLead.test.ts` tests passed. Validation ran under Node 26.5.0 while the repository declares Node 22.x. Deployment and production verification remain outstanding.

## Priority 3 — Navigation and role flow — Complete

- [x] Start every role on Team Dashboard and use that name in both navigation and the page heading.
- [x] Show My Dashboard only to Rep accounts while keeping Team Dashboard available to Reps.
- [x] Order the operational navigation as Assign lead, Team Dashboard, Rep-only My Dashboard, Staff List, and Import Activity, subject to role permissions.
- [x] Move User Management and Audit Log into one Manager+ Management menu.
- [x] Keep the Assign action visually prominent. Completed in Priority 2.
- [x] Restore active-navigation styling, keep the Management and profile menus onscreen at 1024px and 390px, and raise primary, muted, hint, link, and table-header colors above the documented AA failures.
- [x] Remove the unimplemented self-service reactivation-request promise and permissions. Reps now contact a Manager or Admin, who use the existing audited account/status controls.

Completed locally on August 2, 2026. App navigation tests passed 10/10, contract tests passed 9/9, a freshly migrated and seeded CI-style database passed all 197 API tests, all 134 web tests passed, and workspace type checking, web lint, the production web build, and `git diff --check` exited successfully. Local Playwright proof with non-persistent fixture responses covered Admin, Manager, and Rep role navigation at 1024×768 and 390×844, both Management and profile-menu containment—including Admin with View as visible—current-page styling, and the Rep Team Dashboard landing. Measured contrast was 5.782:1 for primary/accent text on the page background, 5.332:1 on the surface background, and 5.866:1 for muted text. Validation ran under Node 26.5.0 while the repository declares Node 22.x. This work has not been deployed or production-verified.

## Priority 4 — Staff and user management — Complete

- [x] Add a dedicated Edit days off mode: compact view shows saved values, edit mode exposes targeted radio groups, and one Save applies the changed set together.
- [x] Keep edits local until Save, block duplicate submission while saving, retain drafts after failures, and surface legacy multi-day values truthfully for correction.
- [x] Make Staff List bulk actions discoverable before selection and clarify the page purpose and recurring-day-off rules.
- [x] Clarify User Management's purpose, separate enabled and inactive accounts, and make its tables responsive and sortable.
- [x] Rename password actions, explain temporary-password behavior in both manual and generated flows, and provide accessible Show/Hide controls.
- [x] Replace the Set name action with non-clickable missing-name copy and give repeated row actions, status actions, day-off groups, and sort controls specific accessible names.
- [x] Refresh Staff List, Team Dashboard, and the open Assignment Drawer/Next Up roster from the existing authenticated board realtime channel after eligibility and day-off changes.

Completed locally on August 3, 2026, including the bounded whole-branch final fixer wave. Weekly call-rule suspensions now survive automatic eligible/no-DQ evaluations until explicit manager reactivation; Staff List concurrent editing preserves only touched active drafts and saves only touched rows still different from the latest baseline; Team Dashboard accepts only the latest request and preserves its last good summary behind a visible warning and Retry; and blank or whitespace account names consistently fall back to email in User Management. Under the repository's required Node 22 runtime, focused post-fix suites passed 31 eligibility, 33 Staff List, 5 Dashboard, and 16 User Management tests. A second freshly migrated and seeded guarded database passed the complete 57-file, 412-test matrix: core 16, contracts 11, API 221, and web 164. Workspace type checking, web lint with the established 48 warnings, the production web build, and `git diff --check 2c893b8..HEAD` also exited successfully. Fresh two-session Playwright proof showed a Manager's touched Alex/Tue draft survive while an Admin's remote untouched Bailey/Fri update was adopted; the Manager save submitted Alex only. Controlled Dashboard routes then proved a delayed 111 response could not replace the newer 222 summary, a latest-request HTTP 500 preserved 222 while exposing the stale-data alert and Retry, and Retry advanced the summary to 333 and cleared the alert. Earlier accepted management, accessibility, activity-import, Dashboard realtime, and open Assignment Drawer evidence remains in force. The disposable databases and local server were removed afterward; all 92 Priority 4 browser artifacts, including 20 from this final wave, were retained locally for review. This work has not been deployed or production-verified.

## Priority 5 — Audit completeness — Local integration complete; browser edge cases pending

Add missing Audit Log events for:

- [x] Lead assignment, including queued no-eligible submissions and idempotent audit/ledger writes.
- [x] Skip. Completed in Priority 2.
- [x] Require any future sold-status action to append a same-transaction, lead-primary audit event.
  Lead-level sold status itself remains deferred pending the separate product decisions below.

Preserve the existing coverage for reassignments, voids, account access, rep status, password events, days off, notes, activity, metrics, and policy changes.

- [x] Add filters for action type, actor, affected rep/user/exact lead ID, and inclusive New York
  date range, with staged Apply/Clear behavior and pagination retaining committed filters.

- [x] Improve creation/removal formatting so missing record state reads naturally instead of
  displaying —, while preserving raw technical details and the responsive diff layout.

Implemented locally on August 6, 2026. Focused Audit Log tests passed 9/9, all 170 web tests passed,
and workspace type checking, web lint, the production web build, and `git diff --check` succeeded
under Node 22.22.3. Authenticated local Manager browser verification passed at 1280×633 and a true
390×844 viewport: all seven fixture events rendered newest-first; action, actor, affected-kind, and
date controls were labeled; filtering `lead.skip` returned exactly three events; Clear restored all
seven; Technical details showed readable Before/After JSON; and the mobile controls and cards fit
without horizontal overflow. `audit.list` and `audit.filterOptions` returned HTTP 200, the filter
request included `action: "lead.skip"`, and there were no Audit Log errors, failed requests, alerts,
or uncaught exceptions. Two transient board WebSocket close-before-connect warnings during
automated navigation did not affect Audit Log HTTP traffic or rendering. The existing
`phoneup_browser_test` fixture required pending migrations for `is_protected`; local processes and
the temporary Manager session were removed afterward. The mobile artifact is
`output/audit-log-verification/manager-mobile-390.png`. Pagination was not exercised because the
fixture contained only seven events; Admin/other-role, no-results, and load-failure/Retry browser
coverage remain open. The final clean-database gate subsequently passed on a freshly migrated and
seeded guarded PostgreSQL database: type checking, all 59 test files and 474 tests (contracts 11,
core 18, API 275, web 170), web lint with the established 53 warnings and no errors, the production
build, and `git diff --check` succeeded under Node 22.22.3. The first fresh run exposed and fixed a
late-evening fixture bug in `packages/db/src/seed.ts`: it now uses the New York business date rather
than the UTC calendar date, keeping seeded shifts/statuses aligned with API eligibility after
midnight UTC. The disposable test databases were removed afterward. This work has not been deployed
or production-verified.

## Priority 6 — Remaining page polish

Clarify Team Dashboard metric definitions and make rep-name drill-down more obvious.
Improve Rep Detail empty-state copy, note placeholder, and clipboard success/failure handling.
Rewrite cryptic Import Activity labels and link successful deactivations to Staff List.
Add the remaining blueprint visual details to cards and primary buttons.

## Keep separate from this UI list

These require operational verification or a product decision:
Confirm the display-name backfill actually ran in production.
Verify whether the CRM Sold column is daily or cumulative using a real import.
Keep “Mark a lead sold” deferred until CRM-total versus lead-attribution semantics are decided.
Priorities 1–5 are implemented. Priority 1 is deployed and production-verified; Priorities 2–5 are locally implemented but not deployed. Priority 5's clean-database integration gate and authenticated local Manager Audit Log flow passed; only the explicitly unrun Admin/other-role, pagination, no-results, and failure/Retry browser cases remain open before deployment and production verification. Priority 6 remains open. Priority 4 and Priority 5 validation ran under the repository's required Node 22.x runtime.
