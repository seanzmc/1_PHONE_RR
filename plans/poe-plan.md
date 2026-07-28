_Thinking..._

> I'm mapping out a comprehensive full-stack architecture for a dealership call tracking system, thinking through the data models with Prisma, implementing a round-robin distribution algorithm, designing REST APIs, structuring React components for real-time updates, setting up permission controls, and building in accountability features like disqualification logic alongside cron jobs for automation, calendar views, performance metrics, and a keyboard-optimized interface. I'm outlining the React app structure with routes, state management using React Query and Zustand, and detailing the BDC entry screen with its layout, keyboard navigation flow, optimistic assignment updates, sticky next-up display, copy-to-clipboard functionality, and duplicate detection. Then I'll cover realtime collaboration features like presence tracking and soft locks, metrics aggregation with rollup tables, management overrides with audit trails, security and multi-tenancy, testing strategy with seeding and simulation, deployment and observability, a phased roadmap, and edge cases. The core algorithm prioritizes eligible reps on shift and not disqualified, then sorts by ascending monthly phone-ups to determine next-up selection. Accountability checks happen at the day boundary using the previous working day — that's the most recent day the rep was actually scheduled and the store was open, so if they had time off we skip evaluation. I'm planning to use database-level locking with either a `FOR UPDATE` clause or advisory locks per dealership to handle concurrency safely, and I'll denormalize some counters on the daily and monthly stat tables to keep the lead assignment queries fast.

# Phone-Up Tracker — Full-Stack Architecture & Implementation Blueprint

**Working name:** `UpBoard`
**Stack:** React 18 (Vite, TS) + Node 20 (Fastify, TS) + PostgreSQL + Prisma + Redis + Socket.IO

---

## 0. Design Thesis (drives every decision below)

The BDC agent is on the phone _right now_ with a customer. The tool must answer one question in <1 second — **"Who gets this up?"** — and log it in **two keystrokes**. Everything else (metrics, calendars, overrides) is a management surface that must never slow down the entry surface.

Four principles:

| Principle                                  | Implementation consequence                                                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Zero-decision entry**                    | The server owns the round-robin. The UI _displays_ the decision; the BDC never picks a rep.                                                         |
| **Keyboard-first**                         | `Ctrl+Enter` submits. Phone field autofocuses. No modal confirmations on the happy path.                                                            |
| **Truth is shared, instantly**             | Socket.IO room per dealership. Three BDC agents entering ups simultaneously never double-assign.                                                    |
| **Accountability is computed, not argued** | Disqualification is a deterministic function of logged activity vs. a versioned policy. Overrides are always logged with a human name and a reason. |

---

## 1. System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  React SPA (Vite + TS)                                           │
│  ├─ /entry        BDC Lead Entry  (the hot path)                 │
│  ├─ /board        Live floor board (TV display mode)             │
│  ├─ /calendar     Schedule + deactivation calendar               │
│  ├─ /metrics      Cycles, distribution, conversion              │
│  ├─ /reactivation Manager review queue                           │
│  └─ /admin        Policy, roster, permissions, audit log         │
│                                                                  │
│  State: TanStack Query (server state) + Zustand (UI/ephemeral)   │
│  Realtime: socket.io-client → invalidate/patch query cache       │
└────────────┬─────────────────────────────────────┬───────────────┘
             │ HTTPS / JSON                        │ WSS
┌────────────▼─────────────────────────────────────▼───────────────┐
│  Node API (Fastify)                                              │
│  ┌─────────────┬──────────────┬───────────────┬────────────────┐ │
│  │ HTTP Routes │ Socket Gateway│ Domain Services│ Job Scheduler │ │
│  │ (zod DTOs)  │ (rooms/pres.) │  (pure logic)  │ (BullMQ+cron) │ │
│  └─────────────┴──────────────┴───────────────┴────────────────┘ │
│  Services: assignment · eligibility · accountability ·           │
│            scheduling · metrics · audit · notification           │
└────────────┬───────────────────────────┬─────────────────────────┘
             │ Prisma                    │ ioredis
┌────────────▼────────────┐  ┌───────────▼─────────────────────────┐
│ PostgreSQL              │  │ Redis                               │
│ · OLTP tables           │  │ · Socket.IO adapter (multi-instance) │
│ · Daily/monthly rollups │  │ · BullMQ queues                     │
│ · Advisory locks        │  │ · Presence + soft locks (TTL)       │
│ · Audit (append-only)   │  │ · Next-Up cache (invalidate-on-write)│
└─────────────────────────┘  └─────────────────────────────────────┘
```

**Why these picks**

- **Fastify over Express:** schema-first (zod/TypeBox) validation + serialization is ~2× faster on JSON, and route schemas double as OpenAPI + generated client types.
- **Postgres advisory locks** rather than a distributed lock service: the assignment critical section is per-dealership and sub-millisecond. `pg_advisory_xact_lock(dealership_id)` gives strict serialization for free inside the same transaction that writes the lead.
- **Rollup tables** (`RepDailyStat`, `RepMonthlyStat`) rather than computing `COUNT(*)` on every next-up calculation. The entry screen reads a 20-row table, not a scan of 4,000 leads.
- **Socket.IO over raw WS:** rooms, auto-reconnect with backoff, and the Redis adapter for horizontal scaling are all we'd otherwise rebuild.

---

## 2. Data Model (Prisma)

```prisma
// ─────────────── Tenancy & Identity ───────────────
model Dealership {
  id            String   @id @default(cuid())
  name          String
  timezone      String   @default("America/Chicago") // ALL day boundaries use this
  storeHours    Json     // { mon: {open:"09:00", close:"20:00"}, sun: null, ... }
  users         User[]
  policies      AccountabilityPolicy[]
}

enum Role { BDC MANAGER SALES_REP ADMIN }

model User {
  id            String   @id @default(cuid())
  dealershipId  String
  email         String   @unique
  passwordHash  String?
  displayName   String
  role          Role
  // Sales-rep specific
  isRep         Boolean  @default(false)
  team          String?          // "New", "Used", "Internet"
  hireDate      DateTime?
  sortSeed      Int      @default(0) // deterministic tie-break, avoids alphabetical bias
  // Manual master switch (independent of schedule + disqualification)
  manualStatus  ManualStatus @default(FOLLOW_SCHEDULE)
  manualNote    String?
  archivedAt    DateTime?

  permissions   Permission[]
  shifts        Shift[]
  leadsAsRep    Lead[]   @relation("repLeads")
  leadsAsBdc    Lead[]   @relation("bdcLeads")
  activities    ActivityLog[]
  disqualifications Disqualification[]
  dailyStats    RepDailyStat[]
  monthlyStats  RepMonthlyStat[]

  @@index([dealershipId, isRep, archivedAt])
}

