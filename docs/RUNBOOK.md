# PhoneUp Round-Robin — Operations Runbook

Everything needed to deploy this, get the team into it, and keep it running. One store, one
rotation queue, one solo maintainer. Scope rules live in `CLAUDE.md`; the build spec is
`plans/v1-plan.md`.

---

## 1. Environment

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | **yes** | Postgres connection. No fallback — the API refuses to start and `drizzle-kit` refuses to migrate without it. |
| `PORT` | no | Listen port, default `3000`. Railway sets it. |
| `WEB_ORIGIN` | no | CORS origin. Only needed when the browser app is on a different origin than the API (local dev, Vite on `:5173`). In production the API serves `apps/web/dist` itself, so leave unset. |
| `NODE_ENV` | no | Set to `production` by the API `start` script. Drives `secure` session cookies and blocks the dev seed. |
| `ADMIN_EMAIL` | no | Email of the first ADMIN account created by the roster import. Defaults to the maintainer's address. |
| `TEST_DATABASE_URL` | no | Test database, default `postgresql://localhost/phoneup_test`. Separate from `DATABASE_URL` on purpose — an exported `DATABASE_URL` must never be able to point the destructive test suite at a real database. The suite also refuses any database whose name lacks `test`. |

See `.env.example`. Copy it to `.env` for local work; in production set them as platform variables.

## 1.1 Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request: install,
migrate a throwaway Postgres 16, `pnpm typecheck`, `pnpm -r test`, `pnpm -r build`.

The typecheck step matters more than it looks: the API ships via `tsx`, which strips types
without checking them, so CI is the only thing standing between a type error and production.

---

## 2. First deploy

Host is Railway (`railway.json` → `Dockerfile`). Migrations run on container start, so a
deploy applies pending migrations automatically.

1. **Provision Postgres.** Copy its connection string.
2. **Set `DATABASE_URL`** on the API service. Nothing else is required.
3. **Deploy.** The image builds the web app, then runs
   `pnpm --filter @phoneup/db migrate && pnpm --filter @phoneup/api start`.
4. **Confirm health.** `curl https://<host>/health` must return `{"ok":true}` with status
   200. A `503` with `{"ok":false,"error":"database unreachable"}` means `DATABASE_URL` is
   wrong or the database is not reachable — fix that before going further. The healthcheck
   round-trips a real query, so a green check means the app can actually serve an assignment.

The database is empty at this point. There are no accounts and nobody can log in — that is
step 3 below, not a fault.

---

## 3. Day-one onboarding (in this order)

### 3.1 Prepare the roster file

Tab-separated, one header row, then one row per person:

```
Name	Email	Role
Jane Smith	jane@dealership.com	Sales
Mike Jones	mike@dealership.com	BDC
Dana Lee	dana@dealership.com	Manager
```

`Role` must be exactly `Sales`, `BDC`, or `Manager` — mapped to `REP`, `BDC`, `MANAGER`.
`Sales` rows become rotation members; the other two do not. The file is gitignored (real
employee data) — keep it out of the repo.

### 3.2 Import the roster — one shot only

```
DATABASE_URL=<prod> pnpm --filter @phoneup/db import-roster ./Name\ Email\ Role.tsv
```

This creates the store, store hours, the work-requirement policy (SHADOW mode), the first
open rotation cycle, the ADMIN account, and one account per roster row.

**It refuses to run if a store row already exists.** That guard is deliberate — a partial or
duplicate import would corrupt rotation state. It also means this runs exactly once per
database; later hires go through the Users page (§4.1), not this script. If it fails
mid-way the transaction rolls back and you can re-run.

It prints a one-time distribution table: role, email, name, temporary password. **Capture
that output.** Every password is unique, single-use, and stored only as a hash — a lost one
must be reissued from the Users page. Never stored in plaintext, never recoverable.

### 3.3 Materialize shifts

```
DATABASE_URL=<prod> pnpm --filter @phoneup/api materialize-shifts 14
```

The importer writes today's shift only. Without this, tomorrow's eligibility job writes
`CONFIGURATION_ERROR` for every rep and the rotation empties out. Idempotent; never
rewrites past dates. After this, the weekly cron (Sunday 03:00 ET) keeps the window full.

