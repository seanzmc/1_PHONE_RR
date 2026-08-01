# Revised consolidated action list

## Priority 1 — Login and password recovery

Add accessible Show/Hide password controls to every password field.
Remove the temporary-password field from forced first-login setup.
Add a visible “Forgot password?” link and manager-assisted recovery screen.
Add confirmation after a voluntary password change.
Translate raw authentication and password errors into actionable language.

## Priority 2 — Assignment workflow

Implement BDC+ Skip:
Place next to Void.
Mark the assigned rep served for the cycle.
Preserve the lead appropriately.
Audit the actor, lead, rep, reason, and before/after state.

Make Assign the dominant persistent action in the header.
Preserve the already-correct behavior where the state lock begins only after assignment submission.

Improve the “Just Assigned” result:
Include customer name and assignment time.
Add next steps for duplicate numbers.
Add next steps when a lead is unassigned.
Improve empty Next Up and On Deck guidance.

Add shared user-friendly error translation for assign, void, reassign, and related mutations.

## Priority 3 — Navigation and role flow

Start users on Team Dashboard.
Show My Dashboard only to Rep accounts.
Rename “Dashboard” to “Team Dashboard.”
Reorder navigation around the actual daily workflow.
Move User Management and Audit Log into the Manager+ profile menu.
Make the Assign action visually prominent.
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

Add missing Audit Log events for:Lead assignment
Skip
Any future sold-status action

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
No files were changed. Current web validation passed 73/73 tests, and the production build passed. It ran under Node 26.5.0 while the repository declares Node 22.x; no live browser or production verification was performed.
