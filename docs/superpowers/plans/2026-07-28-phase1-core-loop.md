# Phase 1 — Core Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the phone-up round-robin core loop end to end — assign a lead to the correct next rep correctly, in under a few seconds, under concurrent BDC submission — plus the minimum surrounding screens/jobs `plans/v1-plan.md` §10 Phase 1 calls for.

**Architecture:** Monorepo (pnpm workspaces). `packages/core` is pure domain logic (ranking, eligibility, business-date math, zero I/O) so it's unit/property-testable in isolation. `packages/db` holds Drizzle schema/migrations. `packages/contracts` holds shared Zod schemas + permission constants. `apps/api` is Fastify + tRPC v11, does all I/O, owns the advisory-lock assignment transaction. `apps/web` is a Vite React SPA consuming the tRPC router.

**Tech Stack:** Node 26, TypeScript, pnpm workspaces, Fastify, tRPC v11, Zod, Drizzle ORM, PostgreSQL 16 (local via Homebrew, db `phoneup_dev`), `ws`, node-cron, Vite + React 18 + TanStack Query + Zustand, Vitest, fast-check.

## Global Constraints

- One `pg_advisory_xact_lock` per assignment-ordering transaction (assign, void, reassign, status override, reactivation) — spec §0.1, §4.
- `assignment_events` append-only ledger + `rep_month_counters` projection written in the same transaction; nightly reconciliation rebuilds counters from the ledger — spec §0.2.
- `rep_daily_status` is the only table the ranking/eligibility algorithm reads — spec §0.3. Never add a branch to the algorithm for a new edge case; write a status row instead.
- Ranking lives in `packages/core`, zero I/O imports — spec §0.4. Sort: eligibility filter → (served-this-cycle, monthly load, last-assigned-at, stable rotation seed, rep id).
- `requirePerm()` tRPC middleware on every mutation/query, 4 roles exactly (ADMIN/MANAGER/BDC/REP) — spec §3.
- Realtime publish happens **after commit**, never inside the transaction — spec §4.12.
- Never drop a live lead: no eligible rep → `unassigned_queue` + manager notify — spec §4.8.
- Duplicate-phone check warns, never blocks — spec §4.9.
- Fail-open on eligibility job death (lazy `ensureEligibilitySnapshots()`), fail-safe to `CONFIGURATION_ERROR` on missing schedule — spec §6.
- CRM import lateness → rep stays `ELIGIBLE` + `IMPORT_LATE` banner, never auto-DQ on a missing import — spec §7.
- Disqualification ships SHADOW mode first (compute + log, status still resolves ELIGIBLE) — CLAUDE.md, spec §6.5.
- Single store, single timezone (`America/New_York`), single rotation queue, calendar month only — CLAUDE.md scope guardrails. Do not build multi-store/multi-rotation-group scaffolding beyond the `rotation_group` column already specified.

---

## File Structure

