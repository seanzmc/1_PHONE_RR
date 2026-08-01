## Priority 1 — Critical login changes

1. Add a password-visibility toggle.
   - Place an eye icon inside every password field.
   - Apply it to login, temporary-password, password-reset, and password-change screens.

2. Simplify first-time password setup.
   - Do not require users to re-enter their temporary password after they have successfully logged in with it.
   - Require only the new password and confirmation.

3. Add a “Forgot password?” link to the login screen.
   - Provide a clear password-recovery or manager-assisted reset flow.

## Priority 2 — Critical assignment changes

4. Add a “Skip” action for BDC+ users on the Assign page.
   - Display it next to “Void.”
   - Use the space currently occupied by “Copy phone number,” if necessary.
   - Use Skip when the newly assigned rep is unavailable.
   - Skipping must still mark that rep as “served this cycle.”
   - Record the skip in the audit log.

5. Make the Assign button significantly more visible.
   - Consider a larger header button or a persistent/floating action.
   - Clicking Assign should trigger the state lock—not merely opening or viewing the page.

## Priority 3 — Navigation and role-based flow

6. Make the Team Dashboard the default starting page for all users.

7. Hide “My Dashboard” from every role except Rep.
   - Reps are currently the only role with meaningful content on that page.

8. Reorder and relabel the top navigation tabs.
   - Arrange them around the user’s normal workflow.
   - Use labels that clearly distinguish each page’s purpose.

9. Remove “Users” from the main navigation.
   - Add “User Management” to the profile/name dropdown for Manager+ users.
   - Link it to the existing Users page.

10. Remove “Audit Log” from the main navigation.
    - Move it into the profile/name dropdown or another Manager+ administrative area.

11. Reconsider the page set available to each role.
    - Show only pages that contain relevant actions or information for that role.
    - Eliminate empty or redundant destinations.

## Priority 4 — Staff and user management

12. Clearly separate the Staff List from User Management.
    - Staff List should focus on operational rep status and availability.
    - User Management should focus on accounts, permissions, activation, and access.

13. Simplify days-off editing on the Staff List.
    - Hide day-off controls in the normal list view.
    - Add an “Edit Days Off” button.
    - When clicked, show the day-off selection controls for all reps.
    - Add a Save button to apply and lock in all changes together.

## Priority 5 — Audit logging

14. Expand the actions recorded in the audit log to include:
    - Lead assignments
    - Lead reassignments
    - Skips
    - Voids
    - User activations and deactivations
    - User enables and disables
    - Password resets
    - Days-off changes
    - Any other action that materially changes system state

15. Include useful context with each audit event.
    - Acting user
    - Affected user or lead
    - Action performed
    - Previous and new values, where applicable
    - Date and time

16. Add simple audit-log filters.
    - Event/action type
    - Acting user
    - Affected user or lead
    - Date range