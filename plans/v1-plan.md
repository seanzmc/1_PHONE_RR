# v1 Build Spec — PhoneUp Round-Robin Tool

Trimmed from `fusion-plan.md` to single-team, single-store scope. See `CLAUDE.md` for the guardrails this spec is built under. Where this doc and `fusion-plan.md` disagree, follow this doc.

---

## 0. Non-negotiable core (build first, correctly, don't shortcut)

1. **One `pg_advisory_xact_lock` per assignment transaction**, keyed on the store (single store, so effectively a single global lock for this app). Every ordering-changing action takes it: assign, void, reassign, status override, reactivation approval.
2. **Append-only `assignment_events` ledger** + `rep_month_counters` projection written in the same transaction + nightly reconciliation job that rebuilds counters from the ledger and alerts on mismatch.
3. **`rep_daily_status` is the only table the ranking algorithm reads.** Schedule import, disqualification job, manager override, reactivation — all write to it, never branch the algorithm.
4. **Ranking function lives in a pure module** (`packages/core`, zero I/O imports) so it's unit/property-testable in isolation: eligibility filter → sort by (served-this-cycle, monthly load, last-assigned-at, stable rotation seed, rep id).

Everything below builds around this core.

---

## 1. Stack

- Frontend: React 18 + TS (Vite) + TanStack Query (server state) + Zustand (small UI/draft state only)
- API: Fastify + tRPC v11 + Zod
- DB: PostgreSQL + Drizzle (raw SQL where Drizzle's DSL can't express it — partial indexes, exclusion-free here since no fiscal periods, append-only `CREATE RULE`)
- Realtime: `ws` + in-process EventEmitter fan-out (no Redis — single instance, ~44 users)
- Jobs: node-cron in-process (nightly reconciliation, nightly eligibility, CRM import trigger/reminder)
- Auth: Postgres-backed sessions, httpOnly cookies. TOTP optional for MANAGER/ADMIN.
- Hosting: single region, single Postgres instance w/ PITR backup.

Monorepo:
```
apps/web        Vite React SPA
apps/api        Fastify + tRPC
packages/db     Drizzle schema + migrations + seed
packages/core   pure domain logic: ranking, eligibility, workday math — zero I/O
packages/contracts  Zod schemas + permission constants
```

---

## 2. Data model (trimmed)

Cut from fusion-plan: no `store` plurality (one row, seeded once), no `fiscal_period` table (calendar month via `period_key = 'YYYY-MM'` computed directly), no RLS, no S3 evidence tables at v1, no hash-chain columns on audit.

Kept, same shape as fusion-plan:

```
store                 (one row: name, timezone, rotation_salt, settings jsonb)
store_hours           (per day-of-week open/close)
store_closure         (holidays/closures)
app_user              (email, password_hash, totp_secret, is_active)
sales_rep             (store_id, user_id, display_name, hired_on, terminated_on,
                        rotation_groups[] default '{PHONE_UP}', weight default 1.00,
                        is_house_account)
rep_shift             (rep_id, business_date, kind: WORK|OFF|PTO|SICK|TRAINING|SUSPENDED)

work_requirement_policy   (min_calls, calls_per_lead, min_notes, min_note_chars,
                            min_shift_hours, grace_days_after_hire, grace_after_absence_days,
                            max_prior_workday_age, enforcement_mode: SHADOW|ENFORCE)
eligibility_snapshot      (immutable per rep/day evaluation record, versioned)
rep_daily_status          (THE table the algorithm reads: status, reason, decided_by, daily_cap)
status_override           (append-only override log, mandatory reason_code + reason_note)

customer              (full_name, phone_e164, phone_digits generated, do_not_call)
lead                  (customer_id, assigned_rep_id, source_id, vehicle_*, stock_number,
                        status, business_date, period_key, created_by [BDC actor])
lead_source           (label, short_key, hotkey_slot)
lead_activity         (rep_id, lead_id, kind, note_body, occurred_at, business_date,
                        entry_source: WEB|CRM_IMPORT — CRM_IMPORT rows are what
                        eligibility actually counts against)

assignment_events     (append-only ledger: ASSIGN|SKIP|VOID|REASSIGN_OUT|REASSIGN_IN|
                        BALANCE_CREDIT, cycle_no, credit_delta, queue_snapshot jsonb,
                        idempotency_key)
rotation_cycle         (per-cycle bookkeeping, one_open_cycle unique index)
rr_cycle_assignments   (which reps consumed this cycle)
rr_state               (current_cycle, version — OCC token for clients)
rep_month_counters     (projection: ups_mtd, charged_skips_mtd, credit_mtd, ups_today,
                         last_assigned_at — rebuildable, never source of truth)

reactivation_request   (claim_text only at v1 — no evidence upload table yet;
                         add evidence table later if disputes actually need it)
audit_events           (append-only, before/after jsonb, no hash-chain sealing at v1)
unassigned_queue       (leads with zero eligible reps — never drop a live phone-up)
daily_facts            (nightly rollup for the dashboard)
```