### 3.4 Distribute passwords

Hand each person their own temporary password — read it down the phone or hand it over in
person. Shape is `word-word-NNN`, deliberately short and speakable because it is single-use.

Every account is flagged `must_change_password`. While that flag is set the server rejects
**every** route except `auth.changePassword`, so first sign-in forces a password change
before anything else works. That gate is server-side.

If someone loses their temp password: Users page → that row → issue a new one. There is no
email delivery and no self-service reset.

### 3.5 Verify the core loop before telling anyone it's live

1. Sign in as ADMIN, change the password.
2. Staff List — every `Sales` person appears, all eligible.
3. Assign screen — "Next Up" names one rep, "On Deck" is numbered.
4. Assign a test lead. It goes to the Next Up rep; the board advances.
5. Void it. The up returns to the same rep and they are Next Up again.
6. Delete the test lead's customer record if you care about clean data.

### 3.6 Train, by role

- **BDC (~8):** Assign screen only. Enter customer name + phone, assign, read the rep name back to the caller. Void within the time window if it was a mistake. Keyboard: `Alt+C` copy, `Alt+V` void, `Ctrl+Enter` submit.
- **Managers (~6):** Staff List (activate/deactivate, recurring days off), Dashboard, rep drill-down, Import Activity (daily), reassign/override.
- **Reps (~30):** My Dashboard only — their own leads, ups this month, calls, sales, days inactive. They cannot change their own status.

---

## 4. Recurring operations

### 4.1 New hire

Users page → Add account → pick role. A `REP` gets a `sales_rep` row, today's shift, an
`ELIGIBLE` status, **and 14 days of shifts materialized automatically** — they are in the
rotation immediately, with no gap until the Sunday cron. A generated temp password is shown
once; relay it.

### 4.2 Daily: import call activity

The clerical chore. Import the prior day's CRM activity export (`Standard-Daily Activity
YYYY-MM-DD.csv`) via the **Import Activity** screen — preview, review unmatched names, then
commit. Reps are matched on display name, case- and whitespace-insensitive; an unmatched
name is reported, never guessed. Fix an unmatched rep's display name on the Users page and
re-import.

CLI fallback:

```
DATABASE_URL=<prod> pnpm --filter @phoneup/api import-activity ./Standard-Daily\ Activity\ 2026-07-29.csv
```

The business date comes from the filename or the optional second argument — never from the
clock, so a late import lands on the right day.

### 4.3 Scheduled jobs (in-process node-cron, `America/New_York`)

| When | Job | What it does |
|---|---|---|
| 02:00 daily | reconciliation | Asserts `assignment_events` and `rep_month_counters` agree; logs drift. |
| 08:00 daily | eligibility | Writes each rep's `rep_daily_status` for today. |
| Sun 03:00 | shift materialization | Extends `rep_shift` 14 days ahead. |

They run in the API process. A restart loses nothing, but a process that is down at 08:00
means no status writes that morning — run `materialize-shifts` and check the Staff List.

### 4.4 Turning disqualification on

Ships in **SHADOW**: eligibility computes and logs what it *would* do and enforces nothing.
The thresholds need 1–2 weeks of real call data before they mean anything.

There is no admin UI for this yet. The flip is an ADMIN-only `admin.setPolicy` call:

```
curl -X POST https://<host>/trpc/admin.setPolicy \
  -H 'content-type: application/json' \
  -b 'sid=<your admin session cookie>' \
  -d '{"enforcementMode":"ENFORCE","minCalls":10}'
