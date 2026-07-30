# Design & Repair Pass

## A. Rotation correctness (the only core-loop item)

Void today is broken three ways (assignment.ts:33-59): no advisory lock, leaves the rr_cycle_assignments row, leaves lastAssignedAt/upsToday stale. Fix: move void into apps/api/src/domain/voidLead.ts, mirroring assignLead:

pg_advisory_xact_lock(42_100_1) — same key, per CLAUDE.md.
Find the lead's ASSIGN event → its cycleNo.
Delete that rep's rr_cycle_assignments row for that cycle → rep is unserved again → ranking puts them back at top (they also have the lowest upsMtd after the decrement and oldest lastAssignedAt after restore). That is what makes next-up equal the rep you just undid.
Decrement upsMtd and upsToday; restore lastAssignedAt from that rep's previous ASSIGN event createdAt (null if none).
Cycle-close edge: if that assign closed the cycle, reopen it (closed_at = null) and delete the freshly-opened empty cycle. Otherwise undo silently jumps a whole rotation.
Append VOID event (ledger stays append-only), publish realtime.
Tests: undo → board.roster next-up is the voided rep; undo across a cycle boundary; concurrent void+assign.

## B. Roster buckets 

— four, non-leaky: Next Up (1) / On Deck (numbered 2..N, eligible + unserved) / Served This Cycle (with ups count) / Unavailable (with reason). Today "On Deck" wrongly includes served reps. Pure display change in AssignScreen; ranking untouched.

## C. Users page

Name column: show displayName, never email fallback; null renders muted "Set name". Run existing backfillDisplayNames.ts against prod.
Role dropdown disabled for your own row (any role, not just admin) — server already blocks last-admin demotion; this stops the confusing self-demote path.
"Add account" becomes a toolbar button → modal (replaces the always-open form).

## D. Rep drill-down

- click a rep name (roster or staff list) → drill-down view: their leads this month, each row = customer name, phone as tel: link, Copy button (digits-only, matches existing clipboard convention), and a notes field with a Save button that appears only when the field is dirty. New lead.manager_note column + lead.setNote mutation (MANAGER/ADMIN/BDC-own), audit-logged. New router apps/api/src/routers/lead.ts, new page RepDetail.tsx.

## E. Modals + keyboard 

- one Modal component (focus trap, Esc closes, Enter submits single-line, Ctrl+Enter submits textarea) + one useSubmitOnEnter hook. Migrate: deactivate-reason (StaffList), password reset, add account, void reason. Existing Alt+C / Alt+V / Ctrl+Enter on AssignScreen stay as-is.

## F. Styling 

- copy design-system/\_ds/industry-\*/styles.css tokens into apps/web/src/styles/tokens.css, add a thin ui/ layer (Button, Table, Card, Badge, Modal, Field) using those vars, strip inline styles from the 5 pages. Barlow / Barlow Condensed self-hosted, not CDN.

## G. Admin view-as 

- client-only. Admin picks a role in the nav; authStore gets viewAsRole, hasPermission reads effective role, persistent banner with "Exit". Server unaffected — real permissions unchanged, so it shows layout, not data-level access. Flagging: an admin viewing-as-REP still sees admin data on any screen that isn't role-filtered.

## H. Activity import (rewrite of crmImport)

The current importer is built for the wrong file. `crmImport.ts:11-20` parses `rep_email,occurred_at,note` — one row per call — and inserts one `lead_activity` row per call. The real export is an **aggregate-per-rep** report. Rewrite it.

Source shape (`Standard-Daily Activity 2026-07-29.csv`, verified):

- UTF-8 **BOM** on byte 0 — strip it or the first header cell reads `﻿""`.
- **Two** header rows: row 1 is a merged group band (`Opportunities`/`Appointments`/`Activity`/`Workplan`/`Performance`), row 2 is the real column names. Data starts row 3.
- Fields are quoted and numbers are quoted strings (`"3"`) — needs real quote-aware CSV parsing, not `line.split(',')`. Small dependency (`csv-parse/sync`) is fine here; the hand-rolled parser can't survive a rep name containing a comma ("Smith, Jr").
- Match key is **column A `User` = display name**, not email. Match against `sales_rep.display_name`, case- and whitespace-insensitive. No fuzzy matching — an unmatched name is a reported row, never a guess.
- Column **N `Calls`** (14th field) → daily metric.
- Column **AA `Sold`** (27th field) → that-day's sales count. Daily, same as `Calls`.

New table `rep_daily_activity` (one row per rep per business date, replaces per-call `lead_activity` rows as the eligibility input):

```
rep_daily_activity(id, rep_id, business_date, calls int not null default 0,
  sold int not null default 0, source text check in ('IMPORT','MANUAL'),
  imported_at, unique(rep_id, business_date))
```

