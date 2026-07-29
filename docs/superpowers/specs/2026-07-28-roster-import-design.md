# Design: Real Roster Import

## Context

Phase 1 (core loop) is done and merged. Before going live (target: within a day), the app needs the real dealership staff loaded in place of the fake demo seed data (`Alex Rep`/`Bailey Rep`/`Casey Rep`).

Source data: `Name Email Role.tsv` at repo root — 37 real staff rows (24 `Sales`, 6 `Manager`, 7 `BDC`), tab-separated `Name\tEmail\tRole`, header row present. Contains real employee PII (names, work emails) — must never be committed to git.

This is one of five sub-projects identified in this session (roster import, permission refinements, CRM-import name-matching, assign-screen UX overhaul, dashboard metric respec). This spec covers **roster import only**; the other four are queued separately and untouched here.

## Decisions

- **One-time script**, not a reusable admin upload feature. New hires after this get added manually via the existing Staff List screen.
- **Separate script** from `packages/db/src/seed.ts` — `seed.ts` stays as-is for local demo/testing. New script: `packages/db/src/importRoster.ts`.
- **Role mapping**: TSV `Sales` → app role `REP` **and** a `sales_rep` row (rotation membership). TSV `BDC` → app role `BDC`, no `sales_rep` row. TSV `Manager` → app role `MANAGER`, no `sales_rep` row. This is what makes "only Sales reps are in the round-robin" structurally true — the ranking algorithm already only ever reads `sales_rep`/`rep_daily_status`, so BDC/Manager accounts simply never appear there. No new guardrail logic needed.
- **ADMIN**: one account for `seanzmc9613@gmail.com`, not sourced from the TSV (TSV has no ADMIN row).
- **hireDate**: `sales_rep.hireDate` is `NOT NULL` but the TSV has no hire dates and none are needed for this launch. Default to the import run date. Harmless — `graceDaysAfterHire` only matters once eligibility enforcement is live, which it isn't (SHADOW mode).
- **Password**: shared temp password `changeme` for all imported accounts, same pattern as the existing dev seed. Accepted risk for a fast launch — auth hardening (forced reset, per-user passwords) is an explicit fast-follow, not part of this script.
- **Transactional, guarded**: the whole import runs in one DB transaction. Before writing anything, it checks no `store` row already exists and aborts with a clear message if one does (prevents a half-completed import from a duplicate run or wrong target DB) — stricter than `seed.ts`, which has no such guard, because this touches whatever `DATABASE_URL` points at, which may be the real launch DB.
- **`.gitignore`**: add `Name Email Role.tsv` so the PII file can never be accidentally committed, especially with a remote push now imminent.

## What the script does

1. Read TSV from repo root (path overridable via CLI arg, default `./Name Email Role.tsv` resolved from cwd).
2. Parse: skip header line, split each row on tabs into `name`, `email`, `role`.
3. Open one transaction:
   - Guard: abort if `store` table already has a row.
   - Insert `store` (name, random `rotation_salt`, empty settings) + 7 `store_hours` rows (Mon–Sat 09:00–20:00, Sunday closed — same defaults as `seed.ts`).
   - Insert `work_requirement_policy` (minCalls 3, graceDaysAfterHire 3, graceAfterAbsenceDays 1, maxPriorWorkdayAge 7, enforcementMode SHADOW — same as `seed.ts`).
   - Insert ADMIN `app_user` for `seanzmc9613@gmail.com` / `changeme`.
   - For each TSV row: insert `app_user` (email, `hashPassword('changeme')`, mapped role). If role is `Sales`: also insert `sales_rep` (userId, displayName = name, hireDate = today), `rep_shift` (WORK, today), `rep_daily_status` (ELIGIBLE, today, decidedBy SYSTEM) — same shape as `seed.ts`'s per-rep setup.
   - Insert one open `rotation_cycle` + `rr_state` pointing at it.
4. Print a summary (counts by role, admin login) on success. Exit non-zero on any failure (transaction rolls back automatically).

## Wiring

- `packages/db/package.json`: add `"import-roster": "tsx src/importRoster.ts"` script, same pattern as the existing `"seed"` entry.
- Run via `pnpm --filter @phoneup/db import-roster` against whichever `DATABASE_URL` is active.

## Testing

- Manual: run against a fresh local Postgres DB, verify row counts (37 `app_user` + 1 admin, 24 `sales_rep`, correct role split), spot-check a few names/emails, confirm re-running against the same DB aborts cleanly via the guard rather than partially inserting.
- No unit tests planned — this is a one-shot operational script, not app logic. If the guard/parsing logic proves fiddly in practice, a table-driven test for the TSV parser alone is cheap to add, but not required up front.

## Out of scope (queued separately, not this spec)

- Permission refinements (BDC gets `lead.reassign`, confirming reps-only-in-rotation — already true structurally per this script's role mapping, but the permission matrix itself isn't being touched here)
- CRM import matching by name instead of email
- Assign-screen UX overhaul (keyboard-first, spreadsheet-feel)
- Dashboard metric respec (assignments, reassignments, times deactivated, total sales from a sales log; converted sales pinned/deferred)
- Hosting/deployment (remote push, prod environment) — flagged as urgent given the go-live timeline, but not part of this script