```

Audit-logged as `policy.set` with before/after. Read `admin.policy` first to see current
values. Do not flip this until the shadow data has been reviewed — see Known gaps.

### 4.5 Backups and the restore drill

**Railway's own volume backups are not available on the current plan.** Verified against the
API: the workspace limit is `maxBackupsCount: 0`, and both `volumeInstanceBackupCreate` and
`volumeInstanceBackupScheduleUpdate` return `Not Authorized`. There are zero backups and
zero schedules on the production volume. Upgrading the Railway plan would enable native
daily/weekly/monthly snapshots — that is a billing decision, not a technical one.

Until then `pg_dump` is not a supplement to a backup, it **is** the backup. The
`assignment_events` ledger is the truth model and cannot be reconstructed from anywhere
else.

**Client version matters.** Production runs **Postgres 18.4**; a v16 `pg_dump` cannot dump it.
The v18 client is installed at `/opt/homebrew/opt/postgresql@18/bin` and must come first on
`PATH`. `backup` refuses to run on a version mismatch rather than writing a broken archive.

**Automatic weekly backup (installed).** `scripts/backup-to-drive.sh`, driven by the
`com.phoneup.backup` LaunchAgent, runs Sundays at 09:00 and writes to
`~/Library/CloudStorage/GoogleDrive-…/My Drive/PhoneUp Backups/`, which Google Drive syncs
off the machine. It keeps the 8 most recent dumps and prunes older ones.

The production password is never stored on disk: the script fetches `DATABASE_PUBLIC_URL`
from the Railway CLI at run time. (`DATABASE_URL` points at `postgres.railway.internal`,
which only resolves inside Railway's network — it does not work from a laptop.)

On failure it writes `BACKUP-FAILED.txt` into the Drive folder, because a scheduled job that
silently stops running looks exactly like one with nothing to do. **If you ever see that
file, backups have stopped.** Progress is logged to `~/Library/Logs/phoneup-backup.log`.

**Why the script stages locally first.** `~/Library/CloudStorage` is protected by macOS
privacy control, and the rules differ from ordinary file permissions: a background process
may *create* files there and *delete* ones it names explicitly, but it may not *enumerate*
the directory, and it cannot touch files another app created. Two consequences, both learned
the hard way when the LaunchAgent failed while the same script succeeded by hand:

- The log must live outside Drive. It was originally written there, and because pnpm's
  output was redirected into it, the redirect failed and the backup never ran at all.
- The script dumps into `~/.phoneup-backups`, verifies and prunes there, then copies the
  finished file into Drive. Drive pruning deletes explicit paths listed in
  `~/.phoneup-backups/drive-index.txt`; globbing the Drive folder from the LaunchAgent
  silently returns nothing, which reads as "no backup was produced" when the file is sitting
  right there.

Do not "simplify" this back into writing and listing directly in Drive. The alternative fix
is granting `/bin/bash` Full Disk Access, which is far too broad a grant for a backup script.

```
launchctl list | grep phoneup                            # is it scheduled ("-  0  com.phoneup.backup" = healthy)
launchctl kickstart -k gui/$(id -u)/com.phoneup.backup   # run it now
launchctl print gui/$(id -u)/com.phoneup.backup | grep -E "runs|last exit"
```

Test changes to the script with `kickstart`, never by running the script in a terminal. A
terminal run inherits your shell's environment and privacy grants and will succeed where the
LaunchAgent fails — that difference is what hid the two problems above.

**Take a backup by hand:**

```
DATABASE_URL=<prod> pnpm --filter @phoneup/db backup
```

Writes `backups/phoneup-<timestamp>.dump` (custom format) plus a `.manifest.json` of
per-table row counts. It refuses to run if the local `pg_dump` is older than the server,
and verifies the archive is readable with `pg_restore --list` before reporting success.
`backups/` is gitignored — dumps hold real employee and customer data and must never be
committed, or pushed anywhere they would leave the machine unencrypted.

**Verify the backup actually restores:**

```
PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH" \
DATABASE_URL=postgresql://localhost:5433/postgres \
pnpm --filter @phoneup/db restore-drill "$HOME/Library/CloudStorage/GoogleDrive-seanzmc9613@gmail.com/My Drive/PhoneUp Backups/<newest>.dump"
```

Port **5433** is the local Postgres 18 instance (`brew services start postgresql@18`),
installed for this purpose. The v16 server on 5432 cannot restore a v18 dump — it fails on
`transaction_timeout`, a parameter that did not exist before v17.

Restores the newest dump into a scratch database (`phoneup_restore_drill`, dropped and
recreated each run; the name must contain `drill`) and asserts three things in order:

1. `pg_restore` completes;
2. every table's row count matches the manifest taken at dump time;
3. `pnpm --filter @phoneup/api reconcile` passes **on the restored copy** — the ledger and
   its projection still agree, so what came back is the truth model and not just rows.

Exits non-zero on any failure. Pass `--keep` to leave the scratch database for inspection.

**Cadence.** The weekly job covers the routine case. Take an extra manual backup immediately
before a migration deploy or a roster import. Run the drill on at least one dump a month — a
backup nobody has restored is a guess.

**What this does not cover.** The schedule only fires when the laptop is awake, and the
dumps hold real employee and customer data sitting unencrypted in a personal Google Drive.
Both are accepted trade-offs of not having Railway's native snapshots; revisit if the plan
is ever upgraded.

**Reconciliation on demand**, independent of the drill and of the 02:00 cron:

```
DATABASE_URL=<prod> pnpm --filter @phoneup/api reconcile
```

### 4.6 Password remediation

```
DATABASE_URL=<prod> pnpm --filter @phoneup/api rotate-passwords            # dry run
DATABASE_URL=<prod> pnpm --filter @phoneup/api rotate-passwords --commit   # apply
```

Reissues a fresh temp password for every account and prints the distribution list. One-off
tool for a suspected exposure, not routine hygiene.

### 4.7 Fixing display names

```
DATABASE_URL=<prod> pnpm --filter @phoneup/db backfill-display-names ./Name\ Email\ Role.tsv
```

Fills `app_user.display_name` from the roster file. Activity import matches on display name,
so a null or wrong name shows up as an unmatched import row.

---

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/health` returns 503 | `DATABASE_URL` wrong, or Postgres unreachable | Fix the variable / check the database service. The API will not fall back to a local database. |
| Container exits with `DATABASE_URL is not set` | Variable missing on the service | Set it. Intentional — the alternative was a green deploy serving an empty database. |
| Reps show `CONFIGURATION_ERROR` | No `rep_shift` row for today | Run `materialize-shifts`, or Staff List → Generate shifts. |
| Rotation looks empty | Everyone ineligible, or shifts not materialized | Staff List shows a reason per rep. |
| Login says "too many failed attempts" | 8 failures per email/IP → 15-minute lockout | Wait it out. The counter is in-memory, so an API restart also clears it. |
| Signed out unexpectedly | Session TTL is 12h; a password change revokes other sessions | Sign in again. |
| Import reports unmatched reps | CRM display name ≠ `sales_rep.display_name` | Fix the name on the Users page, re-import. No fuzzy matching, by design. |
| `import-roster` refuses: store row exists | Database already initialised | Correct behaviour. Add people via the Users page. |
| `seed` refuses to run | Guards against non-local databases and `NODE_ENV=production` | Correct behaviour. Use `import-roster` for real deployments. |
| Reconciliation logs drift | Ledger and counters disagree | The ledger is truth. Investigate before trusting dashboard numbers — do not "fix" counters by hand. |

---

## 6. Known gaps

Open items that affect operating this, tracked so they are not rediscovered in production:

- **Backups depend on a laptop being awake.** The weekly job (§4.5) runs on this Mac, not on
  a server, so a week with the machine closed on Sunday is a week with no new backup — check
  the Drive folder's dates now and then. Railway's native snapshots would remove the
  dependency entirely but need a plan upgrade (`maxBackupsCount: 0` on Hobby).
- **Dumps are unencrypted in a personal Google Drive.** They contain employee emails and
  customer names and phone numbers. Acceptable while the Drive account has strong auth;
  worth encrypting if backups ever move somewhere shared.
- **No shadow-mode report.** Nothing renders "who would have been disqualified", so the
  calibration window that gates §4.4 produces no reviewable output yet.
- **No policy UI.** Enforcement mode is flipped by the API call in §4.4.
- **Reps cannot submit reactivation requests.** The permission exists; the route does not.
  Reactivation is a manager action on the Staff List for now.
- **No email.** Every password hand-off and notification is manual and in person.