`business_date`/`period_key` computed by one function (`businessDate(instant, tz)` in `packages/core`), never a generated column (timezone conversion isn't `IMMUTABLE`).

---

## 3. Roles & permissions (4 roles, enforced server-side per request)

| Permission | ADMIN | MANAGER | BDC | REP |
|---|:---:|:---:|:---:|:---:|
| `board.view` | ✅ | ✅ | ✅ | ✅ self |
| `lead.assign` | ✅ | ✅ | ✅ | — |
| `lead.void` (own, time-boxed) | ✅ | ✅ | ✅ | — |
| `lead.assign.override` / `lead.reassign` | ✅ | ✅ | — | — |
| `rep.override` (activate/deactivate) | ✅ | ✅ | — | — |
| `schedule.manage` (staff list, shifts) | ✅ | ✅ | — | — |
| `activity.self` | ✅ | ✅ | ✅ | ✅ |
| `reactivation.review` | ✅ | ✅ | — | — |
| `reactivation.self` | — | — | — | ✅ |
| `audit.view` | ✅ | ✅ | — | — |
| `admin.*` (policy, enforcement mode, roles) | ✅ | — | — | — |

Checked via `requirePerm()` tRPC middleware on every mutation and query, never client-side only. Tenancy (`store_id`) always taken from session, never client input.

---

## 4. The assignment transaction (the one thing to get right)

Inside `pg_advisory_xact_lock`:
1. Idempotency short-circuit (client-supplied key, exactly-once under retry/double-Enter).
2. Resolve `business_date`/`period_key` inside the lock.
3. Lazy `ensureEligibilitySnapshots()` — if the nightly job died, compute now rather than trust stale data.
4. Get-or-open the current cycle.
5. Rank all members (eligible + ineligible, for full board display) via the pure ranking function.
6. Emit `SKIP` ledger events for ineligible members not yet consumed this cycle (fixes the "cycle never closes" problem).
7. Choose: forced rep (manager override, requires `lead.assign.override`) or first eligible.
8. If nobody eligible: insert into `unassigned_queue`, notify managers, **never drop the lead**.
9. Duplicate-phone check: **warn, never block** — a live call must never be gated on this.
10. Write lead + `ASSIGN` ledger event (with full `queue_snapshot` for replay) + bump `rep_month_counters` + consume cycle slot, all in the same transaction.
11. Cycle-completion check; close/reopen cycle if every eligible rep has been served.
12. Publish realtime event **after commit**, never inside the transaction.

Two BDC agents submitting within 50ms: agent A gets the lock, assigns, commits. Agent B was blocked ~1-2ms, re-ranks against the now-committed state, gets the correct next rep — no optimistic guess of *who*, only optimistic *form clearing*. Response tells agent B the real assignee.

---

## 5. Assignment drill-down data (per your explicit ask)

Every assignment must expose, in one panel from the board:
- Customer name + phone (`customer.phone_e164`), with a **one-click copy button** — copies digits only, leading `1` stripped, no formatting (dealer CRM search boxes choke on formatted numbers). Auto-focused for ~5s right after assignment so the loop is: assign → `Enter` → paste in CRM.
- Vehicle interest, stock number, lead source
- Timestamp + logging BDC agent
- Full ranked-roster snapshot at decision time (`assignment_events.queue_snapshot`) — answers "why did X get it" without re-deriving from possibly-mutated state
- Subsequent `lead_activity` rows tied to that lead (calls/notes logged against it)

This is schema fusion-plan already provides — just make sure the entry-screen UI surfaces it as one drill-down panel, not scattered across views.

---

## 6. Daily eligibility job

Runs early (before shift start), store-local time, node-cron. For each active rep:
1. Find rep-relative previous working day (store open AND rep scheduled AND employed), bounded by `max_prior_workday_age`.
2. Pull calls/notes for that day **from CRM-imported `lead_activity` rows** (`entry_source = 'CRM_IMPORT'`) — this is real data, not self-reported, so skip note-hash/burst-backdate fraud heuristics entirely.
3. Compute required calls (`max(min_calls, ceil(calls_per_lead × leads_received))`) and required notes.
4. Write immutable `eligibility_snapshot`, then write `rep_daily_status` (unless a manager override already exists for today — override always wins).
5. In `SHADOW` mode: compute and log, but status still resolves `ELIGIBLE`; email/dashboard-notify managers "who would have been cut." Flip to `ENFORCE` per policy after 1-2 weeks of shadow review.

**Fail-open on job death:** if the job doesn't run, `ensureEligibilitySnapshots()` runs lazily inside the next assignment transaction. If evaluation itself errors, everyone defaults `ELIGIBLE` and this pages someone — a store that can't distribute phone-ups can't sell cars.

**Fail-safe on missing schedule:** no `rep_shift` rows for today → `CONFIGURATION_ERROR`, alert, board banner. Never silently assume everyone's working.

---

## 7. Daily CRM import (the one accepted clerical task)

A manager or admin uploads/imports the previous day's call-activity export from the CRM each morning. Job parses it into `lead_activity` rows (`entry_source: 'CRM_IMPORT'`) keyed to rep + date (and lead, where matchable). This is the actual accountability input — self-logged notes in the app are optional context, not what disqualification counts against. No malware scanning or evidence pipeline needed for this — it's an internal ops import, not user-submitted evidence.

**Decided:** if the import is late or missing for a rep/day, the eligibility job treats that rep as `ELIGIBLE` for that evaluation (fail toward not cutting someone on bad data) and raises a visible `IMPORT_LATE` alert on the manager dashboard/board banner — "eligibility numbers for [date] don't reflect real activity yet, DQ evaluation skipped." Never auto-disqualify off a zero that's really just a missing import. Once the import lands (even after the fact), the eligibility job can be manually re-run for that date to backfill the real evaluation (writes a new `eligibility_snapshot` version; `rep_daily_status` for that past date is not retroactively changed per the "no retro-fixing yesterday" rule — this only matters going forward for that day's live status, so a late backfill is informational/audit only unless still same-day).

