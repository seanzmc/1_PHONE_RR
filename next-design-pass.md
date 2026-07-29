Design
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

F. Styling — copy design-system/_ds/industry-*/styles.css tokens into apps/web/src/styles/tokens.css, add a thin ui/ layer (Button, Table, Card, Badge, Modal, Field) using those vars, strip inline styles from the 5 pages. Barlow / Barlow Condensed self-hosted, not CDN.

G. Admin view-as — client-only. Admin picks a role in the nav; authStore gets viewAsRole, hasPermission reads effective role, persistent banner with "Exit". Server unaffected — real permissions unchanged, so it shows layout, not data-level access. Flagging: an admin viewing-as-REP still sees admin data on any screen that isn't role-filtered.

Order: A → C → B → E → D → F → G. A is the only thing touching the core loop; it ships and gets verified alone.
I have some more notes to add to this list. Apply them where applicable. The manual upload of activity report. Trying to figure out if automation is possible. Export format is csv- ex attached.  and it has a ton of columns with two rows of headers. but the only columns that are relevant for the app are column N, header in row 2: "Calls" which should be logged as a daily metric per rep (name is column A) Then column AA (Sold) which should be a cumulative metric added to each rep's monthly total. So if the previous working day's activity is less than 10 calls/day then they  Deactivate for the rest of the week. So we need to Build a field for the rep profiles with their scheduled day off so days off are not counted as non activity. This is an  example of how it should work: if a rep is off on Wednesday, their status would be set on wednesday morning with everyone else based on tuesdays activity. So if they got their calls then they will be eligible, but the day off marks them inactive for the day, then the next day their eligibility will be preserved because the last day they worked they achieved their activity minimum. Deactivations reset every Monday. Reps can be Reactivated manually by a manager or higher role. Reason field will be required. Manual deactivations should last all week as well unless manually reinstated. All active reps are subject to the daily activity qualifier. The drill down section for a rep should contain a calendar shaped table of the month's activity- Each day should display the calls activity from the upload, how many ups assigned to them, how many times an up was assigned to them then reassigned.. There should be a rep specific dash of the assigned leads with the notes as stated, total monthly sales, and times deactivated. These totals should be monthly.