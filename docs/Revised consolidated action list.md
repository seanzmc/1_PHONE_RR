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

Completed locally on August 2, 2026. Affected assignment API tests passed 14/14; final-review focused web tests passed 49/49; all web tests passed 131/131; and workspace type checking, web lint, and the production web build exited successfully. Authenticated local browser proof covered BDC assignment and repeatable inline Skip, every clean and guarded close path, mutation-time close blocking, exact focus restoration, result and served-list presentation, Manager/Admin access, REP and view-as absence, and the 390-pixel full-screen layout. The final-review rerun additionally verified mounted focus targets after Assign, Skip, Cancel, and Void; discard-dialog requester restoration through its safe action, backdrop, and Escape; assignment time and rep-first hierarchy; and a submit label that tracks the fresh current Next Up rep. The full serial API suite passed 196/197; its sole Sunday-sensitive `userManagement.test.ts` failure reproduced unchanged at parent `f283f9c`, while all seven `voidLead.test.ts` tests passed. Validation ran under Node 26.5.0 while the repository declares Node 22.x. Deployment and production verification remain outstanding.

## Priority 3 — Navigation and role flow

Start users on Team Dashboard.
Show My Dashboard only to Rep accounts.
Rename “Dashboard” to “Team Dashboard.”
Reorder navigation around the actual daily workflow.
Move User Management and Audit Log into a new Manager+ menu option "Management".
- [x] Make the Assign action visually prominent. Completed in Priority 2.
Fix active-navigation styling, profile-menu clipping, and documented contrast failures.
Implement the promised Rep reactivation-request workflow or remove the promise from the role contract.

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
Priority 1 has been implemented and production-verified. Priority 2 has been implemented and locally verified but not deployed. Priorities 3–6 were not otherwise re-audited as part of this status update. Validation ran under Node 26.5.0 while the repository declares Node 22.x.