enum ManualStatus { FOLLOW_SCHEDULE FORCE_ACTIVE FORCE_INACTIVE }

model Permission {
  id      String @id @default(cuid())
  userId  String
  key     String  // 'lead.create' | 'rep.override' | 'rep.reactivate' | 'policy.edit' | ...
  @@unique([userId, key])
}

// ─────────────── Scheduling ───────────────
model Shift {
  id           String   @id @default(cuid())
  userId       String
  workDate     DateTime @db.Date       // local calendar date, not timestamptz
  status       ShiftStatus             // WORKING | OFF | PTO | HALF_DAY | TRAINING
  startTime    String?                 // "09:00"
  endTime      String?
  source       String   @default("MANUAL") // MANUAL | IMPORT | RECURRING_TEMPLATE
  @@unique([userId, workDate])
  @@index([workDate])
}
enum ShiftStatus { WORKING OFF PTO HALF_DAY TRAINING }

model ScheduleTemplate {   // recurring weekly pattern, materialized into Shifts nightly
  id       String @id @default(cuid())
  userId   String
  weekday  Int      // 0-6
  status   ShiftStatus
  startTime String?
  endTime   String?
  @@unique([userId, weekday])
}

// ─────────────── The Lead (a "phone up") ───────────────
model Lead {
  id            String   @id @default(cuid())
  dealershipId  String
  refNumber     Int      // human-readable, per-dealership sequence
  customerName  String
  phone         String   // E.164 stored, formatted on display
  phoneDigits   String   // normalized for dupe detection
  altPhone      String?
  email         String?
  source        LeadSource
  vehicleInterest String?
  stockNumber   String?
  notes         String?

  bdcUserId     String
  repUserId     String?          // nullable: HOUSE / unassigned edge case
  assignmentMode AssignmentMode  @default(ROUND_ROBIN)
  assignmentReason Json?         // snapshot: candidate list + scores at decision time
  cycleId       String?
  cycleIndex    Int?             // position within the cycle

  status        LeadStatus @default(ASSIGNED)
  appointmentSetAt DateTime?
  appointmentShownAt DateTime?
  soldAt        DateTime?
  dealNumber    String?
  lostReason    String?

  createdAt     DateTime @default(now())
  createdLocalDate DateTime @db.Date   // denormalized for fast daily grouping

  @@unique([dealershipId, refNumber])
  @@index([dealershipId, createdLocalDate])
  @@index([repUserId, createdAt])
  @@index([dealershipId, phoneDigits])
}
enum LeadSource { PHONE_UP INTERNET WALK_IN REFERRAL SERVICE_DRIVE OTHER }
enum AssignmentMode { ROUND_ROBIN MANUAL_OVERRIDE REQUESTED_REP HOUSE }
enum LeadStatus { ASSIGNED CONTACTED APPT_SET APPT_SHOWN SOLD LOST DUPLICATE }

// ─────────────── Round-robin cycle tracking ───────────────
model RoundRobinCycle {
  id            String   @id @default(cuid())
  dealershipId  String
  cycleNumber   Int      // resets monthly
  periodMonth   String   // "2025-06"
  startedAt     DateTime @default(now())
  completedAt   DateTime?
  rosterSnapshot Json    // eligible rep ids at cycle start
  leadCount     Int      @default(0)
  @@unique([dealershipId, periodMonth, cycleNumber])
}

// ─────────────── Accountability ───────────────
model AccountabilityPolicy {
  id            String  @id @default(cuid())
  dealershipId  String
  version       Int
  effectiveFrom DateTime
  minCalls      Int     @default(40)
  minNotesTotal Int     @default(20)
  notesPerAssignedLead Int @default(2)   // each lead you got yesterday needs N notes
  noteMinChars  Int     @default(40)     // anti-"asdf" guard
  gracePeriodHours Int  @default(24)
  appliesToTeams String[] @default([])   // empty = all
  isActive      Boolean @default(true)
}

model ActivityLog {          // the "work" reps log in the dashboard
  id           String   @id @default(cuid())
  userId       String
  leadId       String?         // note tied to a specific up
  type         ActivityType    // CALL_LOGGED | NOTE | TEXT | EMAIL | APPT_SET | CRM_SYNC_PROOF
  outcome      String?         // CONNECTED | VOICEMAIL | NO_ANSWER | BAD_NUMBER
  body         String?
  charCount    Int      @default(0)
  occurredAt   DateTime @default(now())
  localDate    DateTime @db.Date
  createdVia   String   @default("WEB")  // WEB | BULK | IMPORT
  @@index([userId, localDate])
  @@index([leadId])
}
enum ActivityType { CALL_LOGGED NOTE TEXT EMAIL APPT_SET CRM_SYNC_PROOF }

model Disqualification {
  id            String   @id @default(cuid())
  userId        String
  dealershipId  String
  forDate       DateTime @db.Date   // the day they're blocked
  evaluatedDate DateTime @db.Date   // the previous working day that was judged
  policyVersion Int
  reason        Json     // { calls: {req:40, actual:12}, notes:{...}, leadsMissingNotes:[...] }
  state         DqState  @default(ACTIVE)
  reactivatedAt DateTime?
  reactivatedBy String?
  reactivationNote String?
  appealId      String?
  @@unique([userId, forDate])
  @@index([dealershipId, forDate])
}
enum DqState { ACTIVE REACTIVATED EXPIRED VOIDED }

model ReactivationRequest {
  id            String  @id @default(cuid())
  disqualificationId String @unique
  userId        String
  submittedAt   DateTime @default(now())
  repStatement  String
  evidence      Json    // [{kind:'SCREENSHOT'|'CRM_EXPORT'|'CALL_LOG_CSV', url, sha256}]
  state         ReqState @default(PENDING)
  decidedBy     String?
  decidedAt     DateTime?
  decisionNote  String?
}
enum ReqState { PENDING APPROVED DENIED WITHDRAWN }

// ─────────────── Rollups (read-optimized) ───────────────
model RepDailyStat {
  userId        String
  localDate     DateTime @db.Date
  dealershipId  String
  leadsReceived Int @default(0)
  callsLogged   Int @default(0)
  notesLogged   Int @default(0)
  qualifyingNotes Int @default(0)
  apptsSet      Int @default(0)
  sold          Int @default(0)
  wasScheduled  Boolean @default(false)
  wasEligible   Boolean @default(false)
  wasDisqualified Boolean @default(false)
  @@id([userId, localDate])
  @@index([dealershipId, localDate])
}