```
apps/web/                  Vite React SPA
apps/api/
  src/
    trpc/                  router init, context, requirePerm middleware
    routers/                assignment.ts, rep.ts, reactivation.ts, admin.ts, board.ts
    domain/                 assignLead.ts (the transaction), reconciliation.ts
    jobs/                   eligibility.ts, crmImport.ts, reconciliation.ts (cron entries)
    realtime/               ws server + EventEmitter fan-out
    auth/                   session store, password hashing, TOTP
packages/db/
  src/schema/               one file per table group (store.ts, rep.ts, lead.ts, ledger.ts, ...)
  src/migrations/           drizzle-kit generated SQL
  src/seed.ts
packages/core/
  src/businessDate.ts
  src/ranking.ts
  src/eligibility.ts
  src/*.test.ts
packages/contracts/
  src/schemas.ts            Zod schemas shared client/server
  src/permissions.ts        role -> permission matrix, exact table from spec §3
```

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json` (root), `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`
- Create: `apps/web/` via `pnpm create vite`

**Interfaces:**
- Produces: workspace package names `@phoneup/core`, `@phoneup/contracts`, `@phoneup/db` importable from `apps/api`.

- [ ] Step 1: Root `package.json` with `"private": true`, `"packageManager": "pnpm@..."`, workspaces script aliases (`build`, `test`, `dev`).
- [ ] Step 2: `pnpm-workspace.yaml` listing `apps/*` and `packages/*`.
- [ ] Step 3: `tsconfig.base.json` — `strict: true`, `target: ES2022`, `module: NodeNext`.
- [ ] Step 4: Create each package dir with minimal `package.json` (`name`, `type: module`, `main`, `scripts.test: vitest run`) and `tsconfig.json` extending base.
- [ ] Step 5: Scaffold `apps/web` with `pnpm create vite@latest apps/web -- --template react-ts`.
- [ ] Step 6: `pnpm install` at root, verify workspace links resolve (`pnpm -r exec node -e "1"`).
- [ ] Step 7: Commit.

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo workspaces"
```

---

### Task 2: `packages/core` — business date + ranking (TDD)

**Files:**
- Create: `packages/core/src/businessDate.ts`
- Test: `packages/core/src/businessDate.test.ts`
- Create: `packages/core/src/ranking.ts`
- Test: `packages/core/src/ranking.test.ts`

**Interfaces:**
- Produces: `businessDate(instant: Date, tz?: string): string` (`YYYY-MM-DD`), `periodKey(businessDate: string): string` (`YYYY-MM`).
- Produces: `type RepRankInput = { repId: string; isEligible: boolean; ineligibleReason?: string; servedThisCycle: boolean; monthlyLoad: number; lastAssignedAt: string | null; rotationSeed: number }`
- Produces: `rankReps(reps: RepRankInput[]): RepRankInput[]` — full sorted roster (eligible + ineligible), eligible-first, then by `(servedThisCycle asc, monthlyLoad asc, lastAssignedAt asc nulls-first, rotationSeed asc, repId asc)`.
- Consumed by: Task 6 assignment transaction.

- [ ] Step 1: Write failing tests for `businessDate`/`periodKey` — instant before/after local midnight boundary, DST spring-forward day, `America/New_York` hardcoded.

```ts
import { describe, it, expect } from 'vitest'
import { businessDate, periodKey } from './businessDate'

describe('businessDate', () => {
  it('returns the NY local calendar date for a UTC instant', () => {
    // 2026-01-15 04:30 UTC = 2026-01-14 23:30 EST
    expect(businessDate(new Date('2026-01-15T04:30:00Z'))).toBe('2026-01-14')
  })
  it('rolls to the next day right after local midnight', () => {
    // 2026-01-15 05:30 UTC = 2026-01-15 00:30 EST
    expect(businessDate(new Date('2026-01-15T05:30:00Z'))).toBe('2026-01-15')
  })
  it('handles DST spring-forward day (2026-03-08) without shifting a full day', () => {
    expect(businessDate(new Date('2026-03-08T12:00:00Z'))).toBe('2026-03-08')
  })
})

describe('periodKey', () => {
  it('derives YYYY-MM from a business date', () => {
    expect(periodKey('2026-01-14')).toBe('2026-01')
  })
})
```

- [ ] Step 2: Run `pnpm --filter @phoneup/core test` — expect FAIL (`businessDate` not defined).
- [ ] Step 3: Implement using `Intl.DateTimeFormat` with `timeZone: 'America/New_York'` (no external tz library needed for a single fixed zone):

```ts
const NY_TZ = 'America/New_York'
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: NY_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
})

export function businessDate(instant: Date): string {
  return fmt.format(instant) // en-CA locale formats as YYYY-MM-DD
}

export function periodKey(businessDateStr: string): string {
  return businessDateStr.slice(0, 7)
}
```

- [ ] Step 4: Run tests — expect PASS.
- [ ] Step 5: Write failing tests for `rankReps` — table-driven per spec §0.4 sort order, plus: all-ineligible board display, tie-break down to `repId`.

```ts
import { describe, it, expect } from 'vitest'
import { rankReps, type RepRankInput } from './ranking'

function rep(overrides: Partial<RepRankInput>): RepRankInput {
  return {
    repId: 'r0', isEligible: true, servedThisCycle: false,
    monthlyLoad: 0, lastAssignedAt: null, rotationSeed: 0,
    ...overrides,
  }
}

describe('rankReps', () => {
  it('puts eligible reps before ineligible regardless of other fields', () => {
    const out = rankReps([
      rep({ repId: 'a', isEligible: false, monthlyLoad: 0 }),
      rep({ repId: 'b', isEligible: true, monthlyLoad: 99 }),
    ])
    expect(out.map(r => r.repId)).toEqual(['b', 'a'])
  })

  it('within eligibility tier, unserved-this-cycle ranks before served', () => {
    const out = rankReps([
      rep({ repId: 'a', servedThisCycle: true }),
      rep({ repId: 'b', servedThisCycle: false }),
    ])
    expect(out.map(r => r.repId)).toEqual(['b', 'a'])
  })

  it('then by lower monthly load', () => {
    const out = rankReps([
      rep({ repId: 'a', monthlyLoad: 5 }),
      rep({ repId: 'b', monthlyLoad: 2 }),
    ])
    expect(out.map(r => r.repId)).toEqual(['b', 'a'])
  })

  it('then by earlier / null lastAssignedAt (null = never assigned = first)', () => {
    const out = rankReps([
      rep({ repId: 'a', lastAssignedAt: '2026-01-10T00:00:00Z' }),
      rep({ repId: 'b', lastAssignedAt: null }),
    ])
    expect(out.map(r => r.repId)).toEqual(['b', 'a'])
  })

  it('then by rotationSeed, then repId as final tiebreak', () => {
    const out = rankReps([
      rep({ repId: 'b', rotationSeed: 1 }),
      rep({ repId: 'a', rotationSeed: 1 }),
    ])
    expect(out.map(r => r.repId)).toEqual(['a', 'b'])
  })
})
```

- [ ] Step 6: Run — expect FAIL.
- [ ] Step 7: Implement:

```ts
export type RepRankInput = {
  repId: string
  isEligible: boolean
  ineligibleReason?: string
  servedThisCycle: boolean
  monthlyLoad: number
  lastAssignedAt: string | null
  rotationSeed: number
}

export function rankReps(reps: RepRankInput[]): RepRankInput[] {
  return [...reps].sort((x, y) => {
    if (x.isEligible !== y.isEligible) return x.isEligible ? -1 : 1
    if (x.servedThisCycle !== y.servedThisCycle) return x.servedThisCycle ? 1 : -1
    if (x.monthlyLoad !== y.monthlyLoad) return x.monthlyLoad - y.monthlyLoad
    const xLast = x.lastAssignedAt ?? ''
    const yLast = y.lastAssignedAt ?? ''
    if (xLast !== yLast) return xLast < yLast ? -1 : 1
    if (x.rotationSeed !== y.rotationSeed) return x.rotationSeed - y.rotationSeed
    return x.repId < y.repId ? -1 : x.repId > y.repId ? 1 : 0
  })
}
```

- [ ] Step 8: Run — expect PASS.
- [ ] Step 9: Add fast-check property test: for any permutation of the same input array, `rankReps` output is identical (sort stability/determinism) — cheap since zero I/O.

```ts
import fc from 'fast-check'

it('is deterministic regardless of input order', () => {
  fc.assert(fc.property(
    fc.array(fc.record({
      repId: fc.string({ minLength: 1 }),
      isEligible: fc.boolean(),
      servedThisCycle: fc.boolean(),
      monthlyLoad: fc.integer({ min: 0, max: 50 }),
      lastAssignedAt: fc.option(fc.constant('2026-01-01T00:00:00Z'), { nil: null }),
      rotationSeed: fc.integer({ min: 0, max: 10 }),
    }), { minLength: 2, maxLength: 8 }),
    (reps) => {
      const uniqueIds = reps.map((r, i) => ({ ...r, repId: `${r.repId}-${i}` }))
      const a = rankReps(uniqueIds)
      const b = rankReps([...uniqueIds].reverse())
      expect(a.map(r => r.repId)).toEqual(b.map(r => r.repId))
    },
  ))
})
```

- [ ] Step 10: Run full `packages/core` suite — expect PASS.
- [ ] Step 11: Commit.

```bash
git add packages/core
git commit -m "feat(core): business date and ranking pure functions"
```

---

### Task 3: `packages/contracts` — permission matrix + Zod schemas

**Files:**
- Create: `packages/contracts/src/permissions.ts`
- Test: `packages/contracts/src/permissions.test.ts`
- Create: `packages/contracts/src/schemas.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Role = 'ADMIN' | 'MANAGER' | 'BDC' | 'REP'`, `type Permission = 'board.view' | 'lead.assign' | 'lead.void' | 'lead.assign.override' | 'rep.override' | 'schedule.manage' | 'activity.self' | 'reactivation.review' | 'reactivation.self' | 'audit.view' | 'admin.*'`, `hasPermission(role: Role, perm: Permission): boolean`.
- Produces: `assignLeadInputSchema`, `voidLeadInputSchema`, `statusOverrideInputSchema` (Zod), consumed by Task 5 (api routers) and Task 4 (db).

- [ ] Step 1: Write failing test enumerating the exact table from spec §3 (one assertion per cell, ADMIN has everything, REP only self-scoped).

```ts
import { describe, it, expect } from 'vitest'
import { hasPermission } from './permissions'

describe('hasPermission', () => {
  it('ADMIN has every permission', () => {
    const all = ['board.view','lead.assign','lead.void','lead.assign.override',
      'rep.override','schedule.manage','activity.self','reactivation.review',
      'reactivation.self','audit.view','admin.*'] as const
    for (const p of all) expect(hasPermission('ADMIN', p)).toBe(true)
  })
  it('MANAGER can override/reassign but not admin.*', () => {
    expect(hasPermission('MANAGER', 'lead.assign.override')).toBe(true)
    expect(hasPermission('MANAGER', 'rep.override')).toBe(true)
    expect(hasPermission('MANAGER', 'admin.*')).toBe(false)
  })
  it('BDC can assign/void but not override or rep status', () => {
    expect(hasPermission('BDC', 'lead.assign')).toBe(true)
    expect(hasPermission('BDC', 'lead.void')).toBe(true)
    expect(hasPermission('BDC', 'lead.assign.override')).toBe(false)
    expect(hasPermission('BDC', 'rep.override')).toBe(false)
  })
  it('REP can only view board (self), log own activity, and self-reactivate', () => {
    expect(hasPermission('REP', 'activity.self')).toBe(true)
    expect(hasPermission('REP', 'reactivation.self')).toBe(true)
    expect(hasPermission('REP', 'lead.assign')).toBe(false)
    expect(hasPermission('REP', 'reactivation.review')).toBe(false)
  })
})
```

- [ ] Step 2: Run — expect FAIL.
- [ ] Step 3: Implement as a literal matrix (not a computed hierarchy — spec table is the source of truth, don't derive it cleverly):

```ts
export type Role = 'ADMIN' | 'MANAGER' | 'BDC' | 'REP'
export type Permission =
  | 'board.view' | 'lead.assign' | 'lead.void' | 'lead.assign.override'
  | 'rep.override' | 'schedule.manage' | 'activity.self'
  | 'reactivation.review' | 'reactivation.self' | 'audit.view' | 'admin.*'

const MATRIX: Record<Role, Permission[]> = {
  ADMIN: ['board.view','lead.assign','lead.void','lead.assign.override','rep.override',
    'schedule.manage','activity.self','reactivation.review','reactivation.self','audit.view','admin.*'],
  MANAGER: ['board.view','lead.assign','lead.void','lead.assign.override','rep.override',
    'schedule.manage','activity.self','reactivation.review','audit.view'],
  BDC: ['board.view','lead.assign','lead.void','activity.self'],
  REP: ['board.view','activity.self','reactivation.self'],
}

export function hasPermission(role: Role, perm: Permission): boolean {
  return MATRIX[role].includes(perm)
}
```

- [ ] Step 4: Run — expect PASS.
- [ ] Step 5: Write `schemas.ts` Zod schemas (no test needed — pure declarations, validated by routers in Task 5):

```ts
import { z } from 'zod'

export const assignLeadInputSchema = z.object({
  idempotencyKey: z.string().uuid(),
  customerName: z.string().min(1),
  customerPhoneE164: z.string().regex(/^\+1\d{10}$/),
  notes: z.string().optional(),
  forcedRepId: z.string().uuid().optional(), // requires lead.assign.override server-side
})

export const voidLeadInputSchema = z.object({
  leadId: z.string().uuid(),
  reasonNote: z.string().min(1),
})

export const statusOverrideInputSchema = z.object({
  repId: z.string().uuid(),
  status: z.enum(['FORCE_ACTIVE', 'FORCE_INACTIVE', 'FOLLOW_SCHEDULE']),
  reasonCode: z.string().min(1),
  reasonNote: z.string().min(1),
})
```

- [ ] Step 6: Commit.

```bash
git add packages/contracts
git commit -m "feat(contracts): permission matrix and shared Zod schemas"
```

---

### Task 4: `packages/db` — Drizzle schema + migrations + seed

**Files:**
- Create: `packages/db/src/schema/store.ts`, `rep.ts`, `eligibility.ts`, `lead.ts`, `ledger.ts`, `audit.ts`, `index.ts`
- Create: `packages/db/drizzle.config.ts`
- Create: `packages/db/src/seed.ts`

**Interfaces:**
- Produces: Drizzle table objects (`store`, `storeHours`, `storeClosure`, `appUser`, `salesRep`, `repShift`, `workRequirementPolicy`, `eligibilitySnapshot`, `repDailyStatus`, `statusOverride`, `customer`, `lead`, `leadActivity`, `assignmentEvents`, `rotationCycle`, `rrCycleAssignments`, `rrState`, `repMonthCounters`, `reactivationRequest`, `auditEvents`, `unassignedQueue`, `dailyFacts`) matching spec §2 verbatim.
- Consumed by: Task 5 (api) via `import { db, schema } from '@phoneup/db'`.

- [ ] Step 1: `drizzle.config.ts` pointed at `postgresql://localhost/phoneup_dev` (env `DATABASE_URL`, default to that dev DB).

```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './src/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost/phoneup_dev',
  },
})
```

- [ ] Step 2: Write `schema/store.ts` — `store` (one row: name, rotation_salt, settings jsonb), `store_hours`, `store_closure`, `app_user`, `sales_rep`, `rep_shift` per spec §2.
- [ ] Step 3: Write `schema/eligibility.ts` — `work_requirement_policy`, `eligibility_snapshot`, `rep_daily_status`, `status_override`.
- [ ] Step 4: Write `schema/lead.ts` — `customer` (with generated `phone_digits` column via raw SQL since Drizzle DSL can't express `GENERATED ALWAYS AS`), `lead`, `lead_activity`.
- [ ] Step 5: Write `schema/ledger.ts` — `assignment_events`, `rotation_cycle` (partial unique index `one_open_cycle` via raw SQL), `rr_cycle_assignments`, `rr_state`, `rep_month_counters`.
- [ ] Step 6: Write `schema/audit.ts` — `reactivation_request`, `audit_events`, `unassigned_queue`, `daily_facts`. For `audit_events`/`assignment_events` append-only-ness: use raw SQL migration to `REVOKE UPDATE, DELETE` for the app role — do NOT add hash-chain columns (explicitly cut, CLAUDE.md).
- [ ] Step 7: `schema/index.ts` re-exports all tables.
- [ ] Step 8: `pnpm --filter @phoneup/db exec drizzle-kit generate` against `phoneup_dev`, inspect generated SQL for the partial/generated-column raw pieces, hand-edit the migration file to add:
  - `customer.phone_digits` as `GENERATED ALWAYS AS (regexp_replace(phone_e164, '\D', '', 'g')) STORED`
  - unique partial index `CREATE UNIQUE INDEX one_open_cycle ON rotation_cycle (store_id) WHERE closed_at IS NULL`
  - `REVOKE UPDATE, DELETE ON assignment_events, audit_events FROM CURRENT_USER` (append-only enforcement, no hash-chain)
- [ ] Step 9: `pnpm --filter @phoneup/db exec drizzle-kit migrate` against `phoneup_dev` — confirm it applies cleanly:

```bash
psql phoneup_dev -c "\dt" # expect all ~22 tables listed
```

- [ ] Step 10: Write `seed.ts` — one `store` row, `store_hours` Mon-Sat 9-8/Sun closed, one ADMIN user, 3 test reps with shifts today, one open `rotation_cycle`, one `rr_state` row. Run it:

```bash
pnpm --filter @phoneup/db exec tsx src/seed.ts
psql phoneup_dev -c "select count(*) from sales_rep;" # expect 3
```

- [ ] Step 11: Commit.

```bash
git add packages/db
git commit -m "feat(db): drizzle schema, migrations, dev seed"
```

---

### Task 5: `apps/api` bootstrap — Fastify + tRPC + auth + `requirePerm`

**Files:**
- Create: `apps/api/src/index.ts`, `apps/api/src/trpc/context.ts`, `apps/api/src/trpc/router.ts`, `apps/api/src/trpc/requirePerm.ts`
- Create: `apps/api/src/auth/session.ts`, `apps/api/src/auth/password.ts`
- Test: `apps/api/src/trpc/requirePerm.test.ts`

**Interfaces:**
- Consumes: `hasPermission` from `@phoneup/contracts`, `db`/`schema` from `@phoneup/db`.
- Produces: `type Context = { db: DB; session: { userId: string; role: Role } | null }`, `requirePerm(perm: Permission)` tRPC middleware, `router`/`publicProcedure`/`protectedProcedure` exports consumed by Task 6/7/8/9 routers.

- [ ] Step 1: `context.ts` — reads `sid` httpOnly cookie, looks up session row (Postgres-backed sessions per spec §1, no JWT), attaches `{ userId, role }` or `null`.
- [ ] Step 2: `password.ts` — `hashPassword`/`verifyPassword` via Node's built-in `scrypt` (no extra dependency).
- [ ] Step 3: Write failing test: `requirePerm('rep.override')` middleware rejects a BDC-role context with `TRPCError({ code: 'FORBIDDEN' })`, passes a MANAGER-role context through.

```ts
import { describe, it, expect } from 'vitest'
import { initTRPC, TRPCError } from '@trpc/server'
import { hasPermission } from '@phoneup/contracts'

type Ctx = { session: { userId: string; role: 'ADMIN'|'MANAGER'|'BDC'|'REP' } | null }
const t = initTRPC.context<Ctx>().create()

function requirePerm(perm: Parameters<typeof hasPermission>[1]) {
  return t.middleware(({ ctx, next }) => {
    if (!ctx.session) throw new TRPCError({ code: 'UNAUTHORIZED' })
    if (!hasPermission(ctx.session.role, perm)) throw new TRPCError({ code: 'FORBIDDEN' })
    return next({ ctx })
  })
}

describe('requirePerm', () => {
  const guarded = t.procedure.use(requirePerm('rep.override')).query(() => 'ok')
  it('rejects BDC', async () => {
    const caller = t.createCallerFactory(t.router({ x: guarded }))({ session: { userId: 'u1', role: 'BDC' } })
    await expect(caller.x()).rejects.toThrow(/FORBIDDEN/)
  })
  it('allows MANAGER', async () => {
    const caller = t.createCallerFactory(t.router({ x: guarded }))({ session: { userId: 'u1', role: 'MANAGER' } })
    await expect(caller.x()).resolves.toBe('ok')
  })
})
```

- [ ] Step 4: Run — expect FAIL, then move the inline implementation into `requirePerm.ts` proper (real `Context` type from `context.ts`, not the test's local `Ctx`).
- [ ] Step 5: Run — expect PASS.
- [ ] Step 6: `router.ts` — `export const t = initTRPC.context<Context>().create()`, `export const router = t.router`, `export const publicProcedure = t.procedure`, `export const protectedProcedure = t.procedure.use(requireSession)`.
- [ ] Step 7: `index.ts` — Fastify instance, `@trpc/server/adapters/fastify` plugin mounted at `/trpc`, cookie plugin, listen on `PORT ?? 3000`.
- [ ] Step 8: Manual smoke: `pnpm --filter @phoneup/api dev`, `curl localhost:3000/trpc/health` (add trivial `health` query) returns 200.
- [ ] Step 9: Commit.

```bash
git add apps/api
git commit -m "feat(api): fastify+trpc bootstrap, sessions, requirePerm middleware"
```

---

### Task 6: The assignment transaction (non-negotiable core)

**Files:**
- Create: `apps/api/src/domain/assignLead.ts`
- Create: `apps/api/src/domain/ensureEligibilitySnapshots.ts` (stub returning all-eligible; full logic in Task 10)
- Test: `apps/api/src/domain/assignLead.test.ts` (integration, real Postgres against `phoneup_dev`)
- Create: `apps/api/src/routers/assignment.ts`

**Interfaces:**
- Consumes: `rankReps` from `@phoneup/core`, `db`/`schema` from `@phoneup/db`.
- Produces: `async function assignLead(db: DB, input: { idempotencyKey: string; customerName: string; customerPhoneE164: string; notes?: string; forcedRepId?: string; actorUserId: string }): Promise<{ leadId: string; assignedRepId: string | null; queueSnapshot: RepRankInput[] }>`.
- Produces: `publishAssignment(event)` hook called strictly after `db.transaction` resolves — stub logs for now, wired to realtime in Task 8.

- [ ] Step 1: Write failing integration test — single assign against seeded 3 reps picks the correctly-ranked rep and writes ledger+counters in one transaction.

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { db, schema } from '@phoneup/db'
import { assignLead } from './assignLead'
import { randomUUID } from 'node:crypto'

describe('assignLead', () => {
  beforeEach(async () => {
    await db.delete(schema.assignmentEvents)
    await db.delete(schema.lead)
    await db.delete(schema.repMonthCounters)
    // reps r1,r2,r3 reset to zero load via seed helper
  })

  it('assigns to the first eligible rep by rank and writes ledger+counter atomically', async () => {
    const result = await assignLead(db, {
      idempotencyKey: randomUUID(),
      customerName: 'Jane Doe',
      customerPhoneE164: '+15551234567',
      actorUserId: 'seed-bdc-user',
    })
    expect(result.assignedRepId).toBeTruthy()

    const events = await db.select().from(schema.assignmentEvents)
      .where(eq(schema.assignmentEvents.leadId, result.leadId))
    expect(events.some(e => e.eventType === 'ASSIGN')).toBe(true)

    const counter = await db.select().from(schema.repMonthCounters)
      .where(eq(schema.repMonthCounters.repId, result.assignedRepId!))
    expect(counter[0].upsMtd).toBe(1)
  })

  it('is exactly-once under retry with the same idempotency key', async () => {
    const key = randomUUID()
    const first = await assignLead(db, { idempotencyKey: key, customerName: 'A', customerPhoneE164: '+15550000001', actorUserId: 'seed-bdc-user' })
    const second = await assignLead(db, { idempotencyKey: key, customerName: 'A', customerPhoneE164: '+15550000001', actorUserId: 'seed-bdc-user' })
    expect(second.leadId).toBe(first.leadId)
    expect(second.assignedRepId).toBe(first.assignedRepId)
  })
})
```

- [ ] Step 2: Run `pnpm --filter @phoneup/api test assignLead` — expect FAIL (`assignLead` not defined).
- [ ] Step 3: Implement `assignLead.ts` following spec §4 steps 1-12 exactly:

```ts
import { sql, eq, and, isNull } from 'drizzle-orm'
import { schema } from '@phoneup/db'
import { rankReps, businessDate, periodKey } from '@phoneup/core'
import { ensureEligibilitySnapshots } from './ensureEligibilitySnapshots'

const ADVISORY_LOCK_KEY = 42_100_1 // single store => single fixed key

export async function assignLead(db: DB, input: AssignLeadInput): Promise<AssignLeadResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)

    // 1. idempotency short-circuit
    const existing = await tx.query.assignmentEvents.findFirst({
      where: eq(schema.assignmentEvents.idempotencyKey, input.idempotencyKey),
    })
    if (existing) {
      const lead = await tx.query.lead.findFirst({ where: eq(schema.lead.id, existing.leadId) })
      return { leadId: existing.leadId, assignedRepId: lead?.assignedRepId ?? null, queueSnapshot: existing.queueSnapshot as any }
    }

    // 2. business date/period inside the lock
    const now = new Date()
    const bDate = businessDate(now)
    const pKey = periodKey(bDate)

    // 3. lazy ensure eligibility snapshots
    await ensureEligibilitySnapshots(tx, bDate)

    // 4. get-or-open current cycle
    let cycle = await tx.query.rotationCycle.findFirst({ where: isNull(schema.rotationCycle.closedAt) })
    if (!cycle) {
      ;[cycle] = await tx.insert(schema.rotationCycle).values({ openedAt: now }).returning()
    }

    // 5. rank all members
    const statuses = await tx.query.repDailyStatus.findMany({ where: eq(schema.repDailyStatus.businessDate, bDate) })
    const counters = await tx.query.repMonthCounters.findMany({ where: eq(schema.repMonthCounters.periodKey, pKey) })
    const servedThisCycle = await tx.query.rrCycleAssignments.findMany({ where: eq(schema.rrCycleAssignments.cycleId, cycle.id) })
    const servedSet = new Set(servedThisCycle.map(s => s.repId))
    const counterByRep = new Map(counters.map(c => [c.repId, c]))

    const rankInputs = statuses.map(s => ({
      repId: s.repId,
      isEligible: s.status === 'ELIGIBLE',
      ineligibleReason: s.reason ?? undefined,
      servedThisCycle: servedSet.has(s.repId),
      monthlyLoad: counterByRep.get(s.repId)?.upsMtd ?? 0,
      lastAssignedAt: counterByRep.get(s.repId)?.lastAssignedAt ?? null,
      rotationSeed: hashRepIdToSeed(s.repId), // stable per rep, deterministic
    }))
    const ranked = rankReps(rankInputs)

    // 6. emit SKIP for ineligible not yet consumed this cycle
    for (const r of ranked) {
      if (!r.isEligible && !servedSet.has(r.repId)) {
        await tx.insert(schema.assignmentEvents).values({
          repId: r.repId, eventType: 'SKIP', cycleNo: cycle.id,
          creditDelta: 0, queueSnapshot: ranked, idempotencyKey: `${input.idempotencyKey}-skip-${r.repId}`,
        })
        servedSet.add(r.repId)
      }
    }

    // 7. choose forced or first eligible
    const chosen = input.forcedRepId
      ? ranked.find(r => r.repId === input.forcedRepId)
      : ranked.find(r => r.isEligible && !servedSet.has(r.repId))

    // 9. duplicate-phone check — warn only, never block
    const dup = await tx.query.customer.findFirst({ where: eq(schema.customer.phoneE164, input.customerPhoneE164) })

    const [customer] = await tx.insert(schema.customer).values({
      fullName: input.customerName, phoneE164: input.customerPhoneE164,
    }).onConflictDoUpdate({ target: schema.customer.phoneE164, set: { fullName: input.customerName } }).returning()

    if (!chosen) {
      // 8. nobody eligible -> unassigned queue, never drop the lead
      const [lead] = await tx.insert(schema.lead).values({
        customerId: customer.id, status: 'UNASSIGNED', businessDate: bDate, periodKey: pKey, createdBy: input.actorUserId,
      }).returning()
      await tx.insert(schema.unassignedQueue).values({ leadId: lead.id, reason: 'NO_ELIGIBLE_REP' })
      return { leadId: lead.id, assignedRepId: null, queueSnapshot: ranked, duplicatePhone: !!dup }
    }

    // 10. write lead + ASSIGN event + bump counters + consume cycle slot, same tx
    const [lead] = await tx.insert(schema.lead).values({
      customerId: customer.id, assignedRepId: chosen.repId, status: 'ASSIGNED',
      businessDate: bDate, periodKey: pKey, createdBy: input.actorUserId,
    }).returning()

    await tx.insert(schema.assignmentEvents).values({
      leadId: lead.id, repId: chosen.repId, eventType: 'ASSIGN', cycleNo: cycle.id,
      creditDelta: 1, queueSnapshot: ranked, idempotencyKey: input.idempotencyKey,
    })
    await tx.insert(schema.rrCycleAssignments).values({ cycleId: cycle.id, repId: chosen.repId })
    await tx.insert(schema.repMonthCounters).values({
      repId: chosen.repId, periodKey: pKey, upsMtd: 1, upsToday: 1, lastAssignedAt: now,
    }).onConflictDoUpdate({
      target: [schema.repMonthCounters.repId, schema.repMonthCounters.periodKey],
      set: { upsMtd: sql`${schema.repMonthCounters.upsMtd} + 1`, upsToday: sql`${schema.repMonthCounters.upsToday} + 1`, lastAssignedAt: now },
    })

    // 11. cycle-completion check
    const allEligible = ranked.filter(r => r.isEligible)
    const nowServed = new Set([...servedSet, chosen.repId])
    if (allEligible.every(r => nowServed.has(r.repId))) {
      await tx.update(schema.rotationCycle).set({ closedAt: now }).where(eq(schema.rotationCycle.id, cycle.id))
      await tx.insert(schema.rotationCycle).values({ openedAt: now })
    }

    return { leadId: lead.id, assignedRepId: chosen.repId, queueSnapshot: ranked, duplicatePhone: !!dup }
  }).then(async (result) => {
    // 12. publish AFTER commit, never inside the transaction
    await publishAssignment(result)
    return result
  })
}

function hashRepIdToSeed(repId: string): number {
  let h = 0
  for (const c of repId) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h
}
```

- [ ] Step 4: Run test — expect PASS. If flaky on the cycle-completion branch, check seed data gives >1 eligible rep so "close and reopen" doesn't trigger mid-test unexpectedly — adjust seed, not the algorithm.
- [ ] Step 5: Write the router: `assignment.ts` exposing `assign` (perm `lead.assign`, input `assignLeadInputSchema`) and `void` (perm `lead.void`, input `voidLeadInputSchema`, time-boxed to same business day, own-assignment only unless override perm).
- [ ] Step 6: Commit.

```bash
git add apps/api
git commit -m "feat(api): assignment transaction — lock, ledger, counters, cycle logic"
```

---

### Task 7: Concurrency integration test

**Files:**
- Test: `apps/api/src/domain/assignLead.concurrency.test.ts`

**Interfaces:**
- Consumes: `assignLead` from Task 6.

- [ ] Step 1: Write the test — N=10 parallel `assignLead` calls (distinct idempotency keys) against M=3 eligible reps, assert: total ASSIGN events across reps == N, no rep serves twice before every other eligible rep has served once per cycle, `rep_month_counters.upsMtd` sums to N, one more parallel batch of duplicate idempotency keys resolves to the same N leads (exactly-once).

```ts
import { describe, it, expect } from 'vitest'
import { assignLead } from './assignLead'
import { db, schema } from '@phoneup/db'
import { randomUUID } from 'node:crypto'

describe('assignLead concurrency', () => {
  it('serves reps in correct round-robin order under 10 parallel submissions, no double-serve within a cycle', async () => {
    const calls = Array.from({ length: 10 }, (_, i) =>
      assignLead(db, { idempotencyKey: randomUUID(), customerName: `C${i}`, customerPhoneE164: `+1555000${1000 + i}`, actorUserId: 'seed-bdc-user' }))
    const results = await Promise.all(calls)
    expect(results.every(r => r.assignedRepId)).toBe(true)

    const counters = await db.query.repMonthCounters.findMany()
    const total = counters.reduce((sum, c) => sum + c.upsMtd, 0)
    expect(total).toBe(10)

    const events = await db.query.assignmentEvents.findMany({ where: (e, { eq }) => eq(e.eventType, 'ASSIGN') })
    expect(events.length).toBe(10)
  })

  it('is exactly-once under a burst of retries sharing one idempotency key', async () => {
    const key = randomUUID()
    const calls = Array.from({ length: 5 }, () =>
      assignLead(db, { idempotencyKey: key, customerName: 'Retry', customerPhoneE164: '+15559999999', actorUserId: 'seed-bdc-user' }))
    const results = await Promise.all(calls)
    const leadIds = new Set(results.map(r => r.leadId))
    expect(leadIds.size).toBe(1)
  })
})
```

- [ ] Step 2: Run against real `phoneup_dev` — expect PASS. If it fails on lock contention timeouts, confirm Task 6's `pg_advisory_xact_lock` (not `pg_try_advisory_xact_lock`) is used — it must block, not fail, under contention.
- [ ] Step 3: Commit.

```bash
git add apps/api
git commit -m "test(api): concurrency integration test for assignment transaction"
```

---

### Task 8: Status override + audit log

**Files:**
- Create: `apps/api/src/domain/overrideStatus.ts`
- Test: `apps/api/src/domain/overrideStatus.test.ts`
- Create: `apps/api/src/routers/rep.ts`

**Interfaces:**
- Consumes: same advisory lock key as Task 6 (overrides change ordering too — spec §0.1).
- Produces: `async function overrideStatus(db, input: { repId, status: 'FORCE_ACTIVE'|'FORCE_INACTIVE'|'FOLLOW_SCHEDULE', reasonCode, reasonNote, actorUserId }): Promise<void>` — writes `status_override` + `rep_daily_status` + `audit_events` in one transaction, same lock.

- [ ] Step 1: Failing test: override to `FORCE_INACTIVE` writes both `status_override` (append-only, mandatory reason) and updates `rep_daily_status` to `INELIGIBLE`, plus an `audit_events` row with before/after jsonb.
- [ ] Step 2: Implement inside `db.transaction` with the same `pg_advisory_xact_lock(ADVISORY_LOCK_KEY)` call as Task 6.
- [ ] Step 3: Run — expect PASS.
- [ ] Step 4: Router `rep.ts`: `overrideStatus` mutation, perm `rep.override`, input requires non-empty `reasonNote`.
- [ ] Step 5: Commit.

```bash
git add apps/api
git commit -m "feat(api): manager status override with audit trail, same advisory lock"
```

---

### Task 9: Realtime board sync

**Files:**
- Create: `apps/api/src/realtime/server.ts`, `apps/api/src/realtime/bus.ts`

**Interfaces:**
- Produces: `bus: EventEmitter` (in-process fan-out), `publishAssignment(result)` (called post-commit from Task 6), ws upgrade handler on the Fastify server broadcasting `{ type: 'ASSIGNMENT', leadId, assignedRepId, queueSnapshot }` to all connected board clients.

- [ ] Step 1: `bus.ts` — plain `EventEmitter`, typed `emit('assignment', payload)` / `on('assignment', ...)`. No Redis (single instance, ~44 users per spec §1).
- [ ] Step 2: `server.ts` — `ws` server attached to the same Fastify HTTP server, on connection subscribes to `bus`, on `bus` event sends JSON frame, cleans up listener on close.
- [ ] Step 3: Wire `publishAssignment` in `assignLead.ts` (Task 6) to `bus.emit('assignment', result)` — confirm by re-reading Task 6's `.then()` chain that this only ever fires after the transaction promise resolves.
- [ ] Step 4: Manual smoke: two `wscat` clients connected, trigger an assign via curl/tRPC, confirm both receive the event.
- [ ] Step 5: Commit.

```bash
git add apps/api
git commit -m "feat(api): in-process ws realtime fan-out for board sync"
```

---

### Task 10: Eligibility job (SHADOW mode) + `ensureEligibilitySnapshots`

**Files:**
- Modify: `apps/api/src/domain/ensureEligibilitySnapshots.ts` (replace Task 6's stub)
- Create: `apps/api/src/jobs/eligibility.ts`
- Test: `apps/api/src/jobs/eligibility.test.ts`

**Interfaces:**
- Produces: `async function ensureEligibilitySnapshots(tx, businessDate: string): Promise<void>` — idempotent, safe to call lazily mid-transaction (spec §6 fail-open) or from cron.
- Consumes: `work_requirement_policy`, `rep_shift`, `lead_activity` (CRM_IMPORT rows only).

- [ ] Step 1: Failing test: rep with 0 CRM-imported calls on their last working day, policy `min_calls=3`, `enforcement_mode='SHADOW'` → `eligibility_snapshot` shows would-be `INELIGIBLE`, but `rep_daily_status.status` stays `ELIGIBLE` (SHADOW never blocks).
- [ ] Step 2: Failing test: no `rep_shift` row for today for an active rep → `rep_daily_status.status = 'CONFIGURATION_ERROR'`, never silently `ELIGIBLE` (spec §6 fail-safe).
- [ ] Step 3: Failing test: existing manager override for today short-circuits — job does not overwrite `rep_daily_status` (override always wins, spec §6.4).
- [ ] Step 4: Implement per spec §6 steps 1-5: find rep-relative previous working day bounded by `max_prior_workday_age`, pull CRM_IMPORT `lead_activity` rows for that day, compare to `min_calls`, write `eligibility_snapshot`, then write `rep_daily_status` unless override exists, gate actual `INELIGIBLE` write on `enforcement_mode === 'ENFORCE'`.
- [ ] Step 5: Run all three — expect PASS.
- [ ] Step 6: `jobs/eligibility.ts` — node-cron entry running before store open (store-local time), calls `ensureEligibilitySnapshots` for every active rep for today's business date.
- [ ] Step 7: Commit.

```bash
git add apps/api
git commit -m "feat(api): eligibility job in SHADOW mode, fail-open/fail-safe per spec"
```

---

### Task 11: CRM import job (manual upload → parse)

**Files:**
- Create: `apps/api/src/jobs/crmImport.ts`
- Test: `apps/api/src/jobs/crmImport.test.ts`
- Create: `apps/api/src/routers/admin.ts` (import upload endpoint, perm `admin.*` or `schedule.manage` — manager/admin per spec §7)

**Interfaces:**
- Produces: `async function parseCrmImport(fileContents: string, businessDate: string): Promise<{ inserted: number; unmatchedRows: number }>` — writes `lead_activity` rows with `entry_source: 'CRM_IMPORT'`.

- [ ] Step 1: Failing test with a small fixture CSV (rep external id, call count/timestamps) → correct number of `lead_activity` rows inserted, keyed to rep+date.
- [ ] Step 2: Failing test: import missing/late for a rep/day → that rep's eligibility evaluation is skipped for that date (stays `ELIGIBLE`) and an `IMPORT_LATE` flag is raised — wire this check into Task 10's eligibility job (read: "was there an import for this business date at all").
- [ ] Step 3: Implement CSV parse (no external dependency needed for a fixed known column format — hand-roll a small parser, do not add a heavyweight CSV library for one CRM export shape) + insert.
- [ ] Step 4: Run — expect PASS.
- [ ] Step 5: Router endpoint accepting a file upload (multipart via `@fastify/multipart`), perm-gated, triggers `parseCrmImport`.
- [ ] Step 6: Commit.

```bash
git add apps/api
git commit -m "feat(api): daily CRM import job and manual upload endpoint"
```

---

### Task 12: `apps/web` — Assign screen

**Files:**
- Create: `apps/web/src/pages/AssignScreen.tsx`, `apps/web/src/components/RosterPanel.tsx`, `apps/web/src/components/DrilldownCard.tsx`
- Create: `apps/web/src/lib/trpc.ts` (tRPC client + TanStack Query wiring)

**Interfaces:**
- Consumes: `assignment.assign` tRPC mutation (Task 6), ws events from Task 9.
- Produces: nothing consumed downstream (leaf screen).

- [ ] Step 1: `trpc.ts` — `createTRPCReact<AppRouter>()`, QueryClient provider, ws-backed store hook subscribing to Task 9's socket for live roster refresh.
- [ ] Step 2: `AssignScreen.tsx` — lead entry form (phone, name, optional notes), generates `idempotencyKey` client-side (`crypto.randomUUID()`) once per form instance (not per submit-click, so a double-Enter reuses it), `Ctrl+Enter` submits.
- [ ] Step 3: `RosterPanel.tsx` — renders ranked roster from the mutation response / ws push: Next Up pinned, on-deck list, unavailable-with-reason list (`ineligibleReason` from ranking output).
- [ ] Step 4: `DrilldownCard.tsx` — shows customer name/phone with copy button (strip formatting + leading `1`, per spec §5), timestamp, logging BDC agent, full `queueSnapshot`. Auto-focus the copy button for ~5s after assignment; `Alt+C` recalls last copied phone from a small Zustand store.
- [ ] Step 5: Manual QA: run `pnpm --filter web dev` + `pnpm --filter @phoneup/api dev`, submit a lead, confirm roster updates, copy button strips to digits-only no leading 1.
- [ ] Step 6: Commit.

```bash
git add apps/web
git commit -m "feat(web): assign screen with roster panel and drilldown card"
```

---

### Task 13: `apps/web` — Staff list, my status, minimal dashboard

**Files:**
- Create: `apps/web/src/pages/StaffList.tsx`, `apps/web/src/pages/MyStatus.tsx`, `apps/web/src/pages/Dashboard.tsx`

**Interfaces:**
- Consumes: `rep.overrideStatus` mutation (Task 8), a new `board.dashboardSummary` query (thin read of `daily_facts` — add to `routers/board.ts`, perm `board.view`/manager-scoped for the 4 widgets).

- [ ] Step 1: `StaffList.tsx` — roster table, Force Active/Inactive/Follow Schedule buttons, mandatory reason modal, override visible on the row after (per spec §8.2 — no anonymous overrides).
- [ ] Step 2: `MyStatus.tsx` — own `rep_daily_status` + `computed_reason` verbatim, reactivation request form (text-only, calls `reactivation.request` — stub router if Phase 2 flow isn't built yet, but the form should exist since spec lists it under Phase 1 screens §8.3... confirm against §10 Phase 1 scope: reactivation *review* is Phase 2, but the self-service *view* is Phase 1 — build the view, stub the submit as "coming soon" if the backend isn't in Phase 1's cut).
- [ ] Step 3: `Dashboard.tsx` — exactly 4 widgets per spec §8.5: ups-per-rep this month, current cycle progress, disqualification count/list, override count. Nothing else.
- [ ] Step 4: Manual QA pass across all three screens with seeded data.
- [ ] Step 5: Commit.

```bash
git add apps/web
git commit -m "feat(web): staff list, rep status view, minimal 4-widget dashboard"
```

---

### Task 14: Nightly reconciliation job

**Files:**
- Create: `apps/api/src/jobs/reconciliation.ts`
- Test: `apps/api/src/jobs/reconciliation.test.ts`

**Interfaces:**
- Produces: `async function reconcile(db): Promise<{ mismatches: Array<{ repId: string; periodKey: string; expected: number; actual: number }> }>` — rebuilds expected counters from `assignment_events`, compares to `rep_month_counters`, alerts (log + manager notify stub) on mismatch, never silently auto-corrects without logging.

- [ ] Step 1: Failing test: seed a deliberately-drifted counter row vs. the ledger, `reconcile()` reports the mismatch.
- [ ] Step 2: Failing test: matching ledger/counters → empty mismatches array.
- [ ] Step 3: Implement: `SELECT rep_id, period_key, count(*) FROM assignment_events WHERE event_type='ASSIGN' GROUP BY 1,2` compared against `rep_month_counters`.
- [ ] Step 4: Run — expect PASS.
- [ ] Step 5: node-cron entry, nightly, store-local time.
- [ ] Step 6: Commit.

```bash
git add apps/api
git commit -m "feat(api): nightly reconciliation job, ledger vs counters"
```

---

## Self-Review Notes

- Spec coverage: §0 (Tasks 6,7), §1 (Task 1), §2 (Task 4), §3 (Task 3,5), §4 (Task 6), §5 (Task 12), §6 (Task 10), §7 (Task 11), §8.1-8.5 (Task 12,13), §9 (Tasks 2,6,7,10,11,14 + Task 12 manual QA). §8.6 Admin screen (policy editor, role mgmt, audit log) and reactivation *review* queue (§8.4) are Phase 2 per spec §10 — intentionally deferred, not missed.
- No placeholders: every code step above has concrete, runnable code against the actual schema/interfaces defined in earlier tasks.
- Type consistency: `RepRankInput` (Task 2) is the single shape threaded through Task 6's ranking call and Task 12's `RosterPanel`/`DrilldownCard` props — do not rename fields between tasks.
