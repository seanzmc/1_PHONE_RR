# PhoneUp Round-Robin

Internal tool for one dealership team: assign inbound phone-up leads to sales reps via
round-robin, track fairness, and manage rep active/inactive status.

The one thing it must always do well: **assign a phone-up lead to the correct next rep,
correctly, in a couple of seconds, even with several BDC agents submitting at once.**

## Where to look

| | |
|---|---|
| **Deploying / onboarding the team / daily ops** | [docs/RUNBOOK.md](docs/RUNBOOK.md) |
| Scope rules and architecture decisions | [CLAUDE.md](CLAUDE.md) |
| Build spec | [plans/v1-plan.md](plans/v1-plan.md) |
| Environment variables | [.env.example](.env.example) |

## Stack

Fastify + tRPC v11 + Zod · Drizzle ORM · PostgreSQL · in-process WebSocket · node-cron ·
React + Vite. pnpm workspace, Node 22.

```
apps/api        Fastify server, tRPC routers, domain logic, cron jobs
apps/web        React SPA (served by the API in production)
packages/core   Pure logic: ranking, business dates, temp passwords
packages/db     Drizzle schema, migrations, roster import
packages/contracts  Zod schemas + the role/permission matrix
```

## Local setup

```sh
createdb phoneup_dev
createdb phoneup_test

cp .env.example .env          # then set DATABASE_URL

pnpm install
DATABASE_URL=postgresql://localhost/phoneup_dev pnpm --filter @phoneup/db migrate
DATABASE_URL=postgresql://localhost/phoneup_dev pnpm --filter @phoneup/db seed
pnpm dev                      # API :3000, web :5173
```

`seed` is a development fixture: it refuses to run against a non-local database or with
`NODE_ENV=production`, and issues a unique temporary password per account (printed once).
For a real deployment use `import-roster` — see the runbook.

## Checks

```sh
pnpm -r test     # 117 tests; apps/api needs a reachable postgresql://localhost/phoneup_test
pnpm -r build
```

## Correctness rules that must not be quietly changed

- Append-only `assignment_events` ledger plus a rebuildable `rep_month_counters`
  projection. A nightly job asserts they agree. Never replace it with plain counter
  increments — it is what makes "why wasn't I next?" answerable.
- One `pg_advisory_xact_lock` per ordering-changing transaction (assign, void, reassign,
  status override, reactivation). This is the load-bearing mechanism for concurrent BDC
  submissions.
- The ranking algorithm reads exactly one table: `rep_daily_status`. Schedules, overrides
  and disqualification only ever *write* it. New edge cases become status writes, never new
  branches in the algorithm.
- No shared passwords. Every admin-issued password is unique, single-use, and forces a
  change at next sign-in.
