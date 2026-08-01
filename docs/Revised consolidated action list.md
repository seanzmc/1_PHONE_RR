# Revised consolidated action list

## Priority 1 — Login and password recovery — Complete

- [x] Add accessible Show/Hide password controls to every password field.
- [x] Remove the temporary-password field from forced first-login setup.
- [x] Add a visible “Forgot password?” link and a 30-minute, single-use email recovery flow for active users, while preserving Manager/Admin-assisted password reset.
- [x] Add confirmation after a voluntary password change.
- [x] Translate raw authentication and password errors into actionable language.

Completed and deployed on August 1, 2026 in `44d1cd4`. Focused validation passed 25 API tests and 12 web tests. Production Resend delivery was confirmed, including the eligible-user restriction and single-use reset link.

## Priority 2 — Assignment workflow — Complete

- [x] Add BDC+ Skip next to Void. A skip keeps the current rep served for the cycle and passes the same lead to the next eligible rep, or leaves it unassigned when no rep is available.
- [x] Allow deliberate repeated skips without making Skip spammable: every skip names the current rep, requires a reason and explicit confirmation, disables while submitting, and is protected by both an expected-rep check and an idempotency key.
- [x] Audit each skip with the actor, lead, skipped rep, reason, and before/after assignment state.
- [x] Make Assign the dominant persistent action in the header while preserving the behavior where the state lock begins only after assignment submission.
- [x] Improve “Just Assigned” with the customer name, assignment time, copy action, and clear next steps for duplicate or unassigned leads.
- [x] Improve empty Next Up and On Deck guidance.
- [x] Add shared user-friendly error translation for assign, skip, void, reassign, notes, and metrics mutations.

Completed locally on August 1, 2026. Contract tests passed 9/9, web tests passed 99/99, affected assignment API tests passed 7/7, and type checking plus the production web build passed. A local BDC browser check confirmed the guarded skip flow and that Skip remains available after a successful pass. The full API suite passed 192/196; the four failures are pre-existing `voidLead` failures reproduced unchanged at the untouched `5c30fee` baseline. This Priority 2 work has not been deployed or production-verified.

## Priority 3 — Navigation and role flow

Start users on Team Dashboard.
Show My Dashboard only to Rep accounts.
Rename “Dashboard” to “Team Dashboard.”
Reorder navigation around the actual daily workflow.
Move User Management and Audit Log into the Manager+ profile menu.
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
