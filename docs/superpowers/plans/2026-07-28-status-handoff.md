# Status Handoff — 2026-07-28

## Where things are

Phase 1 (core loop) of `plans/v1-plan.md` is built, merged to `main`, all tests green.

**On `main`, latest commit `bf59daf`.** No open branches, working tree clean except an untracked `Name Email Role.tsv` at repo root (not part of this project's build — untouched, presumably user's own reference file).

### What's implemented
- `packages/core` — pure `businessDate`/`periodKey`, `rankReps` (spec §0.4 ranking algorithm)
- `packages/contracts` — role/permission matrix (4 roles: ADMIN/MANAGER/BDC/REP), Zod input schemas
- `packages/db` — Drizzle schema (22+1 tables), migrations, dev seed script
- `apps/api` — Fastify + tRPC v11:
  - `assignLead` — the core transaction: `pg_advisory_xact_lock` + append-only `assignment_events` ledger + `rep_month_counters` projection + idempotency key, all one tx. Proven correct under concurrent load (10 parallel calls, idempotency retry burst).
  - `overrideStatus` — manager override, same advisory lock, audit trail
  - eligibility job — SHADOW mode, fail-open (dead job → ELIGIBLE), fail-safe (missing schedule → CONFIGURATION_ERROR), IMPORT_LATE never auto-disqualifies
  - CRM import job — manual CSV upload, matches rep by email
  - nightly reconciliation job — ledger vs counters drift detection
  - in-process ws realtime fan-out for board sync (no Redis)
  - auth (cookie sessions, not JWT), CORS for cross-origin dev
- `apps/web` — Vite/React, hand-rolled fetch-based tRPC client (not `@trpc/client`, avoids RC version-alignment risk). Screens: Login, AssignScreen, StaffList, Dashboard. Manually verified working in real browser via Playwright MCP.

### Test status
`pnpm test` — all 6 workspace projects pass (core, contracts, db, api). `packages/db` has no test files yet (fixed to `--passWithNoTests` so it doesn't false-fail the root script). Integration tests hit a dedicated `phoneup_test` Postgres db (isolated from `phoneup_dev`), `fileParallelism: false` required (shared live DB, no per-test isolation).

### Local dev environment
- Postgres 16 via Homebrew, running as a service.
- DBs: `phoneup_dev` (manual/browser testing, reseed periodically), `phoneup_test` (vitest only).
- Seeded users, password `changeme` for all: `admin@dealership.test` (ADMIN), `bdc@dealership.test` (BDC), plus 3 reps.
- Run: `pnpm --filter @phoneup/api dev` (port 3000) + `pnpm --filter @phoneup/web dev` (port 5173).

## What's explicitly NOT built yet (deferred, not started)

Per `plans/v1-plan.md` Phase 2 and CLAUDE.md's cut list — none of these were asked for this session, don't start without explicit ask:
- Admin screen (policy/enforcement-mode config, role grants)
- Reactivation request review queue (REP submits, MANAGER reviews)
- Flipping eligibility from SHADOW → ENFORCE (needs real-world threshold calibration first, per CLAUDE.md — shadow window 1-2 weeks minimum)
- Any reporting/dashboard beyond the minimal Dashboard screen already built (no calendar heatmap, conversion funnels, Gini scores — explicitly cut in CLAUDE.md)

## Known deviations from the original plan doc (deliberate, not defects)
- Web app uses a hand-rolled fetch-based tRPC client instead of `@trpc/client` / `@trpc/tanstack-react-query`, to sidestep tRPC v11 RC version-alignment risk. Same HTTP endpoints, same behavior — just a simpler client implementation.

## Suggested next steps (not started, need user direction)
1. Decide whether to push `main` to a remote (not yet pushed anywhere — this has been entirely local so far).
2. Let the eligibility SHADOW job run for real for 1-2 weeks against real CRM import data before considering ENFORCE mode, per CLAUDE.md's explicit calibration requirement.
3. If continuing Phase 2 work (admin screen, reactivation queue), start with `superpowers:brainstorming` per this project's skill workflow before writing a new plan doc.
