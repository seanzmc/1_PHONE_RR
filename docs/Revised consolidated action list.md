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

## Priority 4 — Staff and user management

Add a dedicated “Edit Days Off” mode:Normal view shows only the selected day.
Edit mode reveals all radio controls.
Save applies the complete set together.

Make Staff List bulk actions discoverable before a checkbox is selected.
Add clearer recurring-day-off guidance.
Clarify page purposes:Staff List: rotation status, availability, overrides, and days off.
User Management: accounts, roles, passwords, and access.

Improve User Management labels:Rename “Reset password” and “Set manually.”
Clarify temporary-password behavior.
Replace “Set name” with non-clickable missing-name copy.
Give repeated row actions and sort controls specific accessible names.

## Priority 5 — Audit completeness

Add missing Audit Log events for:

- [ ] Lead assignment
- [x] Skip. Completed in Priority 2.
- [ ] Any future sold-status action

Preserve the existing coverage for reassignments, voids, account access, rep status, password events, days off, notes, activity, metrics, and policy changes.

Add filters for:
Action type
Actor
Affected rep/user/lead
Date range

Improve creation-event formatting so missing prior state reads naturally instead of displaying —.

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
Priorities 1–3 are implemented. Priority 1 is deployed and production-verified; Priorities 2 and 3 are locally verified but not deployed. Priorities 4–6 were not re-audited as part of the Priority 3 update. Validation ran under Node 26.5.0 while the repository declares Node 22.x.