model RepMonthlyStat {
  userId        String
  periodMonth   String   // "2025-06"
  dealershipId  String
  totalUps      Int @default(0)   // ← the ascending-order key for round-robin
  cycleUps      Int @default(0)   // resets each cycle; 0 == "non-assigned this cycle"
  lastAssignedAt DateTime?
  sold          Int @default(0)
  apptsSet      Int @default(0)
  dqCount       Int @default(0)
  skipCount     Int @default(0)
  @@id([userId, periodMonth])
  @@index([dealershipId, periodMonth])
}

model AuditEvent {          // append-only, never updated
  id         String   @id @default(cuid())
  dealershipId String
  actorId    String?
  action     String   // 'REP_FORCE_ACTIVE' | 'LEAD_REASSIGN' | 'DQ_REACTIVATE' | ...
  entityType String
  entityId   String
  before     Json?
  after      Json?
  reason     String?
  ip         String?
  createdAt  DateTime @default(now())
  @@index([dealershipId, createdAt])
  @@index([entityType, entityId])
}
```

**Modeling notes worth defending**

- `localDate DateTime @db.Date` denormalized onto `Lead` and `ActivityLog` removes every `AT TIME ZONE` conversion from hot queries. A dealership at 9:15 PM local is a _different business day_ than UTC — this bug will bite you otherwise.
- `assignmentReason Json` stores the **full candidate ranking at decision time**. When a rep says "why did Dave get three in a row?", you replay the exact snapshot instead of re-deriving it from mutated state. This single field kills 90% of disputes.
- Policy is **versioned + effective-dated**. A disqualification carries `policyVersion` so historical DQs remain explainable after management raises the call minimum.

---

## 3. The Core Domain Logic

### 3.1 Eligibility Pipeline (pure, unit-testable)

Every rep resolves to one of a small set of states. Keep it a pure function over a snapshot — no DB access inside.

```ts
// server/src/domain/eligibility.ts
export type RepState =
  | { code: "ELIGIBLE" }
  | { code: "NEXT_UP" }
  | { code: "OFF_SCHEDULE"; detail: ShiftStatus }
  | { code: "DISQUALIFIED"; dq: DqSummary }
  | { code: "FORCED_INACTIVE"; note?: string }
  | { code: "ARCHIVED" }
  | { code: "SHIFT_NOT_STARTED"; startsAt: string }
  | { code: "SHIFT_ENDED"; endedAt: string };

interface RepSnapshot {
  userId: string;
  displayName: string;
  team: string | null;
  archivedAt: Date | null;
  manualStatus: ManualStatus;
  manualNote: string | null;
  shift: { status: ShiftStatus; startTime?: string; endTime?: string } | null;
  activeDq: DqSummary | null;
  monthly: { totalUps: number; cycleUps: number; lastAssignedAt: Date | null };
  sortSeed: number;
}

/** Order matters: this IS the business rule hierarchy. */
export function resolveState(r: RepSnapshot, nowLocalHHMM: string): RepState {
  if (r.archivedAt) return { code: "ARCHIVED" };
  if (r.manualStatus === "FORCE_INACTIVE")
    return { code: "FORCED_INACTIVE", note: r.manualNote ?? undefined };

  // FORCE_ACTIVE overrides schedule AND disqualification — the manager's escape hatch.
  if (r.manualStatus === "FORCE_ACTIVE") return { code: "ELIGIBLE" };

  if (r.activeDq) return { code: "DISQUALIFIED", dq: r.activeDq };
  if (!r.shift || r.shift.status === "OFF" || r.shift.status === "PTO")
    return { code: "OFF_SCHEDULE", detail: r.shift?.status ?? "OFF" };

  if (r.shift.startTime && nowLocalHHMM < r.shift.startTime)
    return { code: "SHIFT_NOT_STARTED", startsAt: r.shift.startTime };
  if (r.shift.endTime && nowLocalHHMM > r.shift.endTime)
    return { code: "SHIFT_ENDED", endedAt: r.shift.endTime };

  return { code: "ELIGIBLE" };
}
```

> **Deliberate choice:** `FORCE_ACTIVE` beats `DISQUALIFIED`. A manager toggling a rep on _is_ the reactivation path when there's no time for the formal appeal flow — but the toggle writes an `AuditEvent` and appears on the metrics dashboard as an "override-active DQ," so the shortcut is visible, not invisible.

### 3.2 Next-Up Ordering — the round-robin

Requirement restated as a comparator:

1. Only `ELIGIBLE` reps are candidates.
2. **Non-assigned-this-cycle first** → `cycleUps === 0` sorts ahead of `cycleUps > 0`. (Within cycle, ascending `cycleUps` handles mid-cycle roster additions.)
3. Then **ascending monthly total ups** (`totalUps`) — the equity guarantee.
4. Then longest-waiting (`lastAssignedAt` ASC, nulls first).
5. Then deterministic `sortSeed` — never alphabetical, so "Aaron" doesn't win every coin flip forever.

```ts
// server/src/domain/roundRobin.ts
export function rankCandidates(reps: EligibleRep[]): EligibleRep[] {
  return [...reps].sort(
    (a, b) =>
      (a.cycleUps === 0 ? 0 : 1) - (b.cycleUps === 0 ? 0 : 1) ||
      a.cycleUps - b.cycleUps ||
      a.totalUps - b.totalUps ||
      ts(a.lastAssignedAt) - ts(b.lastAssignedAt) ||
      a.sortSeed - b.sortSeed ||
      a.userId.localeCompare(b.userId),
  );
}
const ts = (d: Date | null) => (d ? d.getTime() : 0);