---

## 8. Screens (v1 only)

1. **Assign screen (the star).** Lead entry form (phone, name, source, vehicle, optional notes) + full roster panel (Next Up pinned, on-deck list, unavailable-with-reason list) + just-assigned drill-down card with quick-copy. Keyboard-first: `Ctrl+Enter` submits to Next Up, `Alt+C` recalls last copied phone.
2. **Staff list / status toggle (Manager+).** Roster table, one-click Force Active / Force Inactive / Follow Schedule per rep, mandatory reason, visible on the row afterward (no anonymous overrides). Shift entry here too (manual only — CSV import can wait).
3. **My status (Rep, view-only).** Own eligibility status + reason text (`computed_reason` shown verbatim) + reactivation request form if disqualified.
4. **Reactivation queue (Manager+).** Pending requests, approve/deny + reason, no self-approval.
5. **Dashboard (Manager+), minimal 4 widgets.** Ups-per-rep this month, current cycle progress, disqualification count/list, override count. Nothing else at v1 — no calendar heatmap, no conversion funnel, no fairness scores.
6. **Admin (Admin only).** Policy editor (thresholds, enforcement mode toggle), role management, audit log.

---

## 9. Testing (minimum bar before calling v1 done)

- Pure-function tests on ranking/eligibility (`packages/core`) — table-driven at minimum; property-based (fast-check) if time allows, cheap since zero I/O.
- Concurrency integration test: N parallel `assignLead` calls across M reps → assert no double-serve within a cycle, counters match ledger, exactly-once under retry with same idempotency key.
- Eligibility edge cases: rep off yesterday (exempt), rep back from a week of PTO (grace, doesn't reach back), month boundary, DST boundary if applicable.
- Manual QA pass: two browser tabs, simultaneous submit, confirm both converge to correct distinct assignees.

---

## 10. Phased delivery

**Phase 1 — core loop (target: fastest possible working demo).**
Auth (4 roles) → schema above minus anything marked "add later" → assign screen w/ advisory-locked transaction, ledger, counters, reconciliation job → one-click status override w/ audit → in-process realtime board sync → quick-copy + drill-down panel → daily CRM import (manual upload → parse job) → eligibility job in SHADOW mode → minimal 4-widget dashboard.

**Phase 2 — enforcement + reactivation.**
Flip `enforcement_mode` to `ENFORCE` after reviewing shadow reports. Reactivation request/review flow (text-based, no evidence upload yet). Policy editor with dry-run simulator ("under this policy, last 30 days would've produced N DQs instead of M").

**Phase 3 — trust & polish, only as needed.**
Whatever the cut list in `CLAUDE.md` deferred, revisit only if a real need shows up: evidence uploads, calendar heatmap, conversion tracking, override-abuse reporting, CSV schedule import, mobile rep view.

---

## The one thing to remember

Lock + ledger + `rep_daily_status`-as-single-read-table is the whole correctness story. Get that right first, hammer it with the concurrency test, and every other screen is just a view over data that's already correct.
