# PhoneUp Round-Robin Tool — Project Guardrails

## What this is

Internal tool for one dealership team: assign inbound phone-up leads to sales reps via round-robin, track fairness, and manage rep active/inactive status. **Single team, single rotation queue, single store.** Not a multi-department CRM, not a multi-rooftop platform. Do not build toward those unless explicitly asked.

Team size: ~6 managers, ~30 sales reps, ~8 BDC agents. Built and maintained by one solo dev.

## The one thing this tool must always do well

Assign a phone-up lead to the correct next rep, correctly, in under a few seconds, even with multiple BDC agents submitting at once. Everything else (dashboards, calendars, reports) is secondary and must never slow down or complicate that core loop.

**Before adding any feature, ask:** does this make assigning a lead faster or more correct, or is it a reporting/nice-to-have? If the latter, it's backlog, not core.

## Source documents

- `plans/fusion-plan.md` — the full original architecture (comprehensive, higher-rigor option). Source of truth for schema/algorithm details.
- `plans/poe-plan.md` — alternate architecture, simpler stack, not the chosen path but useful for comparison.
- `plans/plan-compare.md` — comparison of the two.
- `plans/v1-plan.md` — **the actual build spec.** This is what to implement. It's fusion-plan trimmed down to single-team scope — follow it, not the untrimmed fusion-plan, when the two disagree on scope.
- `docs/RUNBOOK.md` — **how this gets deployed, onboarded and operated.** Env vars, first-deploy order, day-one sequence, daily chores, troubleshooting, known gaps. Update it when you change any of those, not just the code.

## Decided architecture (do not re-litigate without reason)

- **Stack:** Fastify + tRPC v11 + Zod, Drizzle ORM, PostgreSQL, in-process WebSocket (no Redis at this scale), node-cron in-process jobs.
- **Truth model:** append-only `assignment_events` ledger + `rep_month_counters` projection, rebuildable from the ledger, nightly reconciliation job asserts they match. Never replace this with plain counter increments — it's what makes "why wasn't I next" answerable and drift detectable. Reconciliation compares `sum(credit_delta)` against `ups_mtd` — **not** a count of `ASSIGN` rows. A void leaves its ASSIGN in place and appends a VOID with `credit_delta -1`; counting ASSIGN rows made every voided lead a permanent false alarm.
- **Concurrency:** one `pg_advisory_xact_lock` per assignment transaction. This is the load-bearing correctness mechanism for multi-BDC-agent races. Every path that changes ordering (assign, void, reassign, status override, reactivation) takes the same lock.
- **The algorithm reads exactly one table: `rep_daily_status`.** Schedule, disqualification, manager override, reactivation — all of these only ever *write* that table. Never add a branch to the ranking/eligibility algorithm for a new edge case; add a status write instead.
- **Call activity is CRM-exported, not self-reported.** Daily clerical task: import prior day's call activity from the CRM export. This is the one accepted manual chore — do not build fraud-detection heuristics (note-hash dedup, burst-backdate detection) since the data is already externally verified. Keep note-logging simple/optional context.
- **Disqualification is applied by a manager click, not by a job.** The activity import is the gate: after the CSV is parsed and matched, the manager sees a preview of who would be deactivated and picks one of three outcomes — *log numbers & deactivate N*, *log numbers only*, or *cancel the entire import*. Log-only and deactivate both write `rep_daily_activity` and the `eligibility_snapshot` rows, so the calculation is on record either way; only the deactivate branch writes `rep_daily_status` (suspension runs through Saturday). Cancel writes nothing at all — preview is side-effect-free by design. This human gate replaces the SHADOW → ENFORCE rollout: the thresholds still need calibration, and a manager reviewing each day's list is a better calibration loop than a policy flag nobody can see. Do not add an automatic deactivation path that skips this prompt.
  - The nightly eligibility job still computes and writes status, but it never deactivates off call thresholds — threshold-driven `INELIGIBLE` only ever originates from an import decision.
  - `enforcement_mode` stays in `work_requirement_policy` and stays `SHADOW`; it is no longer what gates deactivation. Do not wire the import decision to it.
  - The commit path is `apps/api/src/jobs/activityImportDecision.ts`. It re-derives the preview inside the transaction and rejects a stale decision via an HMAC preview token — a manager cannot apply a "Yes" to numbers that changed after they reviewed them. A `MANAGER_OVERRIDE` status always wins over an import-driven write. Keep both properties.

## Roles (exactly 4 — do not add more without explicit ask)

| Role | Can do |
|---|---|
| ADMIN | Everything, including policy/enforcement-mode config and role grants |
| MANAGER | Activate/deactivate any rep, override/reassign assignments, manage staff list & schedule, review reactivation requests, view audit log |
| BDC | Assign/unassign leads (create + assign, void own within time window), log own activity |
| REP | View own status/leads only, submit reactivation requests |

## Explicitly cut from v1 (fusion-plan has these; do not build them without a real reason surfacing)

- Multi-store tenancy, Postgres RLS, multi-region hosting
- Multiple rotation groups (INTERNET/WALK_IN/COMMERCIAL) — `rotation_group` column exists in schema for future-proofing but app logic is hardcoded to `PHONE_UP`
- Custom fiscal periods — calendar month only
- Reactivation evidence upload pipeline (S3, malware scan, sha256 dedupe) — text-based manager review is enough until disputes actually require attachments
- Hash-chained tamper-evident audit log sealing — plain append-only table + no-update/no-delete DB rules is enough
- Redis (pub/sub, caching) — in-process EventEmitter for realtime fan-out at this scale
- Graphile Worker — node-cron in-process is permanent, not a stepping stone
- OpenTelemetry tracing, formal SLO alerting — pino logs are enough until something is actually slow
- Offline IndexedDB outbox, multi-tab BroadcastChannel dedup
- Part-time weighting UI (column exists, defaults to 1.0, no UI unless part-timers actually show up)
- Calendar heatmap, conversion funnels, Gini fairness scores, override-abuse digest emails — backlog, build only after the core loop and a minimal dashboard are solid