- Import is **idempotent per (business_date, file)**: upsert on the unique key, not insert. Re-importing the same day overwrites `source='IMPORT'` values and never duplicates.
- Re-import must not silently clobber a manager's manual correction: if the existing row is `source='MANUAL'`, keep the manual value and report it as skipped in the import summary.
- `Sold` is a **per-day** count, stored per-day like `calls`. Month sales for a rep = `SUM(sold)` over the period. The unique `(rep_id, business_date)` key plus upsert-on-import is what keeps the sum honest — a re-import of the same day overwrites rather than adds. Verify on the first real import that a rep with a known sale shows `Sold=1` on the day it happened and not a running total; if the export turns out to be month-cumulative after all, the fix is read-side only (latest row instead of `SUM`).
- Import summary returned to the UI: rows parsed, reps matched, reps in the roster with **no row in the file** (they register 0 calls — that is a real signal, not an error), unmatched names, manual rows preserved.
- `businessDate` for the import is the **prior** day (the report is yesterday's activity, imported this morning). Parse it from the filename date as the default but let the importer take it explicitly — never infer it from `new Date()` inside the parser.
- ADMIN/MANAGER-only upload. Audit-log one `activity.import` event per run with the summary counts in `after`.

Eligibility rewire: `eligibility.ts:70-74` stops counting `lead_activity` rows and reads `rep_daily_activity.calls` for the prior workday. The IMPORT_LATE fail-open at `eligibility.ts:62-68` keeps the same shape — "no `rep_daily_activity` row for anyone on that date" → ELIGIBLE, never auto-DQ on a missing import. Keep `lead_activity` for optional note context; it is no longer an eligibility input.

Tests: BOM + two-header parse; quoted comma in a name; unmatched name reported not guessed; re-import idempotent; re-import preserves MANUAL; roster rep absent from file → 0 calls.

## I. Weekly deactivation + scheduled days off

Two gaps: the deactivation window is a week (code only does a day), and there is no recurring day-off field (so `eligibility.ts:44-51` writes `CONFIGURATION_ERROR` for any rep with no `rep_shift` row).

**Policy:** `work_requirement_policy.minCalls = 10`. Ships in **SHADOW** first per CLAUDE.md — the mechanism below computes and logs but enforces nothing until an ADMIN flips `enforcementMode` to `ENFORCE`. Shadow window 1–2 weeks; the thresholds are the thing being calibrated, not the data.

**Recurring day off.** New table (not a column — a rep can have more than one, and an array column can't be joined cleanly):

```
rep_recurring_day_off(id, rep_id, day_of_week smallint, unique(rep_id, day_of_week))
```

0=Sunday..6=Saturday, matching `store_hours.day_of_week`. A weekly job materializes `rep_shift` rows ~14 days ahead: `kind='OFF'` where the weekday matches a recurring day off, the weekday is Sunday, or the date is a `store_closure`; else `kind='WORK'`. One-off PTO/SICK rows written by a manager win over the generated row and the generator must never overwrite a manually-set kind. This is what stops `CONFIGURATION_ERROR` being the normal case.

Manager editing is the requirement here, so the UI is the deliverable, not just the table: on the rep profile / staff list, a row of seven weekday toggles, MANAGER+, saved in one mutation, audit-logged as `rep.days_off.set` with before/after. Changing a rep's days off re-materializes their **future** `rep_shift` rows only — never rewrites a past date, since past dates are eligibility evidence. Manually-set PTO/SICK/TRAINING rows survive the re-materialize.

**Sunday is closed** — hardcoded, no config surface. Seed `store_hours` Sunday with `is_closed=true` and have the generator treat weekday 0 as `OFF` for every rep. Nothing reads a Sunday, so Sunday needs no rep-level day-off entry and shouldn't consume one.

Day-off carry-forward already works: `findPreviousWorkday` (`eligibility.ts:15-29`) walks back to the last `kind='WORK'` day, so a rep off Wednesday is judged Thursday on **Tuesday's** calls. The worked example in the notes needs no algorithm change — it needs the shift rows to exist. Add a test for exactly that scenario.

**Week suspension.** Under 10 calls on the evaluated prior workday ⇒ ineligible for the **rest of the week**. Business week is **Monday–Saturday** (Sunday closed), store timezone `America/New_York` (same tz as the cron at `eligibility.ts:131`).

- Implement as **status writes only** — the ranking algorithm still reads exactly `rep_daily_status` and gains no branch (CLAUDE.md). On DQ, `upsertStatus` writes `INELIGIBLE` for today **and every remaining business date through Saturday**, reason `WEEK_DQ: N calls on <date>, 10 required`.
- Rows for future dates are written with `decidedBy='SYSTEM'`, so the nightly job's existing override guard (`eligibility.ts:34-37`) leaves a manager's later reactivation alone.
- "Resets every Monday" is then automatic — the write never crosses into next week, so Monday re-evaluates clean. No separate reset job.
- A DQ computed on **Monday** (from Saturday's calls) covers Mon–Sat. A DQ computed on Saturday covers one day. Both are correct; no special-casing.
- A day off inside a suspension stays ineligible-for-day-off; the DQ reason must not be lost. Precedence written down once: `MANAGER_OVERRIDE` > day off / closure > `WEEK_DQ` > eligible.

**Manual reactivation.** `overrideStatus.ts` already takes the advisory lock, requires `reasonNote`, and audit-logs — but it only touches **today's** row (`overrideStatus.ts:27-56`), so a `FORCE_ACTIVE` on a week-suspended rep silently re-DQs them tomorrow. Extend it: `FORCE_ACTIVE` clears the remaining `WEEK_DQ` rows through Sunday (delete the future `SYSTEM` rows, or upsert them to `ELIGIBLE`/`MANAGER_OVERRIDE`). `FORCE_INACTIVE` symmetrically writes through Sunday.

Manual and automatic deactivations are the same object — a manually deactivated rep who then gets reactivated is still subject to the daily 10-call qualifier the next morning, because reactivation only clears status rows and never marks a rep exempt. Test that explicitly; it is the note's requirement and the easiest thing to get wrong by adding an "exempt" flag.

Tests: DQ writes Tue–Sat and Monday is clean; DQ on Saturday writes one day; Sunday is never a business date; day off inside a suspension; reactivation clears the tail; reactivated rep re-DQs the next day on <10 calls; SHADOW mode writes the snapshot and the log but no `INELIGIBLE`.

## J. Manual metric correction

MANAGER/ADMIN can edit an imported `calls` or `sold` value after import. New `activity` router (`apps/api/src/routers/activity.ts`) with `activity.import` (H) and `activity.setMetric({repId, businessDate, calls?, sold?, reasonNote})`.

- Writes `rep_daily_activity` with `source='MANUAL'` so a re-import won't clobber it (H).
- `reasonNote` required. Audit-logged `activity.metric.edit` with before/after values — the ledger of why a number differs from the CRM.
- Editing `calls` for a date that a later day's eligibility already consumed does **not** retroactively un-DQ anyone. If a manager wants that, they use manual reactivation (I) — one path for changing a rep's status, and it is the audited one. Say this in the UI copy next to the field.
- UI: inline edit on the rep drill-down (D) using E's Modal for the reason prompt.

## K. Rep dashboard (rep-facing)

Rep's own view at `/me`; a REP sees only their own data, MANAGER/ADMIN can reach the same view for any rep via D's drill-down (one component, `repId` prop defaults to self).

Table — this month's leads assigned through the app: date, customer name, phone (tel: link + Copy button, digits-only, same convention as D), assigned by (the BDC/manager who created it), notes. Reuses D's `lead` router and `manager_note`; a REP reads notes and does not write them.

Counters, all scoped to the current calendar `period_key`:

- Total ups this month — `rep_month_counters.upsMtd` (already exists, already void-correct after A).
- Total calls this month — `SUM(rep_daily_activity.calls)` over the period.
- Monthly sales — `SUM(rep_daily_activity.sold)` over the period.
- Times deactivated this month — count of distinct DQ episodes, not ineligible days: one `WEEK_DQ` suspension = 1, however many days it spans. Count from the `eligibility_snapshot` / status-write side, not by counting `INELIGIBLE` rows.
- Days inactive this month — count of dates where `rep_daily_status.status='INELIGIBLE'`. Scheduled days off are **not** inactive days and must be excluded, otherwise every part-week rep looks delinquent.

Both metrics are read-only here. Reps have no route that writes status or activity.

### Backlog (not K, revisit after K ships): mark a lead sold

A "Sold" button on the lead row, MANAGER/ADMIN only, so a specific lead can be tied to a sale instead of only a daily count. Deferred because the two sale numbers would then disagree and the reconciliation isn't designed yet:

- `rep_daily_activity.sold` comes from the CRM and counts **every** sale a rep made. Lead-level marks only cover phone-ups assigned through this app. The app number will always be ≤ the CRM number, and the dashboard has to show which one it's showing.
- Open question to settle first: is the lead mark just an attribution tag on top of the CRM total, or does it become the sales number for reps? Attribution tag is the cheaper answer and doesn't touch the import.
- Likely shape when it happens: `lead.sold_at` + `lead.sold_marked_by`, `lead.setSold` mutation (MANAGER/ADMIN, audit-logged, unset allowed), and a "sold via app" column on the dashboard shown *next to* CRM monthly sales, never replacing it.
- Touches no rotation state — a sold lead is still a consumed up. Nothing here goes near the assignment path.

Order: A → C → B → E → H → I → D → J → F → G → K. A is the only thing touching the core loop; it ships and gets verified alone. H before I because the weekly rule is meaningless until real call counts land, and both before D/K because the rep-facing screens read the numbers those two produce.

# Additional notes (source for H–K; kept for reference): 

- **Manual upload activity report**
  Export format is csv: '../../Standard-Daily Activity 2026-07-29.csv'
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

**Rep Dashboard: **rep specific**

- Table of the month's assigned leads through the app
  - Date, name, number with quick copy, assigned by, and notes
- total ups assigned this month
- total calls made this month
- total monthly sales
- times deactivated this month
- Days inactive this month