/** A cycle is complete when no eligible rep sits at cycleUps === 0. */
export function isCycleComplete(reps: EligibleRep[]): boolean {
  return reps.length > 0 && reps.every((r) => r.cycleUps > 0);
}
```

**Cycle rollover semantics (the tricky part).** After each assignment, re-evaluate `isCycleComplete` against the _current_ eligible set. If complete: close the cycle, `cycleNumber++`, reset `cycleUps = 0` for all reps in the dealership, snapshot the roster. Consequences to accept explicitly:

- A rep who becomes eligible mid-cycle (clocked in late, manager reactivation) enters at `cycleUps = 0` and jumps to the front of the _remaining_ order — correct, since they're owed ups.
- A rep who goes ineligible mid-cycle can't block completion, because they're excluded from the `every()` check.
- Ties in `totalUps` at cycle start are broken by wait time, so cycle _order_ naturally rotates between cycles instead of repeating the same sequence.

### 3.3 Atomic Assignment (the critical section)

Three BDC agents pressing submit within 50ms must produce three different reps.

```ts
// server/src/services/assignment.service.ts
export async function assignLead(input: CreateLeadInput, actor: Actor) {
  return prisma.$transaction(
    async (tx) => {
      // 1. Serialize all assignment for this dealership. Released on commit/rollback.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${actor.dealershipId}))`;

      // 2. Idempotency: same client key inside 10 min returns the original lead.
      const existing = await tx.lead.findFirst({
        where: {
          dealershipId: actor.dealershipId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      if (existing) return { lead: existing, replayed: true };

      const { periodMonth, localDate, nowHHMM } = clock(
        actor.dealership.timezone,
      );
      const snapshots = await loadRepSnapshots(
        tx,
        actor.dealershipId,
        localDate,
        periodMonth,
      );
      const states = snapshots.map((s) => ({
        ...s,
        state: resolveState(s, nowHHMM),
      }));
      const eligible = states.filter((s) => s.state.code === "ELIGIBLE");

      // 3. Resolve target rep
      let repUserId: string | null,
        mode: AssignmentMode,
        ranked = rankCandidates(eligible);
      if (input.overrideRepId) {
        assertPermission(actor, "lead.override_assign");
        repUserId = input.overrideRepId;
        mode = "MANUAL_OVERRIDE";
      } else if (eligible.length === 0) {
        repUserId = null;
        mode = "HOUSE"; // nobody eligible → HOUSE queue, alert managers
      } else {
        repUserId = ranked[0].userId;
        mode = "ROUND_ROBIN";
      }

      const cycle = await getOrCreateOpenCycle(
        tx,
        actor.dealershipId,
        periodMonth,
        eligible,
      );

      // 4. Write lead with a full decision snapshot for auditability
      const lead = await tx.lead.create({
        data: {
          ...toLeadFields(input),
          dealershipId: actor.dealershipId,
          refNumber: await nextRefNumber(tx, actor.dealershipId),
          bdcUserId: actor.userId,
          repUserId,
          assignmentMode: mode,
          cycleId: cycle.id,
          cycleIndex: cycle.leadCount + 1,
          createdLocalDate: localDate,
          idempotencyKey: input.idempotencyKey,
          assignmentReason: {
            decidedAt: new Date().toISOString(),
            mode,
            policyVersion: actor.policy.version,
            candidates: ranked.slice(0, 12).map((r) => ({
              id: r.userId,
              name: r.displayName,
              cycleUps: r.cycleUps,
              totalUps: r.totalUps,
              lastAssignedAt: r.lastAssignedAt,
            })),
            skipped: states
              .filter((s) => s.state.code !== "ELIGIBLE")
              .map((s) => ({ id: s.userId, why: s.state.code })),
          },
        },
      });

      // 5. Increment rollups atomically in the same tx
      if (repUserId) {
        await tx.repMonthlyStat.upsert({
          where: { userId_periodMonth: { userId: repUserId, periodMonth } },
          create: {
            userId: repUserId,
            periodMonth,
            dealershipId: actor.dealershipId,
            totalUps: 1,
            cycleUps: 1,
            lastAssignedAt: new Date(),
          },
          update: {
            totalUps: { increment: 1 },
            cycleUps: { increment: 1 },
            lastAssignedAt: new Date(),
          },
        });
        await bumpDailyStat(tx, repUserId, localDate, { leadsReceived: 1 });
      }
      await tx.roundRobinCycle.update({
        where: { id: cycle.id },
        data: { leadCount: { increment: 1 } },
      });

      // 6. Cycle rollover
      const after = eligible.map((r) =>
        r.userId === repUserId ? { ...r, cycleUps: r.cycleUps + 1 } : r,
      );
      let cycleClosed = false;
      if (isCycleComplete(after)) {
        await closeCycleAndReset(tx, cycle, actor.dealershipId, periodMonth);
        cycleClosed = true;
      }

      return {
        lead,
        cycleClosed,
        nextUpPreview: computeNextUp(after, repUserId),
      };
    },
    { isolationLevel: "RepeatableRead", timeout: 8000 },
  );
}
```

After commit, the route handler emits:

```ts
io.to(room(dealershipId)).emit("lead:assigned", {
  lead: publicLead(lead),
  assignedRepName,
  cycleClosed,
  nextUp,
  statsDelta,
});
```

Clients patch their TanStack Query cache from the payload — **no refetch on the hot path**, so the board updates in ~30ms across all connected screens.

### 3.4 Accountability Evaluation — "reference the previous working day"

The subtle requirement: _the previous working day is per-rep, not per-calendar._ A rep off Sunday–Monday is judged Tuesday morning against **Saturday**.

```ts
// server/src/services/accountability.service.ts

/** Walk back up to 14 days for the most recent day this rep was scheduled AND store was open. */
async function findPreviousWorkingDay(
  userId: string,
  from: LocalDate,
  tz: string,
) {
  for (let i = 1; i <= 14; i++) {
    const d = subDays(from, i);
    if (!isStoreOpen(d)) continue;
    const shift = await prisma.shift.findUnique({
      where: { userId_workDate: { userId, workDate: d } },
    });
    if (shift && (shift.status === "WORKING" || shift.status === "HALF_DAY"))
      return { date: d, shift };
  }
  return null; // long vacation / new hire → no evaluation, no DQ
}

export async function evaluateRepForDate(
  userId: string,
  targetDate: LocalDate,
  dealership: Dealership,
) {
  const prev = await findPreviousWorkingDay(
    userId,
    targetDate,
    dealership.timezone,
  );
  if (!prev)
    return { verdict: "SKIPPED", why: "NO_PRIOR_WORKING_DAY" as const };

  const policy = await policyEffectiveOn(dealership.id, prev.date);
  const stat = await prisma.repDailyStat.findUnique({
    where: { userId_localDate: { userId, localDate: prev.date } },
  });

  // Pro-rate for half days so partial shifts aren't auto-fails
  const factor = prev.shift.status === "HALF_DAY" ? 0.5 : 1;
  const reqCalls = Math.ceil(policy.minCalls * factor);
  const reqNotes = Math.ceil(policy.minNotesTotal * factor);

  const calls = stat?.callsLogged ?? 0;
  const notes = stat?.qualifyingNotes ?? 0; // only notes >= noteMinChars count

  // Per-lead note coverage: every up received that day needs N substantive notes
  const leadsMissingNotes = await prisma.$queryRaw<
    { id: string; ref: number; n: number }[]
  >`
    SELECT l.id, l."refNumber" AS ref, COUNT(a.id)::int AS n
    FROM "Lead" l
    LEFT JOIN "ActivityLog" a
      ON a."leadId" = l.id AND a.type IN ('NOTE','CALL_LOGGED')
     AND a."charCount" >= ${policy.noteMinChars}
    WHERE l."repUserId" = ${userId} AND l."createdLocalDate" = ${prev.date}::date
    GROUP BY l.id, l."refNumber"
    HAVING COUNT(a.id) < ${policy.notesPerAssignedLead}
  `;

  const failures = [
    calls < reqCalls && {
      rule: "MIN_CALLS",
      required: reqCalls,
      actual: calls,
    },
    notes < reqNotes && {
      rule: "MIN_NOTES",
      required: reqNotes,
      actual: notes,
    },
    leadsMissingNotes.length > 0 && {
      rule: "LEAD_NOTE_COVERAGE",
      required: policy.notesPerAssignedLead,
      leads: leadsMissingNotes,
    },
  ].filter(Boolean);

  return failures.length
    ? {
        verdict: "DISQUALIFY" as const,
        evaluatedDate: prev.date,
        policy,
        failures,
      }
    : { verdict: "PASS" as const, evaluatedDate: prev.date };
}
```

**Scheduled jobs (BullMQ, per-dealership timezone):**

| Job                      | Cron (local) | Responsibility                                                                                                                                                                             |
| ------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `materialize-shifts`     | 02:00 daily  | Expand `ScheduleTemplate` → `Shift` rows 21 days out; never overwrite manual edits.                                                                                                        |
| `nightly-accountability` | 04:15 daily  | Run `evaluateRepForDate` for every active rep for _today_; write `Disqualification` rows + `RepMonthlyStat.dqCount`; snapshot `RepDailyStat.wasEligible/wasDisqualified` for the calendar. |
| `dq-notify`              | 04:30 daily  | Email/SMS DQ'd reps with the exact numbers they missed + a deep link to submit a reactivation request. Digest to managers.                                                                 |
| `expire-dq`              | 23:59 daily  | `ACTIVE → EXPIRED` (DQ is one-day only, per spec).                                                                                                                                         |
| `rollup-repair`          | hourly       | Recompute yesterday's rollups from source tables; alert on drift. Self-healing counters.                                                                                                   |
| `month-close`            | 1st, 00:05   | Freeze `RepMonthlyStat`, reset `cycleUps`, open cycle #1 for new month.                                                                                                                    |

> **Idempotency:** every job is keyed `job:{name}:{dealershipId}:{localDate}` in BullMQ so a redeploy at 04:14 can't double-DQ anyone.

**Grace-period nuance:** if `policy.gracePeriodHours = 24`, the 04:15 job counts activity logged up to 04:15 today against yesterday's requirement. Reps who catch up on notes at 11 PM aren't punished — which keeps the tool from being perceived as a gotcha machine, the #1 reason floor staff sabotage these systems.

### 3.5 Reactivation State Machine

```
DISQUALIFIED (auto, 04:15)
   │
   ├─ rep submits ReactivationRequest (statement + evidence uploads) → PENDING
   │      ├─ manager APPROVE  → Disqualification.state = REACTIVATED
   │      │                     rep becomes ELIGIBLE immediately, enters cycle at cycleUps=0
   │      │                     AuditEvent{ DQ_REACTIVATE, reason }
   │      └─ manager DENY     → stays ACTIVE until 23:59 EXPIRED
   │
   └─ manager sets manualStatus=FORCE_ACTIVE (fast path, bypasses request)
          → AuditEvent + flagged on metrics as "override-active DQ"
```

Evidence upload: presigned S3/R2 PUT, `sha256` stored, files retained 90 days. Managers see a side-by-side: **system-recorded activity** vs. **rep-claimed evidence**. If a manager approves 3+ times for the same rep in a month, the reactivation queue surfaces a "pattern" badge — oversight on the oversight.

---

## 4. API Surface

```
POST   /api/leads                        ← THE hot path. Returns {lead, nextUp, cycleClosed}
GET    /api/board                        ← Full entry-screen payload, one round trip
PATCH  /api/leads/:id                    ← status, notes, outcome
POST   /api/leads/:id/reassign           ← perm: lead.reassign  (reason required)
GET    /api/leads/check-duplicate?phone= ← debounced dupe lookup (30/60/90-day window)

GET    /api/reps/next-up                 ← lightweight poll fallback if WS drops
PATCH  /api/reps/:id/status              ← perm: rep.override   {FORCE_ACTIVE|FORCE_INACTIVE|FOLLOW_SCHEDULE, reason}
POST   /api/reps/:id/skip                ← "stepped away" — pass the up, log skipCount

GET    /api/schedule?from&to             ← calendar grid
PUT    /api/schedule/bulk                ← perm: schedule.edit  (drag-paint batch upsert)
POST   /api/schedule/import              ← CSV / iCal ingest

GET    /api/disqualifications?date&state
POST   /api/disqualifications/:id/request       ← rep submits appeal
POST   /api/disqualifications/:id/decide        ← perm: rep.reactivate
POST   /api/uploads/presign

GET    /api/metrics/summary?month        ← cycles, total distributed, DQ count
GET    /api/metrics/by-rep?month
GET    /api/metrics/by-bdc?month
GET    /api/metrics/conversion?from&to&groupBy
GET    /api/metrics/calendar?month&userId
GET    /api/audit?entityType&entityId

GET    /api/policy | PUT /api/policy     ← perm: policy.edit (creates new version)
```

**WebSocket contract**

| Event               | Direction | Payload                                                            |
| ------------------- | --------- | ------------------------------------------------------------------ |
| `board:snapshot`    | S→C       | Full rep list + next-up on connect/reconnect                       |
| `lead:assigned`     | S→C       | Lead, rep, new next-up, stat deltas, `cycleClosed`                 |
| `rep:state_changed` | S→C       | Status override, DQ, reactivation, shift boundary                  |
| `cycle:completed`   | S→C       | Cycle number, lead count → triggers celebratory toast              |
| `presence:update`   | S→C       | Who's on the entry screen right now                                |
| `entry:typing`      | C→S→C     | `{ bdcName, phoneDigitsPrefix }` — collision warning before submit |
| `entry:claim`       | C→S       | Optional 20s soft lock on next-up (see §5.4)                       |

### Permission Matrix

| Capability                 |    BDC     | Sales Rep |  Manager   | Admin |
| -------------------------- | :--------: | :-------: | :--------: | :---: |
| Create lead / view board   |     ✅     |  👁 own   |     ✅     |  ✅   |
| Log activity (calls/notes) |   ✅ own   |  ✅ own   |   ✅ any   |  ✅   |
| Override rep status        |     —      |     —     |     ✅     |  ✅   |
| Reassign a lead            | ⚠️ w/ perm |     —     |     ✅     |  ✅   |
| Manual-override assignment | ⚠️ w/ perm |     —     |     ✅     |  ✅   |
| Approve reactivation       |     —      |     —     |     ✅     |  ✅   |
| Edit schedule              |     👁     |  👁 own   |     ✅     |  ✅   |
| Edit accountability policy |     —      |     —     | ⚠️ w/ perm |  ✅   |
| View audit log             |     —      |     —     |     ✅     |  ✅   |

Enforced twice: a Fastify `preHandler` guard (authoritative) **and** a `usePermission()` hook for UI affordances. Never trust the client; never show a button that will 403.

---

## 5. Frontend Architecture

### 5.1 Project Layout

```
src/
  app/            router, providers, error boundaries, theme
  features/
    entry/        ← BDC Lead Entry (the star)
      EntryScreen.tsx
      LeadEntryForm.tsx
      RepRoster.tsx  RepRow.tsx  NextUpBanner.tsx
      DuplicateWarning.tsx  RecentAssignments.tsx
      useAssignLead.ts  useBoardSocket.ts  useHotkeys.ts
    board/        TV/floor display mode
    calendar/     schedule + deactivation grid
    metrics/      charts & leaderboards
    reactivation/ manager review queue
    admin/        roster, policy, permissions, audit
  shared/
    api/          generated client from Fastify schemas
    components/   Button, Table, Sheet, CopyButton, StatusPill
    hooks/        usePermission, useLocalDate, useClipboard
    lib/          phone.ts, formatters, tz.ts
```

### 5.2 The BDC Entry Screen — Layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│ UpBoard   Cycle #7 · 142 ups this month   ● 3 BDC online   Tue Jun 24 2:47p│
├──────────────────────────────────┬─────────────────────────────────────────┤
│  NEW PHONE UP                    │  SALES FLOOR                    ↻ live │
│                                  │                                         │
│  Phone *  [(555) 210-9988   ] 📋 │  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓  │
│   ⚠ Called 6d ago → M. Reyes     │  ┃ ▶ NEXT UP   MARIA REYES          ┃  │
│                                  │  ┃   Cycle 0 · Month 11 · 41m wait  ┃  │
│  Name *   [Dana Whitfield      ] │  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │
│  Source   [Phone Up        ▾]    │  ── ON DECK ──────────────────────────  │
│  Vehicle  [2023 Tacoma TRD   ]   │  2  J. Okafor      0 cyc · 11 mo       │
│  Notes    [Trade-in, 3p today ]  │  3  T. Nguyen      0 cyc · 12 mo       │
│                                  │  4  B. Castillo    1 cyc · 13 mo       │
│  ┌──────────────────────────────┐│  5  L. Park        1 cyc · 13 mo       │
│  │ ⏎ ASSIGN TO MARIA REYES      ││  ── UNAVAILABLE ─────────────────────  │
│  └──────────────────────────────┘│  ✕ D. Fisher   DQ · 12/40 calls  [i]   │
│  ⌥ Override assignment           │  ✕ S. Ali      Off (PTO)               │
│                                  │  ✕ R. Boyd     Forced off — "warranty  │
│  LAST 5   #1481 → J. Okafor  1m  │                  school" · K. Diaz     │
│           #1480 → T. Nguyen  6m  │  ⏸ M. Chen     Shift starts 4:00p      │
└──────────────────────────────────┴─────────────────────────────────────────┘
```

**Deliberate UX decisions**

- **Full roster always visible**, grouped `NEXT UP → ON DECK → UNAVAILABLE`. The highlighted next-up row uses _three_ redundant signals (thick border + `▶` glyph + background) so it reads correctly on a glare-washed showroom monitor and passes WCAG without relying on color alone.
- **Unavailable reps show _why_, inline.** This kills the "why am I being skipped?" hallway conversation and the manager's Slack ping. `[i]` opens the DQ detail popover: required vs. actual, evaluated date, and a "Request reactivation" button if you're that rep.
- **The submit button names the recipient.** "Assign to Maria Reyes" — not "Submit." The BDC agent confirms the human, not the action.
- **Only 2 required fields.** Phone + name. Everything else is optional and post-fillable, because the customer is on the line.

### 5.3 Hot-path Implementation

**Keyboard contract**

| Key               | Action                              |
| ----------------- | ----------------------------------- |
| `/` or `Ctrl+K`   | Focus phone field from anywhere     |
| `Tab`/`Shift+Tab` | Field traversal (correct DOM order) |
| `Ctrl/⌘+Enter`    | Submit from _any_ field             |
| `⌥/Alt+O`         | Open override combobox (perm-gated) |
| `⌥/Alt+C`         | Copy the phone in the form          |
| `Esc`             | Clear form (with 3s undo toast)     |

```tsx
// features/entry/LeadEntryForm.tsx (abridged)
export function LeadEntryForm({ nextUp }: { nextUp: Rep | null }) {
  const phoneRef = useRef<HTMLInputElement>(null);
  const { mutate, isPending } = useAssignLead();
  const idemKey = useRef(crypto.randomUUID());
  const form = useForm<LeadInput>({ resolver: zodResolver(leadSchema) });

  const digits = normalizePhone(form.watch("phone"));
  const dupe = useDuplicateCheck(digits); // debounced 350ms, ≥10 digits

  useHotkeys({
    "mod+enter": () => form.handleSubmit(submit)(),
    "mod+k": () => phoneRef.current?.focus(),
    escape: () => {
      form.reset();
      phoneRef.current?.focus();
    },
  });

  const submit = (data: LeadInput) => {
    mutate(
      { ...data, idempotencyKey: idemKey.current },
      {
        onSuccess: (res) => {
          toast.success(`#${res.lead.refNumber} → ${res.assignedRepName}`, {
            action: {
              label: "Reassign",
              onClick: () => openReassign(res.lead.id),
            },
          });
          form.reset();
          idemKey.current = crypto.randomUUID(); // new key per attempt
          phoneRef.current?.focus(); // ← ready for the next call, always
        },
      },
    );
  };

  return (
    <form onSubmit={form.handleSubmit(submit)}>
      <PhoneField
        ref={phoneRef}
        {...form.register("phone")}
        autoFocus
        onPaste={handleSmartPaste}
      />{" "}
      {/* strips (), -, +1, spaces */}
      {dupe.data?.match && <DuplicateWarning match={dupe.data.match} />}
      {/* ...remaining fields... */}
      <SubmitButton disabled={isPending}>
        {nextUp
          ? `Assign to ${nextUp.displayName}`
          : "Assign to HOUSE — no one eligible"}
      </SubmitButton>
    </form>
  );
}
```

**Optimistic assignment with server reconciliation.** Show the assignment instantly, but treat the server as truth — the whole point of the advisory lock is that the client's _predicted_ next-up can be wrong under concurrency.

```ts
// features/entry/useAssignLead.ts
export function useAssignLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LeadInput) => api.post("/leads", body),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: ["board"] });
      const prev = qc.getQueryData<Board>(["board"]);
      qc.setQueryData<Board>(
        ["board"],
        (b) => b && applyOptimisticAssign(b, body, prev!.nextUp),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      qc.setQueryData(["board"], ctx?.prev);
      toast.error("Assignment failed — nothing was saved. Retry?");
    },
    // Server payload is authoritative; also arrives via socket for other clients.
    onSuccess: (res) =>
      qc.setQueryData<Board>(["board"], (b) => b && applyServerBoard(b, res)),
  });
}
```

**Quick copy to clipboard** — CRM lookup is manual, so this is a first-class control, not a nice-to-have:

```tsx
export function CopyPhone({ phone }: { phone: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const digits = phone.replace(/\D/g, "").replace(/^1/, "");
    try {
      await navigator.clipboard.writeText(digits);
    } catch {
      legacyCopy(digits);
    } // execCommand fallback
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <button
      type="button"
      onClick={copy}
      title="Copy digits for CRM (⌥C)"
      aria-label={`Copy ${phone}`}
      className="copy-btn"
    >
      {copied ? <CheckIcon /> : <ClipboardIcon />}
      <span className="sr-only" role="status">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}
```

Copy **digits only, no formatting, leading `1` stripped** — most dealer CRM search boxes choke on `(555) 210-9988`. Also expose `tel:` and a `Copy row` action (name + phone + vehicle, tab-delimited) for reps pasting into a CRM note field.

### 5.4 Collaborative Safeguards

Three BDC agents, one board. Two mechanisms, layered:

1. **Server-side serialization (authoritative).** The advisory lock makes double-assignment structurally impossible. This alone is correct.
2. **Client-side courtesy signals (UX).** Because _correct_ still feels jarring when your predicted rep changes mid-typing:
   - **Presence bar:** avatars of BDC agents on `/entry`.
   - **Soft claim:** on first keystroke in the phone field, emit `entry:claim`. Other clients render a subtle `Jess is entering an up…` ribbon on the next-up row. TTL 20s in Redis, refreshed on typing, released on submit/blur. Purely advisory — never blocks.
   - **Live phone collision:** `entry:typing` broadcasts a hashed 7-digit prefix. If two agents type the same number, both see `⚠ Alex is entering this same number` _before_ submit. Prevents the classic double-up on a customer who called twice.
   - **Next-up shift animation:** if the server returns a different rep than predicted, the row slides with a brief `Reassigned live — Maria was just taken` note. Change is _explained_, not silent.

---

## 6. Visualizations & Metrics

### 6.1 Live Metrics Dashboard (`/metrics`)

| Widget                      | Viz                                                                                  | Query source                                        |
| --------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Cycles completed this month | Big number + sparkline                                                               | `COUNT(RoundRobinCycle WHERE completedAt NOT NULL)` |
| Current cycle progress      | Segmented ring — filled per rep who's received one                                   | `RepMonthlyStat.cycleUps > 0 / eligible count`      |
| Total ups distributed       | Big number + MoM delta                                                               | `RoundRobinCycle.leadCount` sum                     |
| **Ups per rep**             | Horizontal bar, sorted DESC, with a dashed "fair share" line at `total/eligibleDays` | `RepMonthlyStat.totalUps`                           |
| **Ups entered per BDC**     | Stacked bar by day, one series per BDC agent                                         | `Lead GROUP BY bdcUserId, createdLocalDate`         |
| **DQ count this month**     | Big number + per-rep breakdown table                                                 | `RepMonthlyStat.dqCount`                            |
| **Conversion funnel**       | Assigned → Contacted → Appt Set → Shown → Sold                                       | `Lead.status` transitions                           |
| **Closing rate per rep**    | Scatter: ups received (x) vs. close % (y), bubble = units                            | `RepMonthlyStat.sold / totalUps`                    |
| Distribution fairness       | Gini coefficient / max-min spread, green ≤ 2 ups                                     | derived                                             |
| Source mix                  | Donut by `LeadSource`                                                                | `Lead GROUP BY source`                              |
| Override rate               | % of leads with `MANUAL_OVERRIDE` — a governance smell                               | `Lead.assignmentMode`                               |

Charts: **Recharts** (composable, good enough, tiny bundle). Every widget accepts `{month, team, repIds}` from a shared `<FilterBar>` in URL state (`nuqs`) so views are shareable links. Every number is **click-through to the underlying lead list** — a metric you can't drill into is a metric nobody trusts.

**Equity guard:** display close-rate _alongside_ ups received. A rep with 8 ups and a 50% close looks better than one with 20 ups at 25%, and management should see both before drawing conclusions from either.

### 6.2 Calendar View (`/calendar`)

Two modes off the same endpoint:

**A. Roster heatmap (month × rep grid)** — the primary management view.

```
            1  2  3  4  5  6  7  8  9 10 11 12 13 14 ...
M. Reyes    ● ● ○ ● ● ● ✕ ● ● ● ● ● ○ ●     ● = worked & qualified
J. Okafor   ● ● ● ○ ● ⚑ ✕ ● ● ● ○ ● ● ●     ○ = scheduled off / PTO
D. Fisher   ● ✕ ✕ ● ○ ● ✕ ⚑ ● ● ● ● ○ ●     ✕ = DISQUALIFIED
T. Nguyen   ● ● ● ● ● ● ✕ ● ⚑ ● ● ● ● ●     ⚑ = manager override active
                                             ▪ = store closed
```

Cell tint encodes ups received (0 = pale → 6+ = saturated), so volume and status are legible in one pass. Hover → popover: `4 ups · 47 calls · 12 notes · Qualified (needed 40/20)`. Click → day drawer with that rep's leads and activity timeline.

**B. Single-rep month calendar** — traditional grid, one rep, per-day ups + calls + notes + DQ badge + shift times. This is the artifact a manager opens in a one-on-one.

Implementation: CSS Grid + `RepDailyStat` (already denormalized — one indexed query per month). Sticky first column, virtualized rows past 40 reps. Drag-paint on the schedule tab does a batched `PUT /schedule/bulk` (single transaction, one audit event with a diff summary).

---

## 7. Management Oversight Tools

- **Override toggle** on every roster row (perm-gated). Opens a compact sheet: `Force Active / Force Inactive / Follow Schedule` + **required reason** (free text or preset chips: "Covering for X", "Sent home", "Training", "Reactivated — proof provided"). Writes `AuditEvent`. The roster row then permanently shows `⚑ Forced off — "sent home" · K. Diaz 1:12p` so no override is anonymous.
- **Reactivation queue** — split pane: system-recorded activity (calls/notes with timestamps) on the left, rep's submitted evidence on the right. `Approve` / `Deny` + note. Bulk approve for a batch of screenshots after a CRM outage.
- **Audit log** — filterable append-only stream. Every override, reassignment, policy change, and DQ decision, with before/after JSON diffs. Exportable to CSV.
- **Policy editor** — sliders/inputs for `minCalls`, `minNotesTotal`, `notesPerAssignedLead`, `noteMinChars`, grace hours, per-team scoping. **Includes a dry-run simulator:** "Under this policy, last 30 days would have produced 47 DQs instead of 19 — affecting these 9 reps." Prevents management from accidentally disqualifying the whole floor.
- **Fairness alert** — if any two eligible reps diverge by >3 ups in a cycle, or override rate exceeds 15%, surface a banner on `/metrics` with a link to the cause.
- **Board mode** (`/board?tv=1`) — dark, large-type, auto-refreshing floor display of next-up + on-deck order. Fixes the social problem: reps stop crowding the BDC desk to ask where they are in line.

---

## 8. Cross-Cutting Concerns

**Auth & tenancy.** Cookie session (httpOnly, SameSite=Lax) w/ short-lived JWT for the socket handshake. Every Prisma query flows through a `withTenant(dealershipId)` helper; Postgres **row-level security** as defense-in-depth so a missing `where` clause can't leak across dealerships. Argon2id password hashing; TOTP optional for manager/admin roles.

**Time.** One rule: **all business-day logic uses the dealership's IANA timezone.** `date-fns-tz` on both ends. Never `new Date().toISOString().slice(0,10)`. A `clock(tz)` helper is the only sanctioned source of "today."

**Offline resilience.** The showroom Wi-Fi will drop. Service worker + IndexedDB queue lets the form accept up to 20 leads offline (`assignmentMode: PENDING_SYNC`, no rep shown), then flushes with idempotency keys on reconnect. A visible `⚠ Offline — 3 queued` banner sets expectations honestly.

**Accessibility.** Full keyboard operation, `aria-live="polite"` announcing "Assigned to Maria Reyes," status conveyed by icon+text not color alone, 4.5:1 contrast minimum, focus never lost after submit.

**Performance targets.** `POST /leads` p95 < 150ms. Entry screen TTI < 1.2s on dealership hardware (read: a 2016 Dell on Chrome). Route-level code splitting — metrics/charts never load on the entry route. Roster virtualized past 40 rows.

**Testing.**

- _Unit:_ `rankCandidates`, `resolveState`, `isCycleComplete`, `evaluateRepForDate`, `findPreviousWorkingDay` — pure functions, exhaustive table-driven cases.
- _Property-based (fast-check):_ over 10,000 random assignment sequences, assert **max(totalUps) − min(totalUps) ≤ 1 for continuously-eligible reps**. This is the invariant that makes the round-robin defensible to a floor of commissioned salespeople.
- _Integration:_ Testcontainers Postgres. Fire 50 concurrent `POST /leads` → assert 50 distinct assignments, correct cycle count, zero double-assignment.
- _E2E (Playwright):_ two browser contexts on `/entry`, simultaneous submits, assert both boards converge to identical state.
- _Simulation harness:_ CLI that fast-forwards a synthetic month (schedules, activity, DQs, sales) to populate demo data and sanity-check metrics — also the sales-demo dataset.

**Ops.** Docker Compose → Fly.io/Render (API + worker as separate processes). Prisma Migrate. Pino → structured logs with `dealershipId` + `requestId`. OpenTelemetry traces on the assignment transaction. Sentry front and back. Nightly `pg_dump`; `AuditEvent` and `Lead` are never hard-deleted.

---

## 9. Phased Delivery

| Phase                         | Scope                                                                                                                        | Why this order                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **1 — Core loop (2–3 wk)**    | Auth, roster CRUD, entry screen, atomic round-robin, next-up highlight, copy-to-clipboard, manual override toggle, audit log | Ships the thing that replaces the whiteboard. Immediately useful with zero accountability rules.     |
| **2 — Schedule (1–2 wk)**     | Shift model, templates, materialization job, calendar grid, drag-paint editing, auto-deactivation on days off                | Removes the daily manual toggling that would otherwise cause abandonment.                            |
| **3 — Accountability (2 wk)** | Activity logging UI, policy editor + dry-run simulator, nightly evaluation, DQ badges w/ reasons, notifications              | Rules land _after_ trust in the distribution engine is established — sequencing matters politically. |
| **4 — Reactivation (1 wk)**   | Request form, evidence upload, manager review queue, pattern flags                                                           |                                                                                                      |
| **5 — Analytics (2 wk)**      | Rollups, metrics dashboard, cycle/fairness widgets, conversion funnel, calendar heatmap, CSV export                          |                                                                                                      |
| **6 — Polish (ongoing)**      | Realtime presence/collision, offline queue, TV board mode, mobile rep view, CRM adapter interface                            | Mobile rep view ("where am I in line?") is the highest-value item here.                              |

---

## 10. Edge Cases to Decide Before Coding

1. **Zero eligible reps** (everyone DQ'd or off). Current design: `HOUSE` assignment + manager alert. Alternative: temporarily un-DQ the rep with the smallest shortfall. **Recommend HOUSE + loud alert** — silently overriding your own rules destroys the system's credibility.
2. **Customer asks for a specific rep.** `AssignmentMode.REQUESTED_REP` — counts toward `totalUps` (so it affects future position) but does **not** consume a `cycleUps` slot. Requires a permission and a reason.
3. **Duplicate/repeat callers.** Dupe check surfaces prior assignment; a repeat within N days should route to the _original_ rep and count as `REQUESTED_REP`-style, not a fresh round-robin up. Make `N` configurable (30/60/90).
4. **Mid-month new hire.** Starting at `totalUps = 0` means they'd absorb every up until they catch up. Seed `totalUps` to the current roster **median** at activation, flagged in `AuditEvent`.
5. **Bad leads.** `LeadStatus.DUPLICATE` / disconnected number → manager can void, which decrements `totalUps` and `cycleUps` and puts the rep back at the front. Audited, reason required.
6. **Half-day / split shifts.** Pro-rated thresholds (implemented above) and shift-window eligibility so a 4pm-start rep isn't in the 10am rotation.
7. **DST transitions.** Timezone-aware date math throughout; the nightly job runs on local cron, not a fixed UTC offset.
8. **Notes gaming.** `noteMinChars` + duplicate-body detection (hash consecutive notes per rep/day) + optional per-lead distinctness. Surface a "low-quality notes" flag to managers rather than auto-failing — humans should judge quality.

---

### The one thing to get right

The **atomic assignment transaction** (§3.3) is the load-bearing wall. If two BDC agents can ever get the same next-up, or if `assignmentReason` isn't recorded, the sales floor will stop trusting the board within a week and revert to the whiteboard — regardless of how good the metrics dashboard is. Build that transaction first, hammer it with the concurrency test, and everything else is incremental.