## When in doubt

Re-read `plans/v1-plan.md`. If a request would expand scope beyond it, flag that explicitly before building rather than quietly absorbing it.

## Accounts & passwords

- **No shared passwords, ever.** `importRoster.ts` issues a unique short temporary password per account and prints a distribution list once. There is no default password to guess.
- Any admin-issued password (roster import, `issueTempPassword`, manual reset, new account) sets `app_user.must_change_password`. While that flag is set, `requirePerm` rejects **every** route with `PASSWORD_CHANGE_REQUIRED` — only `auth.changePassword` is reachable. The gate is server-side; do not weaken it to a UI-only check.
- Temp passwords are deliberately short and speakable (`word-word-NNN`, no `0`/`1`) because they are single-use. That is only safe alongside the login throttle in `auth/loginThrottle.ts` (8 failures per email/IP, then a 15-minute lockout) — do not remove one without reconsidering the other.
- Plaintext passwords are never stored. A lost temp password means issuing another from the Users page.
- **One generator: `generateTempPassword` in `packages/core`.** The roster importer, the dev seed and `issueTempPassword` all call it. Do not add a second copy — a local copy is how a shared default sneaks back in.
- `seed.ts` is a dev fixture and enforces that: it refuses to run against a non-local `DATABASE_URL` or with `NODE_ENV=production`, refuses an already-initialised database, and issues a unique temp password per account. Real deployments use `import-roster`.

## Auth surfaces

Every path that serves board data applies the same three checks, in the same order: session present → `mustChangePassword` rejected → role holds the permission. `requirePerm` does it for tRPC; `authorizeBoardSocket` (`realtime/server.ts`) does it for the `/ws/board` upgrade. **Do not add a data-carrying transport without that check** — the socket shipped without one and streamed rotation state to anonymous clients.

Because the session cookie is `sameSite=lax` and a WebSocket handshake is not a top-level navigation, the socket only works same-origin. Production is same-origin already; development proxies `/trpc` and `/ws/board` through Vite (`apps/web/vite.config.ts`) to match. The web client's API base is relative (`/trpc`) in both — do not make it absolute again.

## Checks

`pnpm typecheck` is the only thing that typechecks `apps/api` — it ships via `tsx`, which strips types without checking them. CI (`.github/workflows/ci.yml`) runs typecheck, tests and build on every push to `main` and every PR against a throwaway Postgres.

The api suite reads `TEST_DATABASE_URL`, never `DATABASE_URL`, and refuses any database whose name lacks `test`. It writes destructively; do not "simplify" that to read `DATABASE_URL`.

## Environment

`DATABASE_URL` has **no fallback** — `packages/db/src/client.ts` and `drizzle.config.ts` both throw without it, and `/health` round-trips a real query so a bad connection fails the platform healthcheck. Both were added because a default of `postgresql://localhost/phoneup_dev` let a misconfigured deploy boot green and serve an empty database. Do not reintroduce a default. Full table in `.env.example`.

## Operational scripts

Run with `DATABASE_URL` pointed at the target DB:

- `pnpm --filter @phoneup/api materialize-shifts [days]` — generate `rep_shift` rows ahead (default 14). Needed after a roster import, else eligibility writes `CONFIGURATION_ERROR`. Idempotent; never rewrites past dates. Reps created later (Users page, or a role change into REP) get their own 14 days materialized automatically — always **after** the enclosing transaction commits, since `materializeShifts` takes the same advisory lock on its own connection.
- `pnpm --filter @phoneup/api import-activity <file.csv> [YYYY-MM-DD]` — import the CRM daily activity export. Date comes from the filename or the argument, never the clock. The Import Activity screen is the normal path.
- `pnpm --filter @phoneup/api rotate-passwords [--commit]` — one-off remediation; dry-run by default.
- `pnpm --filter @phoneup/db backfill-display-names [file.tsv]` — fill `app_user.display_name` from the roster TSV.

- `pnpm --filter @phoneup/db import-roster [file.tsv]` — one-shot first-run bootstrap (store, hours, policy, first cycle, ADMIN + all accounts). Refuses if a store row exists. First admin email comes from `ADMIN_EMAIL`.
- `pnpm --filter @phoneup/db backup [outDir]` — pg_dump + row-count manifest. **This is the backup**, not a supplement to one: Railway's volume backups are unavailable on the current plan (`maxBackupsCount: 0`). Output goes to gitignored `backups/` — dumps hold real employee and customer data.
- `pnpm --filter @phoneup/db restore-drill [dump] [--keep]` — restores into a scratch DB and asserts row counts match the manifest **and** that reconciliation passes on the restored copy. Exits non-zero on failure. A backup nobody has restored is a guess.
- `pnpm --filter @phoneup/api reconcile` — run the ledger/counter check on demand; exits non-zero on drift. The drill shells out to this rather than re-implementing the invariant — keep it that way, two definitions of the invariant would let the drill lie.

Prod runs `pnpm --filter @phoneup/db migrate` on container start (see `Dockerfile`), so a deploy applies pending migrations automatically.

Deploy order, day-one sequence and troubleshooting live in `docs/RUNBOOK.md` — keep it current.
