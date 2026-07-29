# Design

A. Rotation correctness (the only core-loop item)

Void today is broken three ways (assignment.ts:33-59): no advisory lock, leaves the rr_cycle_assignments row, leaves lastAssignedAt/upsToday stale. Fix: move void into apps/api/src/domain/voidLead.ts, mirroring assignLead:

pg_advisory_xact_lock(42_100_1) — same key, per CLAUDE.md.
Find the lead's ASSIGN event → its cycleNo.
Delete that rep's rr_cycle_assignments row for that cycle → rep is unserved again → ranking puts them back at top (they also have the lowest upsMtd after the decrement and oldest lastAssignedAt after restore). That is what makes next-up equal the rep you just undid.
Decrement upsMtd and upsToday; restore lastAssignedAt from that rep's previous ASSIGN event createdAt (null if none).
Cycle-close edge: if that assign closed the cycle, reopen it (closed_at = null) and delete the freshly-opened empty cycle. Otherwise undo silently jumps a whole rotation.
Append VOID event (ledger stays append-only), publish realtime.
Tests: undo → board.roster next-up is the voided rep; undo across a cycle boundary; concurrent void+assign.

B. Roster buckets — four, non-leaky: Next Up (1) / On Deck (numbered 2..N, eligible + unserved) / Served This Cycle (with ups count) / Unavailable (with reason). Today "On Deck" wrongly includes served reps. Pure display change in AssignScreen; ranking untouched.

C. Users page

Name column: show displayName, never email fallback; null renders muted "Set name". Run existing backfillDisplayNames.ts against prod.
Role dropdown disabled for your own row (any role, not just admin) — server already blocks last-admin demotion; this stops the confusing self-demote path.
"Add account" becomes a toolbar button → modal (replaces the always-open form).
D. Rep drill-down — click a rep name (roster or staff list) → drill-down view: their leads this month, each row = customer name, phone as tel: link, Copy button (digits-only, matches existing clipboard convention), and a notes field with a Save button that appears only when the field is dirty. New lead.manager_note column + lead.setNote mutation (MANAGER/ADMIN/BDC-own), audit-logged. New router apps/api/src/routers/lead.ts, new page RepDetail.tsx.

E. Modals + keyboard — one Modal component (focus trap, Esc closes, Enter submits single-line, Ctrl+Enter submits textarea) + one useSubmitOnEnter hook. Migrate: deactivate-reason (StaffList), password reset, add account, void reason. Existing Alt+C / Alt+V / Ctrl+Enter on AssignScreen stay as-is.

F. Styling — copy design-system/\_ds/industry-\*/styles.css tokens into apps/web/src/styles/tokens.css, add a thin ui/ layer (Button, Table, Card, Badge, Modal, Field) using those vars, strip inline styles from the 5 pages. Barlow / Barlow Condensed self-hosted, not CDN.

G. Admin view-as — client-only. Admin picks a role in the nav; authStore gets viewAsRole, hasPermission reads effective role, persistent banner with "Exit". Server unaffected — real permissions unchanged, so it shows layout, not data-level access. Flagging: an admin viewing-as-REP still sees admin data on any screen that isn't role-filtered.

Order: A → C → B → E → D → F → G. A is the only thing touching the core loop; it ships and gets verified alone.

I have some more notes to add to this list. Apply them where applicable.

- Manual upload activity report.
  Export format is csv- {file link}.
  The top two rows are headers.
  Columns to pull data from:
  - Column N, "Calls"
    Log as a daily metric per rep (match by 'name': col A)
  - Column AA, "Sold"
    Cumulative metric added throughout the month.
    - Managers and admin can modify these metrics if needed, after import, always logged in the audit log.

**Minimum activity requirement: 10 calls/day**

- Less than 10 calls/day = deactivate for the rest of the week.
- Days off are not counted as non activity.
  - Need a field in the rep profiles for scheduled day off
- Example of how it should work:
  Rep A is off on Wednesday. On Tuesday they make 10 calls. On Wednesday morning, that activity is logged to their profile but they will be ineligible only because it is their day off. On Thursday, when the activity report is imported, they will register 0 calls but because they were off the day before, their activity would be based on the activity of the last day they worked.
- Deactivations reset every Monday.
- Reps can be Reactivated manually by a manager or higher role.
  - Reason field will be required and everything is logged to the audit log.
- All deactivation and reactivation should be treated the same way on the daily activity report, meaning manual switches should not have any different rules or behavior. All active reps are subject to the daily activity qualifier.

Rep Dashboard: **rep specific**

- Table of the month's assigned leads through the app
  - Date, name, number with quick copy, assigned by, and notes
- total ups assigned this month
- total calls made this month
- total monthly sales
- times deactivated this month
- Days inactive this month
