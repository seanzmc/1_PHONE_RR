# PhoneUp — A Full-Stack Framework for Dealership Phone-Up Tracking & Round-Robin Assignment

_React 18 + TypeScript · Fastify + tRPC · PostgreSQL · Drizzle_

---

## 0. Executive Summary — The Decisions That Determine Success

Before the schemas and code, here are the six architectural positions that everything else follows from. If you disagree with these, disagree now, because they're load-bearing.

| #   | Decision                                                                                                                                                              | Why                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| 1   | **The assignment ledger is append-only and is the source of truth.** Monthly counters exist only as a projection written in the same transaction.                     | When a rep says _"I got screwed Tuesday, I should have had that up,"_ you must be able to replay the exact ordering, who was skipped, and why. Mutable counters cannot answer that question — and that question is 80% of the support load for a fairness system. Counters must be rebuildable from zero with a nightly drift alarm. |
| 2   | **"Next Up" is never stored. It is a derived, deterministic ordering, recomputed inside a lock at assignment time.**                                                  | Any stored pointer desynchronizes the instant someone is hired, disqualified, sent home, or overridden. The UI highlight is _advisory_; the transaction is _authoritative_.                                                                                                                                                          |
| 3   | **A single `pg_advisory_xact_lock` per (store, rotation group) serializes picks.**                                                                                    | At ~1,000–3,000 assignments/month, serializing costs ~1–2ms and makes the algorithm trivially correct. No `SKIP LOCKED` gymnastics, no SERIALIZABLE retry loops leaking into the client.                                                                                                                                             |
| 4   | **The algorithm reads `rep_daily_status`; everything else only writes it.** Schedule, eligibility job, manager override, reactivation — all write status.             | This turns every edge case (quit, day off, DQ, reactivation, override) into a status write instead of an algorithm branch. The hot path stays one indexed query forever.                                                                                                                                                             |
| 5   | **Ship auto-disqualification in SHADOW mode for the first 3 weeks.** Compute it, log it, email managers a nightly "who would have been cut" report — enforce nothing. | Your initial thresholds _will_ be wrong. A wrong threshold on day one permanently poisons adoption. Encode this as `enforcement_mode: 'SHADOW'                                                                                                                                                                                       | 'ENFORCE'` on the policy row. |
| 6   | **The eligibility job fails OPEN; the schedule import fails SAFE.**                                                                                                   | If the 5:30am worker dies, everyone is eligible and a human gets paged — a store that can't distribute phone ups can't sell cars. But a _missing schedule import_ must never silently mark everyone active: raise `CONFIGURATION_ERROR` and alert. Different inputs, opposite failure modes, both deliberate.                        |

**One thing to flag up front:** "calls made" is entirely self-reported inside this dashboard. Your store almost certainly already has a phone system producing CDRs. The disqualification engine — the most consequential feature here — currently rests on data a rep can fabricate faster than they can dial. Minimum note length is an enforceable _floor_, not fraud detection. I've left a REST seam for telephony reconciliation (§13) and I'd prioritize it right after MVP.

---

## 1. Domain Vocabulary

Precision here prevents schema rot later.

- **Phone Up** — an inbound sales call logged by a BDC agent. The atomic unit of distribution.
- **Rotation Group** — a named queue: `PHONE_UP`, `INTERNET`, `WALK_IN`, `COMMERCIAL`. Most stores rotate these _separately_. All counters, cycles, and eligibility are scoped per group. **This is the single most commonly missed structural requirement in dealership rotation systems** — build it in from day one even if you only use `PHONE_UP` at launch, because retrofitting it means touching every query.
- **Cycle** — a numbered round within a (store, rotation group, sales month). Cycle _N_ closes when every currently-eligible member has been **assigned** or **skipped** in cycle _N_. Closure is evaluated lazily at pick time, which makes it robust to eligibility churn.
- **Next Up** — the deterministic head of the eligible ordering. Derived, never persisted.
- **Sales Month** — _not necessarily_ the calendar month. Many stores close on the last business day or a manufacturer-defined date. Modeled as `fiscal_period`, defaulting to calendar month.
- **Business Date** — `(occurred_at AT TIME ZONE store.timezone)::date`. Every daily concept keys off this, never a UTC date.
- **Working Day (store)** — an open day per `store_hours`, minus `store_closures`.
- **Previous Working Day (rep-relative)** — greatest date `d < D` where `d` is a store working day **and** the rep was scheduled **and** employed. Rep-relative, not just "last day the store was open." You never disqualify a rep for a day they weren't there.
- **Disqualified** — ineligible to _receive_ leads today. It never means "cannot log activity." A cut rep must be able to work their pipeline and cure.
- **Skip** — a ledger event recording that an ineligible rep's turn passed. Carries a reason and a `charged` flag.

---

## 2. System Architecture

```
┌─────────────── Browser (BDC station / Rep / Manager) ────────────────┐
│  React 18 + TS strict · Vite · TanStack Query (all server state)     │
│  Zustand (form draft, hotkey scope, UI prefs — ~100 lines)           │
│  WebSocket client  ·  IndexedDB outbox (offline lead queue)          │
└────────┬─────────────────────────────────────────────────────────────┘
         │ HTTPS: tRPC  ·  WSS: /ws?store=…
┌────────▼──────────────────────────────────────────────────────────────┐
│ Fastify (stateless, 1–2 machines)                                     │
│  ├─ cookie sessions (Postgres-backed) → ctx.actor                     │
│  ├─ tRPC v11 router · Zod I/O · requirePerm() middleware              │
│  ├─ Domain services: assignment · eligibility · activity · reactivation│
│  ├─ Realtime hub: Redis pub/sub `store:{id}` → local socket rooms     │
│  └─ pino JSON logs + OpenTelemetry traces                             │
├───────────────────────────────────────────────────────────────────────┤
│ Jobs (node-cron in-process behind an isLeader advisory lock at MVP)   │
│  · eligibility.evaluateDay   (05:30 store-local + catch-up on boot)   │
│  · rollup.dailyFacts         (nightly)                                │
│  · reconcile.counters        (nightly, alerts on drift)               │
│  · notify.disqualification   (at open: SMS/email/dashboard)           │
├───────────────────────────────────────────────────────────────────────┤
│ PostgreSQL 16  (ledger · sessions · holds · audit · snapshots)        │
│ Redis (WS fan-out, rate limits, 60s metrics cache — NOT truth)        │
│ S3/R2 (reactivation evidence, private, presigned)                     │
└───────────────────────────────────────────────────────────────────────┘
```

### Stack choices and tradeoffs

| Layer    | Choice                                                                                            | Reasoning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend | React 18/19 + TS strict + Vite + TanStack Router                                                  | SPA is right for a dashboard lived in all day. No SSR needed — internal app, no SEO. Vite for instant HMR.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| API      | **Fastify + tRPC v11 + Zod**                                                                      | Fastify over Express for throughput and schema-first validation; over NestJS because ~40 endpoints don't justify the ceremony. tRPC gives end-to-end types with zero codegen in a monorepo — enormous for a small team. Tradeoff: TS-client lock-in. Mitigate by exposing **one plain REST route** (`POST /api/v1/telephony/activity`) as a deliberate seam for future phone-system integration.                                                                                                                                                                      |
| DB       | **PostgreSQL 16**                                                                                 | Advisory locks, partial indexes, exclusion constraints, `timestamptz`, `LISTEN/NOTIFY` — all load-bearing below.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ORM      | **Drizzle** over Prisma                                                                           | The critical path is a 5-CTE ranked window query with `pg_advisory_xact_lock` and `NULLS FIRST` ordering. Prisma's `$queryRaw` returns `unknown` and you Zod-parse it back — you've paid for an ORM and are still writing untyped SQL. Drizzle's `sql` template is type-annotatable, migrations are plain `.sql` you can hand-edit (essential for partial indexes and RLS), and there's no query-engine binary.                                                                                                                                                       |
| Realtime | **WebSockets (`ws`) + Redis pub/sub**                                                             | Honest tradeoff: SSE is genuinely simpler (free reconnect, `Last-Event-ID`, traverses every corporate proxy) and would suffice for the read side. I choose WS because you _will_ want presence ("Agent 2 is entering a lead") and manager pushes, and bolting WS on later means rewriting the client transport. If you want to ship faster, start with SSE + Postgres `LISTEN/NOTIFY` behind the same `realtime.publish()` interface — note `NOTIFY` caps at 8000 bytes, so payloads are `{topic, version}` and clients refetch, which is the correct pattern anyway. |
| Redis    | **Yes, but not for correctness**                                                                  | WS fan-out across instances, rate limiting, 60s metrics cache. Assignment correctness never touches it. If Redis dies, assignments still work and clients fall back to polling. At true v1 single-process scale you can swap it for an in-process EventEmitter behind the same interface.                                                                                                                                                                                                                                                                             |
| Jobs     | **node-cron in-process, guarded by `isLeader` advisory lock** at MVP; graduate to Graphile Worker | Avoids a second deployable for four jobs. Graphile Worker's killer feature when you need it: transactional enqueue — the job commits with the domain write, so you cannot lose a job.                                                                                                                                                                                                                                                                                                                                                                                 |
| Auth     | **Postgres-backed sessions, httpOnly SameSite=Lax cookies** + optional Google Workspace OIDC      | You must revoke a fired salesperson **instantly**. JWTs can't do that without a revocation list, at which point you have sessions with extra steps. TOTP required for `SALES_MANAGER` and above.                                                                                                                                                                                                                                                                                                                                                                      |
| Hosting  | Fly.io/Render/ECS, 1 region near the store, managed PG with PITR, S3/R2                           | Single-rooftop, single-timezone workload. Multi-region is pure downside (write latency, split brain). This app tolerates 30s of downtime.                                                                                                                                                                                                                                                                                                                                                                                                                             |

### Monorepo layout

```
apps/web        Vite React SPA
apps/api        Fastify + tRPC
packages/db     Drizzle schema + migrations + seed
packages/core   PURE domain logic: ranking, workday math, eligibility rules — zero I/O imports
packages/contracts  Zod schemas, permission constants, shared types
packages/ui     design system
```

`packages/core` importing nothing with I/O is what makes the ranking algorithm property-testable in milliseconds. Guard it with an ESLint boundary rule.

---

## 3. Data Model

### 3.1 Why hybrid persistence (ledger + counters)

**Verdict: both, and it isn't a compromise — each half does a job the other can't.**

- **`assignment_events`** is append-only and immutable. It's the legal record. It answers "why wasn't I next?", enables undo, and makes as-of queries possible.
- **`rep_month_counters`** is a projection written in the _same transaction_, existing purely so the pick query is an index lookup instead of a month-wide aggregate. It is disposable: `rebuildCounters(store, period)` reconstructs it from the ledger, and a nightly job asserts `projection == fold(ledger)` and **alerts on drift**.

Why not pure event sourcing? You'd fold ~2,000 events on every pick and every page render, and "eligibility today" is genuinely a _snapshot_ concept that doesn't want to be derived. Why not pure counters? You can never undo correctly, you can't audit, and one bad `UPDATE` silently corrupts fairness with no way to detect it.

### 3.2 Core DDL

Raw DDL where it matters, because generated columns, partial uniques, exclusion constraints, and rules don't survive ORM DSLs. Drizzle definitions mirror these 1:1 (sample in §3.6).

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- fiscal period overlap exclusion
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- customer name search
CREATE EXTENSION IF NOT EXISTS citext;

-- ══════════════════ Tenancy, calendar, people ══════════════════

CREATE TABLE store (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  timezone        text NOT NULL,                    -- IANA, e.g. 'America/Chicago'. NEVER an offset.
  rotation_salt   text NOT NULL DEFAULT encode(gen_random_bytes(8),'hex'),
  settings        jsonb NOT NULL DEFAULT '{}',      -- typed via Zod, §3.5
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE store_hours (                           -- 0 = Sunday
  store_id      uuid NOT NULL REFERENCES store(id),
  day_of_week   smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  is_closed     boolean NOT NULL DEFAULT false,
  opens_at      time,
  closes_at     time,
  PRIMARY KEY (store_id, day_of_week),
  CHECK (is_closed OR (opens_at IS NOT NULL AND closes_at IS NOT NULL))
);

CREATE TABLE store_closure (                         -- holidays, inventory days, hurricanes
  store_id      uuid NOT NULL REFERENCES store(id),
  business_date date NOT NULL,
  reason        text NOT NULL,
  PRIMARY KEY (store_id, business_date)
);

-- The "sales month" is not always the calendar month.
CREATE TABLE fiscal_period (
  store_id   uuid NOT NULL REFERENCES store(id),
  period_key text NOT NULL,            -- '2026-07'
  starts_on  date NOT NULL,
  ends_on    date NOT NULL,
  PRIMARY KEY (store_id, period_key),
  CHECK (ends_on >= starts_on)
);
ALTER TABLE fiscal_period ADD CONSTRAINT fiscal_period_no_overlap
  EXCLUDE USING gist (store_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&);

CREATE TYPE app_role AS ENUM
  ('BDC_AGENT','BDC_MANAGER','SALES_REP','SALES_MANAGER','GM','ADMIN');

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  full_name     text NOT NULL,
  password_hash text,                  -- null when OIDC-only
  totp_secret   bytea,                 -- required for SALES_MANAGER+
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Roles scoped per rooftop: a user can be SALES_MANAGER at one store, GM at the group.
CREATE TABLE user_store_role (
  user_id  uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  role     app_role NOT NULL,
  PRIMARY KEY (user_id, store_id, role)
);

CREATE TYPE rotation_group AS ENUM ('PHONE_UP','INTERNET','WALK_IN','COMMERCIAL');

CREATE TABLE sales_rep (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id         uuid NOT NULL REFERENCES store(id),
  user_id          uuid UNIQUE REFERENCES app_user(id),   -- null = house/pseudo rep
  display_name     text NOT NULL,
  employee_no      text,
  hired_on         date NOT NULL,
  terminated_on    date,
  rotation_groups  rotation_group[] NOT NULL DEFAULT '{PHONE_UP}',
  -- 0.5 = part-time. Divides the load key so part-timers get proportionally fewer ups
  -- instead of vacuuming leads all month.
  weight           numeric(4,2) NOT NULL DEFAULT 1.00 CHECK (weight > 0 AND weight <= 3),
  is_house_account boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (terminated_on IS NULL OR terminated_on >= hired_on)
);
CREATE INDEX ON sales_rep (store_id) WHERE terminated_on IS NULL;

-- ══════════════════ Scheduling ══════════════════

CREATE TYPE shift_kind AS ENUM
  ('WORK','OFF','PTO','SICK','TRAINING','BEREAVEMENT','SUSPENDED');

CREATE TABLE rep_shift (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      uuid NOT NULL REFERENCES store(id),
  rep_id        uuid NOT NULL REFERENCES sales_rep(id),
  business_date date NOT NULL,                    -- store-local
  kind          shift_kind NOT NULL,
  starts_at     time,                             -- null for full-day OFF/PTO
  ends_at       time,
  source        text NOT NULL DEFAULT 'MANUAL',   -- MANUAL | IMPORT_CSV | RECURRING
  note          text,
  created_by    uuid REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rep_id, business_date)
);
CREATE INDEX ON rep_shift (store_id, business_date);
```

### 3.3 Eligibility: snapshots, live status, policy

**Why a snapshot table and not a view.** Eligibility is decided once at open and then _held_:

1. **It must be explainable.** "Why am I out today?" must be answered with the exact numbers the system saw — not a recomputation against data that has since changed (including activity logged _after_ being cut).
2. **It must be stable within the day.** A view would let a rep log 9 calls at 10:15am and silently re-qualify, defeating the "remainder of the current day" requirement entirely.
3. **It must be overridable** with an audit trail.

```sql
CREATE TABLE work_requirement_policy (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id                 uuid NOT NULL REFERENCES store(id),
  rotation_group           rotation_group,       -- null = all
  effective_from           date NOT NULL,
  -- Volume floor. required_calls = max(min_calls, ceil(calls_per_lead × leads_received)).
  -- A rep who got one lead yesterday should not owe the same 20 calls as one who got eight,
  -- or you punish reps for the BDC's slow day. Keep min_calls low (8–12), lean on the ratio.
  min_calls                integer NOT NULL DEFAULT 10,
  calls_per_lead           numeric(4,2) NOT NULL DEFAULT 2.0,
  count_only_connected     boolean NOT NULL DEFAULT false,
  -- Note quality
  min_notes                integer NOT NULL DEFAULT 6,
  min_note_chars           integer NOT NULL DEFAULT 40,
  require_note_per_lead    boolean NOT NULL DEFAULT true,
  reject_duplicate_notes   boolean NOT NULL DEFAULT true,
  -- Fairness guards
  min_shift_hours          numeric(4,2) NOT NULL DEFAULT 4.0,
  grace_days_after_hire    integer NOT NULL DEFAULT 14,
  grace_after_absence_days integer NOT NULL DEFAULT 3,  -- back from vacation → no cut day 1
  max_prior_workday_age    integer NOT NULL DEFAULT 7,  -- don't reach back past a week of PTO
  max_backdate_minutes     integer NOT NULL DEFAULT 720,
  enforcement_mode         text NOT NULL DEFAULT 'SHADOW'
                             CHECK (enforcement_mode IN ('SHADOW','ENFORCE')),
  created_by               uuid REFERENCES app_user(id),
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE eligibility_status AS ENUM
  ('ELIGIBLE','DISQUALIFIED','REACTIVATED','OFF_SCHEDULE',
   'STORE_CLOSED','INACTIVE','TERMINATED','NOT_HIRED_YET','MANAGER_HOLD');

-- Immutable evaluation record. Corrections are NEW versions, never UPDATEs.
CREATE TABLE eligibility_snapshot (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id            uuid NOT NULL REFERENCES store(id),
  rep_id              uuid NOT NULL REFERENCES sales_rep(id),
  business_date       date NOT NULL,          -- the day being QUALIFIED
  version             integer NOT NULL DEFAULT 1,
  evaluated_from_date date,                   -- resolved previous working day
  computed_status     eligibility_status NOT NULL,
  computed_reason     text NOT NULL,          -- human sentence, shown verbatim in the UI
  -- Thresholds snapshotted so a later policy change never rewrites history
  policy_id           uuid REFERENCES work_requirement_policy(id),
  required_calls      integer NOT NULL,
  required_notes      integer NOT NULL,
  calls_found         integer NOT NULL,
  notes_found         integer NOT NULL,
  metrics             jsonb NOT NULL DEFAULT '{}',
    -- { leads_received, leads_without_note:[uuid], rejected_notes:[{id,reason}],
    --   grace_reason, shadow_mode:true }
  evaluator           text NOT NULL,          -- JOB | CATCHUP | MANAGER_REEVALUATION
  evaluator_version   text NOT NULL,          -- git sha of the rules → reproducibility
  computed_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rep_id, business_date, version)
);
CREATE INDEX ON eligibility_snapshot (store_id, business_date);

-- The ONE table the algorithm reads. Everything else writes it.
CREATE TABLE rep_daily_status (
  store_id        uuid NOT NULL REFERENCES store(id),
  rep_id          uuid NOT NULL REFERENCES sales_rep(id),
  business_date   date NOT NULL,
  status          eligibility_status NOT NULL,
  reason          text NOT NULL,
  snapshot_id     uuid REFERENCES eligibility_snapshot(id),
  decided_by      text NOT NULL CHECK (decided_by IN ('system','schedule','manager')),
  decided_by_user uuid REFERENCES app_user(id),
  daily_cap       integer,                    -- null = uncapped; partial reactivation remedy
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rep_id, business_date)
);
-- Hot path: today's candidate pool
CREATE INDEX rds_available ON rep_daily_status (store_id, business_date, rep_id)
  WHERE status IN ('ELIGIBLE','REACTIVATED');

-- Append-only override log. Overrides are events, not column edits.
CREATE TABLE status_override (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      uuid NOT NULL REFERENCES store(id),
  rep_id        uuid NOT NULL REFERENCES sales_rep(id),
  business_date date NOT NULL,
  from_status   eligibility_status,
  to_status     eligibility_status NOT NULL,
  reason_code   text NOT NULL,                 -- structured, enforced at API level
  reason_note   text NOT NULL,
  granted_cap   integer,
  created_by    uuid NOT NULL REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

### 3.4 Leads, activity, ledger, cycles

PII is isolated in `customer` so a deletion request can scrub a person **without** destroying the fairness ledger.

```sql
CREATE TABLE customer (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      uuid NOT NULL REFERENCES store(id),
  full_name     text,
  phone_e164    text,
  phone_digits  text GENERATED ALWAYS AS
                  (regexp_replace(coalesce(phone_e164,''),'\D','','g')) STORED,
  email         citext,
  do_not_call   boolean NOT NULL DEFAULT false,
  sms_consent_at timestamptz,                  -- TCPA
  redacted_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cust_phone_idx ON customer (store_id, phone_e164) WHERE redacted_at IS NULL;
CREATE INDEX cust_name_trgm ON customer USING gin (full_name gin_trgm_ops);

CREATE TABLE lead_source (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id   uuid NOT NULL REFERENCES store(id),
  label      text NOT NULL,        -- 'Cars.com', 'Google', 'Repeat', 'Service Drive'
  short_key  text NOT NULL,        -- typeahead shortcut: 'cc', 'g', 'rep'
  hotkey_slot smallint,            -- 1..9 → Alt+N
  sort_order integer NOT NULL DEFAULT 100,
  is_active  boolean NOT NULL DEFAULT true,
  UNIQUE (store_id, short_key)
);

CREATE TYPE lead_status AS ENUM
  ('NEW','WORKING','APPOINTMENT_SET','APPOINTMENT_SHOWN','SOLD','LOST',
   'NO_SHOW','DUPLICATE','VOIDED');

CREATE TABLE lead (
  id               uuid PRIMARY KEY,             -- UUIDv7 minted client-side
  store_id         uuid NOT NULL REFERENCES store(id),
  rotation_group   rotation_group NOT NULL DEFAULT 'PHONE_UP',
  customer_id      uuid NOT NULL REFERENCES customer(id),
  assigned_rep_id  uuid REFERENCES sales_rep(id),  -- projection of the ledger
  created_by       uuid NOT NULL REFERENCES app_user(id),   -- the BDC agent
  source_id        uuid NOT NULL REFERENCES lead_source(id),
  vehicle_raw      text,                          -- exactly what the agent typed
  vehicle_year     smallint,
  vehicle_make     text,
  vehicle_model    text,
  stock_number     text,
  intake_notes     text,
  status           lead_status NOT NULL DEFAULT 'NEW',
  duplicate_of_id  uuid REFERENCES lead(id),
  first_touch_at   timestamptz,                   -- speed-to-lead metric
  sold_at          timestamptz,
  sold_rep_id      uuid REFERENCES sales_rep(id), -- attribution frozen at sale time
  deal_number      text,
  gross_cents      integer,
  lost_reason      text,
  period_key       text NOT NULL,                 -- denormalized fiscal month
  business_date    date NOT NULL,                 -- denormalized store-local date
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON lead (store_id, business_date);
CREATE INDEX ON lead (assigned_rep_id, status);
CREATE INDEX ON lead (store_id, period_key) WHERE status = 'SOLD';

CREATE TYPE activity_kind AS ENUM (
  'CALL_ATTEMPT','CALL_CONNECTED','TEXT_SENT','EMAIL_SENT','NOTE',
  'APPOINTMENT_SET','APPOINTMENT_CONFIRMED','APPOINTMENT_SHOWN',
  'APPOINTMENT_NO_SHOW','SOLD','LOST'
);

CREATE TABLE lead_activity (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id       uuid NOT NULL REFERENCES store(id),
  lead_id        uuid REFERENCES lead(id),        -- nullable: prospecting w/o a lead
  rep_id         uuid NOT NULL REFERENCES sales_rep(id),
  kind           activity_kind NOT NULL,
  note_body      text,
  note_len       integer GENERATED ALWAYS AS (length(coalesce(note_body,''))) STORED,
  note_hash      bytea,                           -- sha256(normalized) → template detection
  duration_sec   integer,
  occurred_at    timestamptz NOT NULL,            -- server-clamped to max_backdate_minutes
  logged_at      timestamptz NOT NULL DEFAULT now(),
  -- Burst/backdate detection material:
  log_delay_sec  integer GENERATED ALWAYS AS
                   (EXTRACT(epoch FROM (logged_at - occurred_at))::int) STORED,
  business_date  date NOT NULL,                   -- of occurred_at, store tz
  entry_source   text NOT NULL DEFAULT 'WEB',     -- WEB | MOBILE | CSV_IMPORT | TELEPHONY
  created_by     uuid NOT NULL REFERENCES app_user(id),
  idempotency_key uuid
);
CREATE INDEX act_elig_idx ON lead_activity (rep_id, business_date, kind);
CREATE INDEX act_lead_idx ON lead_activity (lead_id, occurred_at DESC);
CREATE INDEX act_hash_idx ON lead_activity (rep_id, note_hash) WHERE note_hash IS NOT NULL;
CREATE UNIQUE INDEX act_idem_idx ON lead_activity (store_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ══════════════════ THE LEDGER ══════════════════

CREATE TYPE ledger_event AS ENUM (
  'ASSIGN',          -- rep received a lead
  'SKIP',            -- rep's turn passed (ineligible)
  'VOID',            -- an ASSIGN reversed (BDC error, spam, duplicate)
  'REASSIGN_OUT',    -- lead moved away
  'REASSIGN_IN',     -- lead moved to
  'BALANCE_CREDIT'   -- synthetic ups normalizing a mid-month hire
);

CREATE TYPE assignment_reason AS ENUM (
  'ROUND_ROBIN','CUSTOMER_REQUEST','PRIOR_CUSTOMER','MANAGER_OVERRIDE',
  'REASSIGNMENT','HOUSE_ACCOUNT','UNASSIGNED_QUEUE_DRAIN'
);

CREATE TYPE skip_reason AS ENUM (
  'DISQUALIFIED','SCHEDULED_OFF','PTO','SICK','TRAINING','INACTIVE',
  'TERMINATED','DAILY_CAP_REACHED','MANAGER_HOLD','MONTH_END_CLOSE'
);

CREATE TABLE assignment_events (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id           uuid NOT NULL REFERENCES store(id),
  seq                bigint NOT NULL,               -- per-store monotonic, from rr_state
  rotation_group     rotation_group NOT NULL,
  period_key         text NOT NULL,
  cycle_no           integer NOT NULL,
  rep_id             uuid NOT NULL REFERENCES sales_rep(id),
  event_type         ledger_event NOT NULL,
  lead_id            uuid REFERENCES lead(id),
  bdc_agent_id       uuid REFERENCES app_user(id),
  assignment_reason  assignment_reason,
  skip_reason        skip_reason,
  -- Does this event consume the rep's turn in this cycle?
  consumes_turn      boolean NOT NULL DEFAULT true,
  -- Does it count against the rep in monthly ordering? (excused absence → false)
  charged_to_count   boolean NOT NULL DEFAULT true,
  -- ±1: separates "who owns the lead" from "who was charged a turn"
  credit_delta       smallint NOT NULL DEFAULT 0 CHECK (credit_delta BETWEEN -1 AND 1),
  queue_position     integer,
  queue_snapshot     jsonb,                         -- full ordered list w/ sort keys, ~40 rows
  supersedes_id      bigint REFERENCES assignment_events(id),
  reason_note        text,
  actor_user_id      uuid REFERENCES app_user(id),
  idempotency_key    uuid,
  business_date      date NOT NULL,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, seq),
  CHECK ((event_type = 'ASSIGN' AND assignment_reason IS NOT NULL AND lead_id IS NOT NULL)
      OR (event_type = 'SKIP'   AND skip_reason IS NOT NULL)
      OR (event_type NOT IN ('ASSIGN','SKIP')))
);

-- Hot path: "has this rep been consumed in this cycle?"
CREATE INDEX ae_cycle_idx ON assignment_events
  (store_id, rotation_group, period_key, cycle_no, rep_id) WHERE consumes_turn;
CREATE INDEX ae_period_idx ON assignment_events
  (store_id, rotation_group, period_key, rep_id, event_type);
CREATE INDEX ae_date_idx ON assignment_events (store_id, business_date);
CREATE INDEX ae_bdc_idx ON assignment_events (bdc_agent_id, period_key)
  WHERE event_type = 'ASSIGN';

-- Exactly-once under client retry / double-Enter / offline replay
CREATE UNIQUE INDEX ae_idem_idx ON assignment_events (store_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Append-only enforced at the DB, not by developer convention
CREATE RULE ae_no_update AS ON UPDATE TO assignment_events DO INSTEAD NOTHING;
CREATE RULE ae_no_delete AS ON DELETE TO assignment_events DO INSTEAD NOTHING;

-- Cycles as first-class rows: "cycles completed this month" becomes COUNT(*),
-- and you get per-cycle duration analytics for free.
CREATE TABLE rotation_cycle (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       uuid NOT NULL REFERENCES store(id),
  rotation_group rotation_group NOT NULL,
  period_key     text NOT NULL,
  cycle_no       integer NOT NULL,
  opened_at      timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz,
  member_count   integer,
  assign_count   integer NOT NULL DEFAULT 0,
  skip_count     integer NOT NULL DEFAULT 0,
  UNIQUE (store_id, rotation_group, period_key, cycle_no)
);
-- The invariant that keeps picks deterministic:
CREATE UNIQUE INDEX one_open_cycle ON rotation_cycle
  (store_id, rotation_group, period_key) WHERE closed_at IS NULL;

-- Which reps have been consumed in the current cycle. Derivable from the ledger,
-- materialized so the hot path is one indexed lookup.
CREATE TABLE rr_cycle_assignments (
  store_id       uuid NOT NULL,
  rotation_group rotation_group NOT NULL,
  period_key     text NOT NULL,
  cycle_no       integer NOT NULL,
  rep_id         uuid NOT NULL REFERENCES sales_rep(id),
  event_id       bigint NOT NULL,
  PRIMARY KEY (store_id, rotation_group, period_key, cycle_no, rep_id)
);

CREATE TABLE rr_state (
  store_id       uuid NOT NULL,
  rotation_group rotation_group NOT NULL,
  period_key     text NOT NULL,
  current_cycle  integer NOT NULL DEFAULT 1,
  last_seq       bigint NOT NULL DEFAULT 0,
  version        bigint NOT NULL DEFAULT 0,     -- OCC token broadcast to clients
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, rotation_group, period_key)
);

-- Projection. Rebuildable. Never the source of truth.
CREATE TABLE rep_month_counters (
  store_id          uuid NOT NULL,
  rotation_group    rotation_group NOT NULL,
  period_key        text NOT NULL,
  rep_id            uuid NOT NULL REFERENCES sales_rep(id),
  ups_mtd           integer NOT NULL DEFAULT 0,  -- net ASSIGN (minus VOID/REASSIGN_OUT)
  charged_skips_mtd integer NOT NULL DEFAULT 0,  -- unexcused skips
  credit_mtd        integer NOT NULL DEFAULT 0,  -- BALANCE_CREDIT (new-hire normalization)
  sales_mtd         integer NOT NULL DEFAULT 0,
  ups_today         integer NOT NULL DEFAULT 0,
  ups_today_date    date,
  last_assigned_at  timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, rotation_group, period_key, rep_id)
);

-- ══════════════════ Reactivation ══════════════════

CREATE TYPE reactivation_status AS ENUM
  ('PENDING','APPROVED','DENIED','WITHDRAWN','EXPIRED');

CREATE TABLE reactivation_request (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          uuid NOT NULL REFERENCES store(id),
  rep_id            uuid NOT NULL REFERENCES sales_rep(id),
  snapshot_id       uuid NOT NULL REFERENCES eligibility_snapshot(id),
  business_date     date NOT NULL,
  claim_text        text NOT NULL,
  claimed_calls     integer,
  claimed_notes     integer,
  status            reactivation_status NOT NULL DEFAULT 'PENDING',
  submitted_at      timestamptz NOT NULL DEFAULT now(),
  sla_due_at        timestamptz NOT NULL,          -- submitted + 60 min; drives the badge
  reviewed_by       uuid REFERENCES app_user(id),
  reviewed_at       timestamptz,
  decision_note     text,
  granted_daily_cap integer                        -- partial remedy: reactivate but capped
);
CREATE UNIQUE INDEX one_pending_reactivation
  ON reactivation_request (rep_id, business_date) WHERE status = 'PENDING';

CREATE TABLE reactivation_evidence (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES reactivation_request(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('SCREENSHOT','PASTED_TEXT','CSV','PDF')),
  storage_key text,                    -- S3/R2 key; null for PASTED_TEXT
  text_body   text,
  sha256      bytea NOT NULL,          -- dedupe: same screenshot reused across days
  mime_type   text,
  byte_size   integer,
  scan_status text NOT NULL DEFAULT 'PENDING'
                CHECK (scan_status IN ('PENDING','CLEAN','REJECTED','ERROR')),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((storage_key IS NOT NULL) <> (text_body IS NOT NULL))
);
CREATE INDEX evidence_hash_idx ON reactivation_evidence (sha256);

-- ══════════════════ Audit (tamper-evident) ══════════════════

CREATE TABLE audit_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id      uuid,
  actor_user_id uuid REFERENCES app_user(id),     -- null = system
  actor_role    app_role,
  action        text NOT NULL,   -- 'status.override','reactivation.approve','lead.reassign'
  entity_type   text NOT NULL,
  entity_id     text NOT NULL,
  before_state  jsonb,
  after_state   jsonb,
  reason_code   text,
  reason_note   text,
  request_id    text,
  ip            inet,
  user_agent    text,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  prev_hash     bytea,                             -- hash chain, sealed hourly
  row_hash      bytea
);
CREATE INDEX ON audit_events (store_id, occurred_at DESC);
CREATE INDEX ON audit_events (entity_type, entity_id, occurred_at DESC);
CREATE RULE audit_no_update AS ON UPDATE TO audit_events DO INSTEAD NOTHING;
CREATE RULE audit_no_delete AS ON DELETE TO audit_events DO INSTEAD NOTHING;

-- ══════════════════ Unassigned holding queue ══════════════════
-- A live phone-up must NEVER be dropped because nobody is eligible.
CREATE TABLE unassigned_queue (
  lead_id     uuid PRIMARY KEY REFERENCES lead(id),
  store_id    uuid NOT NULL,
  reason      text NOT NULL,          -- 'NO_ELIGIBLE_REPS'
  queued_at   timestamptz NOT NULL DEFAULT now(),
  drained_at  timestamptz
);

-- ══════════════════ Rollups ══════════════════
CREATE TABLE daily_facts (
  store_id      uuid NOT NULL,
  rep_id        uuid,                  -- null = store-level row
  business_date date NOT NULL,
  leads         integer NOT NULL DEFAULT 0,
  sales         integer NOT NULL DEFAULT 0,
  disqualified  integer NOT NULL DEFAULT 0,
  calls         integer NOT NULL DEFAULT 0,
  notes         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (store_id, business_date, rep_id)
);
```

### 3.5 A timezone landmine, stated explicitly

`business_date` **cannot** be a Postgres generated column. `timestamptz AT TIME ZONE 'America/Chicago'` is `STABLE`, not `IMMUTABLE` (the tz database can change), so Postgres rejects it in `GENERATED ... STORED`. Every developer will try. Therefore:

- `business_date` and `period_key` are always supplied by the application via **one** function, `businessDate(instant, tz)` in `packages/core`.
- A `BEFORE INSERT` trigger recomputes and `RAISE`s on mismatch. Belt and suspenders.
- Leave a comment on the column explaining why.

### 3.6 `store.settings`, typed via Zod

```ts
export const StoreSettings = z.object({
  assignMismatchPolicy: z
    .enum(["AUTO_ACCEPT", "CONFIRM"])
    .default("AUTO_ACCEPT"),
  undoWindowSeconds: z.number().int().default(900), // 15 min for BDC agents
  duplicateLookbackDays: z.number().int().default(90),
  leaderboardVisibility: z
    .enum(["ALL", "MANAGERS_ONLY", "SELF_ONLY"])
    .default("ALL"),
  requestedRepCountsTowardRotation: z.boolean().default(false),
  voidRestoresCyclePosition: z.boolean().default(true),
  chargeSkipsToMonthlyCount: z.boolean().default(true), // see §4, the windfall problem
  midMonthHireSeedStrategy: z.enum(["ZERO", "MEDIAN"]).default("MEDIAN"),
  soldAttributionWindowDays: z.number().int().default(60),
  disqualificationNotify: z
    .array(z.enum(["SMS", "EMAIL", "DASHBOARD"]))
    .default(["SMS", "DASHBOARD"]),
  overrideSecondApprovalAfterPerMonth: z.number().int().default(5),
});
```

### 3.7 Drizzle mirror (sample)

```ts
// packages/db/src/schema/ledger.ts
import {
  pgTable,
  uuid,
  integer,
  boolean,
  text,
  timestamp,
  date,
  jsonb,
  bigint,
  smallint,
  index,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const ledgerEvent = pgEnum("ledger_event", [
  "ASSIGN",
  "SKIP",
  "VOID",
  "REASSIGN_OUT",
  "REASSIGN_IN",
  "BALANCE_CREDIT",
]);
export const rotationGroup = pgEnum("rotation_group", [
  "PHONE_UP",
  "INTERNET",
  "WALK_IN",
  "COMMERCIAL",
]);

export const assignmentEvents = pgTable(
  "assignment_events",
  {
    id: bigint("id", { mode: "bigint" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    storeId: uuid("store_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    rotationGroup: rotationGroup("rotation_group").notNull(),
    periodKey: text("period_key").notNull(),
    cycleNo: integer("cycle_no").notNull(),
    repId: uuid("rep_id").notNull(),
    eventType: ledgerEvent("event_type").notNull(),
    leadId: uuid("lead_id"),
    bdcAgentId: uuid("bdc_agent_id"),
    consumesTurn: boolean("consumes_turn").notNull().default(true),
    chargedToCount: boolean("charged_to_count").notNull().default(true),
    creditDelta: smallint("credit_delta").notNull().default(0),
    queuePosition: integer("queue_position"),
    queueSnapshot: jsonb("queue_snapshot").$type<QueueSnapshot>(),
    idempotencyKey: uuid("idempotency_key"),
    businessDate: date("business_date").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ae_cycle_idx")
      .on(t.storeId, t.rotationGroup, t.periodKey, t.cycleNo, t.repId)
      .where(sql`consumes_turn`),
    uniqueIndex("ae_idem_idx")
      .on(t.storeId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
  ],
);
```

---

## 4. The Ranking Function — Pure, Testable, Zero I/O

The spec lives in one place, as pure code, so it can be property-tested in milliseconds.

```ts
// packages/core/src/ranking.ts
export interface QueueMember {
  repId: string;
  displayName: string;
  status: EligibilityStatus;
  statusReason: string;
  eligible: boolean;
  servedThisCycle: boolean; // ASSIGN or SKIP w/ consumes_turn in current cycle
  upsMtd: number;
  chargedSkipsMtd: number;
  creditMtd: number;
  weight: number; // 1.0 full-time, 0.5 half
  lastAssignedAt: Date | null;
  upsToday: number;
  dailyCap: number | null;
  rotationSeed: number;
}

/** Sort keys in strict precedence order. Total order guaranteed. */
export function sortKeys(m: QueueMember): readonly (number | string)[] {
  return [
    m.servedThisCycle ? 1 : 0, // 1
    (m.upsMtd + m.chargedSkipsMtd + m.creditMtd) / m.weight, // 2
    m.lastAssignedAt?.getTime() ?? 0, // 3
    m.rotationSeed, // 4
    m.repId, // 5
  ];
}
```

**Why each key, in order:**

1. **`servedThisCycle`** — literally the requirement: prioritize reps not yet assigned in the current cycle.
2. **Weighted monthly load** — "ascending order based on total phone ups for the month," extended two ways. `chargedSkipsMtd` means an _unexcused_ skip (disqualification) counts as if you took the up. This kills the perverse incentive where getting disqualified banks you a windfall: come back tomorrow with the lowest count and get flooded. **This is a policy choice** (`chargeSkipsToMonthlyCount`) and reasonable people disagree — the opposing view is that only positive distribution counts and a returning rep's low count _legitimately_ moves them earlier, capped by the one-turn-per-cycle rule. Decide this with management explicitly; do not let it be an accident of implementation. Dividing by `weight` puts a 0.5-FTE rep at load 4 after 2 ups, so they receive roughly half the volume.
3. **`lastAssignedAt` ASC NULLS FIRST** — longest-idle tiebreak; zero-ups reps go before everyone.
4. **`rotationSeed`** — the tiebreak most systems get wrong. If your final tiebreak is name or ID, then at 8:00am on the 1st of every month, when everyone is at load 0 with null last-assigned, **the same rep wins the first up every single month, forever.** Reps notice within two months and lose trust in the whole system. Derive a stable per-period pseudorandom: `hashtext(rep_id || period_key || store.rotation_salt) & 2147483647`. Fair over time, perfectly deterministic and reproducible within a month.
5. **`repId`** — guarantees a total order so `LIMIT 1` is stable and identical across replicas.

**Filters applied before ranking:** rotation-group membership, `status IN ('ELIGIBLE','REACTIVATED')`, employment window covers today, `upsToday < dailyCap`.

---

## 5. The Assignment Transaction

### 5.1 The ranked query

One query returns the **entire ordered list** — eligible and ineligible alike — so the UI renders the full staff list with reasons, and both the pick and the wrap check fall out of one result set.

```sql
-- queue.rankedMembers($1 store, $2 group, $3 period_key, $4 business_date, $5 cycle_no)
WITH members AS (
  SELECT r.id AS rep_id, r.display_name, r.weight,
         COALESCE(s.status, 'INACTIVE'::eligibility_status) AS status,
         COALESCE(s.reason, 'No eligibility record for today') AS status_reason,
         s.daily_cap
  FROM sales_rep r
  LEFT JOIN rep_daily_status s
         ON s.rep_id = r.id AND s.business_date = $4
  WHERE r.store_id = $1
    AND $2 = ANY(r.rotation_groups)
    AND r.hired_on <= $4
    AND (r.terminated_on IS NULL OR r.terminated_on >= $4)
    AND NOT r.is_house_account
),
served AS (
  SELECT rep_id FROM rr_cycle_assignments
  WHERE store_id = $1 AND rotation_group = $2
    AND period_key = $3 AND cycle_no = $5
),
ranked AS (
  SELECT m.*,
    (sv.rep_id IS NOT NULL)                       AS served_this_cycle,
    COALESCE(c.ups_mtd, 0)                        AS ups_mtd,
    COALESCE(c.charged_skips_mtd, 0)              AS charged_skips_mtd,
    COALESCE(c.credit_mtd, 0)                     AS credit_mtd,
    CASE WHEN c.ups_today_date = $4
         THEN COALESCE(c.ups_today, 0) ELSE 0 END AS ups_today,
    c.last_assigned_at,
    (COALESCE(c.ups_mtd,0) + COALESCE(c.charged_skips_mtd,0)
       + COALESCE(c.credit_mtd,0))::numeric / m.weight AS load,
    (hashtext(m.rep_id::text || $3 || d.rotation_salt) & 2147483647) AS rotation_seed,
    (m.status IN ('ELIGIBLE','REACTIVATED')
      AND (m.daily_cap IS NULL
           OR CASE WHEN c.ups_today_date = $4
                   THEN COALESCE(c.ups_today,0) ELSE 0 END < m.daily_cap)) AS eligible
  FROM members m
  CROSS JOIN store d
  LEFT JOIN served sv USING (rep_id)
  LEFT JOIN rep_month_counters c
         ON c.rep_id = m.rep_id AND c.store_id = $1
        AND c.rotation_group = $2 AND c.period_key = $3
  WHERE d.id = $1
)
SELECT *,
  ROW_NUMBER() OVER (ORDER BY
    served_this_cycle ASC,
    load              ASC,
    last_assigned_at  ASC NULLS FIRST,
    rotation_seed     ASC,
    rep_id            ASC
  ) AS queue_position
FROM ranked
ORDER BY
  eligible DESC,                    -- two-tier display: eligible queue, then everyone else
  served_this_cycle ASC, load ASC, last_assigned_at ASC NULLS FIRST,
  rotation_seed ASC, rep_id ASC;
```

`Next Up` = the first row with `eligible = true`.

### 5.2 Concurrency: one advisory lock, deliberately

`pg_advisory_xact_lock` keyed on `(store, rotation_group)`, taken at the top of the transaction, released automatically at commit or rollback.

Not `SERIALIZABLE`: it works, but pushes 40001 retry loops into the client and is harder to reason about for the next developer. Not `SKIP LOCKED`: there's no work-queue semantics here — there's exactly one correct answer and you need it computed against a stable snapshot. A `SELECT … FOR UPDATE` on the `rr_state` row is functionally equivalent; I prefer the advisory lock because it also covers the multi-row cycle bookkeeping without pretending one row is the mutex.

**Every path that can change the ordering takes the same lock**: assignment, void, reassign, status override, reactivation approval. That's the rule that keeps this correct.

### 5.3 The service

```ts
// apps/api/src/services/assignment.ts
export async function createAndAssignLead(
  input: CreateLeadInput,
  actor: Actor,
  idempotencyKey: string,
) {
  const result = await db.transaction(async (tx) => {
    // ── 0. Serialize every pick for this queue. ~1-2ms held. Free lunch at this scale.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${actor.storeId + ":" + input.rotationGroup}, 0))`);

    // ── 1. Idempotency short-circuit: exactly-once under retry / double-Enter / offline replay
    const prior = await findByIdempotencyKey(tx, actor.storeId, idempotencyKey);
    if (prior) return prior;

    // ── 2. Resolve calendar context ONCE inside the lock (month-rollover safety)
    const store = await getStore(tx, actor.storeId);
    const businessDate = businessDateFor(new Date(), store.timezone);
    const periodKey = await fiscalPeriodFor(tx, store, businessDate);

    // ── 3. Lazy, idempotent eligibility backstop: if the 05:30 job died, we do NOT
    //      silently use yesterday's snapshots.
    await ensureEligibilitySnapshots(tx, store, businessDate);

    // ── 4. Open cycle (locked)
    let cycle = await getOpenCycleForUpdate(
      tx,
      actor.storeId,
      input.rotationGroup,
      periodKey,
    );
    if (!cycle)
      cycle = await openCycle(
        tx,
        actor.storeId,
        input.rotationGroup,
        periodKey,
      );

    // ── 5. Rank inside the lock. Never trust a client-supplied or preview rep.
    const rows = await rankedMembers(tx, {
      storeId: actor.storeId,
      group: input.rotationGroup,
      periodKey,
      businessDate,
      cycleNo: cycle.cycle_no,
    });

    // ── 6. Emit SKIP events for ineligible members who haven't been consumed yet.
    //      This is what prevents cycle stalls AND records the reason for the calendar.
    for (const m of rows.filter((r) => !r.eligible && !r.served_this_cycle)) {
      await appendLedger(tx, {
        storeId: actor.storeId,
        group: input.rotationGroup,
        periodKey,
        cycleNo: cycle.cycle_no,
        repId: m.rep_id,
        eventType: "SKIP",
        skipReason: mapStatusToSkipReason(m.status),
        consumesTurn: true,
        chargedToCount:
          isUnexcused(m.status) && store.settings.chargeSkipsToMonthlyCount,
        creditDelta: 0,
        businessDate,
        actorUserId: actor.userId,
      });
      await consumeCycleSlot(tx, cycle, m.rep_id);
      if (isUnexcused(m.status))
        await bumpChargedSkips(tx, m.rep_id, periodKey);
    }

    // ── 7. Choose
    const forced = input.forcedRepId;
    let chosen = forced
      ? rows.find((r) => r.rep_id === forced)
      : rows.find((r) => r.eligible);

    if (forced) requireCapability(actor, "lead.assign.override");

    // ── 8. Nobody eligible → NEVER drop the lead
    if (!chosen) {
      const lead = await insertLead(
        tx,
        input,
        actor,
        businessDate,
        periodKey,
        null,
      );
      await tx.insert(unassignedQueue).values({
        leadId: lead.id,
        storeId: actor.storeId,
        reason: "NO_ELIGIBLE_REPS",
      });
      await notifyManagers(tx, actor.storeId, "NO_ELIGIBLE_REPS", lead.id);
      return { lead, assignedTo: null, warning: "NO_ELIGIBLE_REPS" as const };
    }

    // ── 9. Duplicate check: WARN, never block. A live call must not be gated on this.
    const dup = await findRecentLeadByPhone(
      tx,
      actor.storeId,
      input.phoneE164,
      store.settings.duplicateLookbackDays,
    );

    // ── 10. Write: lead, ledger, cycle slot, counters — one transaction
    const lead = await insertLead(
      tx,
      input,
      actor,
      businessDate,
      periodKey,
      chosen.rep_id,
    );
    const seq = await nextSeq(
      tx,
      actor.storeId,
      input.rotationGroup,
      periodKey,
    );

    const event = await appendLedger(tx, {
      storeId: actor.storeId,
      seq,
      group: input.rotationGroup,
      periodKey,
      cycleNo: cycle.cycle_no,
      repId: chosen.rep_id,
      leadId: lead.id,
      bdcAgentId: actor.userId,
      eventType: "ASSIGN",
      assignmentReason: forced ? input.forcedReason! : "ROUND_ROBIN",
      consumesTurn: forced
        ? store.settings.requestedRepCountsTowardRotation
        : true,
      chargedToCount: true,
      creditDelta: 1,
      queuePosition: chosen.queue_position,
      queueSnapshot: rows.map(compactSnapshotRow), // forensic replay, ~40 rows
      idempotencyKey,
      businessDate,
      actorUserId: actor.userId,
    });

    if (event.consumesTurn) await consumeCycleSlot(tx, cycle, chosen.rep_id);

    await tx.execute(sql`
      INSERT INTO rep_month_counters
        (store_id, rotation_group, period_key, rep_id, ups_mtd, ups_today, ups_today_date,
         last_assigned_at)
      VALUES (${actor.storeId}, ${input.rotationGroup}, ${periodKey}, ${chosen.rep_id},
              1, 1, ${businessDate}, now())
      ON CONFLICT (store_id, rotation_group, period_key, rep_id) DO UPDATE SET
        ups_mtd = rep_month_counters.ups_mtd + 1,
        ups_today = CASE WHEN rep_month_counters.ups_today_date = ${businessDate}
                         THEN rep_month_counters.ups_today + 1 ELSE 1 END,
        ups_today_date = ${businessDate},
        last_assigned_at = now(),
        updated_at = now()`);

    // ── 11. Cycle-completion detection: every currently-eligible member consumed?
    const [{ done }] = await tx.execute<{ done: boolean }>(sql`
      SELECT NOT EXISTS (
        SELECT 1 FROM rep_daily_status s
        JOIN sales_rep r ON r.id = s.rep_id
        WHERE s.store_id = ${actor.storeId}
          AND s.business_date = ${businessDate}
          AND s.status IN ('ELIGIBLE','REACTIVATED')
          AND ${input.rotationGroup} = ANY(r.rotation_groups)
          AND NOT EXISTS (
            SELECT 1 FROM rr_cycle_assignments a
            WHERE a.store_id = ${actor.storeId}
              AND a.rotation_group = ${input.rotationGroup}
              AND a.period_key = ${periodKey}
              AND a.cycle_no = ${cycle.cycle_no}
              AND a.rep_id = s.rep_id)
      ) AS done`);

    if (done) {
      await closeCycle(tx, cycle.id, rows.filter((r) => r.eligible).length);
      await openCycle(
        tx,
        actor.storeId,
        input.rotationGroup,
        periodKey,
        cycle.cycle_no + 1,
      );
      await appendAudit(tx, actor, "cycle.completed", {
        cycleNo: cycle.cycle_no,
      });
    }

    const version = await bumpVersion(
      tx,
      actor.storeId,
      input.rotationGroup,
      periodKey,
    );
    const nextUpPreview = await previewNextUp(tx /* … */);

    return {
      lead,
      assignedTo: chosen,
      cycleNo: cycle.cycle_no,
      cycleClosed: done,
      version,
      duplicateWarning: dup
        ? { leadId: dup.id, createdAt: dup.created_at }
        : null,
      nextUp: nextUpPreview,
    };
  });

  // Publish AFTER commit, never inside the transaction.
  await realtime.publish(actor.storeId, {
    type: "assignment.created",
    version: result.version,
    ...compact(result),
  });
  return result;
}
```

### 5.4 Two BDC agents submit simultaneously

Both screens show Alice.

1. Agent A takes the lock, ranks, assigns Alice, commits, releases.
2. Agent B was blocked (~2ms), now takes the lock, **re-ranks against the committed state**, and correctly assigns Bob.
3. Agent B's response says `assignedTo: Bob`.

**No optimistic guess of the assignee.** The UI cannot know the winner without the lock, so it does not pretend to. The form clears instantly on submit (optimistic _clearing_), an inline "Assigning…" state shows for ~100ms, and then the real rep appears with a non-blocking toast: _"Assigned to **Bob Chen** — board updated."_

**No reservation hold while typing.** Holds create stale locks and unfairness when a form is abandoned mid-call, and double-entry is _safe_ (two leads, dedupe later), not _corrupt_. I do recommend a purely cosmetic presence broadcast — "Agent 2 is entering a lead" — which reduces double-entry without any locking semantics.

For explicit manager force-assignments, accept `expectedVersion` and return `409 STALE_BOARD` if it no longer matches. For ordinary BDC entry, **assign anyway and report the truth** — a live phone call must never be blocked by a UI race.

### 5.5 Undo, void, reassign

Never delete history. Three distinct semantics:

| Operation                                                          | Ledger events                  | Credit                                                                                          | Cycle slot                                                                |
| ------------------------------------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Undo** (data-entry error, within `undoWindowSeconds`, BDC agent) | `VOID` w/ `supersedes_id`      | `credit_delta = -1`                                                                             | Restored (`voidRestoresCyclePosition`) — the rep re-enters the fresh pool |
| **Void later** (spam/test, manager only)                           | `VOID`                         | `credit_delta = -1` requires manager permission; default is that the opportunity _was_ received | Not restored                                                              |
| **Reassign** (genuine transfer)                                    | `REASSIGN_OUT` + `REASSIGN_IN` | Original rep **keeps** credit; recipient gets `credit_delta = 0`                                | Does not consume recipient's turn                                         |

Flag reassignments distinctly so they don't pollute organic round-robin fairness metrics. Everything requires a reason and writes `audit_events` in the same transaction.

---

## 6. Daily Eligibility Job

### 6.1 Definitions, stated precisely

- **Store working day**: `store_hours[dow].is_closed = false` AND no `store_closure` row.
- **Previous working day for date D**: `max(d < D)` where `d` is a store working day AND the rep was scheduled `WORK` AND employed AND met `min_shift_hours`. **Rep-relative.**
- **If the rep wasn't scheduled that day** → `exempt_not_scheduled`, status starts `ELIGIBLE`. You never disqualify someone for a day they weren't there. Exemption is per-day and recomputed daily; it does not carry forward.
- **Long absences**: the literal rule reaches back before a week of PTO. `max_prior_workday_age` (default 7 days) plus `grace_after_absence_days` handles this — a rep back from vacation isn't cut on day one for what they didn't do eight days ago. Make this an explicit, visible policy, not a buried code path.
- **Sufficient work**: `calls ≥ max(min_calls, ceil(calls_per_lead × leads_received))` AND `qualifying_notes ≥ min_notes`, where qualifying = `kind IN ('NOTE', …)` AND `note_len ≥ min_note_chars` AND (`reject_duplicate_notes` → distinct `note_hash`) AND (`require_note_per_lead` → every lead received has ≥1 note).

**Concessions worth stating out loud:** minimum note length is an enforceable floor, not fraud detection. `note_hash` catches copy-paste templates. `log_delay_sec` catches burst-backdating at 9pm. None of it verifies a call was actually placed. That requires phone-system CDRs (§13).

### 6.2 Precedence order

For today's status, first match wins:

1. Not employed / terminated → `TERMINATED`
2. Not yet hired → `NOT_HIRED_YET`
3. Store closed → `STORE_CLOSED`
4. Not scheduled / day off / PTO → `OFF_SCHEDULE`
5. Active manager override → the overridden status
6. Approved reactivation today → `REACTIVATED`
7. Prior-working-day targets missed **and** `enforcement_mode = 'ENFORCE'` → `DISQUALIFIED`
8. Otherwise → `ELIGIBLE`

In `SHADOW` mode, step 7 writes the snapshot with `metrics.shadow_mode = true` and falls through to `ELIGIBLE`. Managers get the nightly "who would have been cut" report. Nobody loses income while you calibrate.

### 6.3 The job

```ts
// Runs 05:30 store-local via node-cron with { timezone: store.timezone }.
// Idempotent. Also invoked lazily by ensureEligibilitySnapshots() and on boot catch-up.
export async function runEligibilityJob(storeId: string) {
  const store = await getStore(storeId);
  const today = businessDateFor(new Date(), store.timezone);
  const policy = await activePolicy(storeId, today);

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(
      hashtextextended(${"elig:" + storeId + ":" + today}, 0))`);

    const reps = await activeReps(tx, storeId, today);

    for (const rep of reps) {
      // Rep-relative previous working day, bounded by max_prior_workday_age
      const prev = await previousWorkingDay(
        tx,
        store,
        rep,
        today,
        policy.max_prior_workday_age,
      );

      const scoped = await scopeActivity(tx, rep.id, prev, policy);
      // → { calls, qualifyingNotes, leadsReceived, leadsWithoutNote, rejectedNotes }

      const requiredCalls = Math.max(
        policy.min_calls,
        Math.ceil(policy.calls_per_lead * (scoped?.leadsReceived ?? 0)),
      );

      const computed = decideStatus({
        rep,
        today,
        prev,
        scoped,
        policy,
        requiredCalls,
      });
      // pure function in packages/core — property-tested

      const snap = await tx
        .insert(eligibilitySnapshot)
        .values({
          storeId,
          repId: rep.id,
          businessDate: today,
          version: await nextSnapshotVersion(tx, rep.id, today),
          evaluatedFromDate: prev,
          computedStatus: computed.status,
          computedReason: computed.reason, // verbatim in the UI
          policyId: policy.id,
          requiredCalls,
          requiredNotes: policy.min_notes,
          callsFound: scoped?.calls ?? 0,
          notesFound: scoped?.qualifyingNotes ?? 0,
          metrics: {
            ...scoped,
            shadow_mode: policy.enforcement_mode === "SHADOW",
          },
          evaluator: "JOB",
          evaluatorVersion: GIT_SHA,
        })
        .returning();

      const effective =
        policy.enforcement_mode === "SHADOW" &&
        computed.status === "DISQUALIFIED"
          ? {
              status: "ELIGIBLE" as const,
              reason: "Shadow mode — would have been disqualified",
            }
          : computed;

      // DO NOTHING: an override already written for today wins.
      await tx
        .insert(repDailyStatus)
        .values({
          storeId,
          repId: rep.id,
          businessDate: today,
          status: effective.status,
          reason: effective.reason,
          snapshotId: snap[0].id,
          decidedBy: computed.decidedBy,
        })
        .onConflictDoNothing();
    }

    await tx.insert(auditEvents).values({
      storeId,
      actorUserId: null,
      action: "eligibility.evaluated",
      entityType: "store",
      entityId: storeId,
      afterState: {
        businessDate: today,
        repCount: reps.length,
        mode: policy.enforcement_mode,
      },
    });
  });

  await realtime.publish(storeId, { type: "dailyStatus.updated", date: today });
  await notifyDisqualifiedReps(storeId, today); // SMS + dashboard banner at open
}
```

**Fail-open backstop.** `ensureEligibilitySnapshots()` runs inside the assignment transaction. If today's snapshots are missing (worker died overnight), it runs the evaluation right there — so you never assign against stale eligibility. If evaluation _itself_ fails, everyone is `ELIGIBLE` and a page fires. A store that can't distribute phone ups can't sell cars.

**Fail-safe on missing schedule.** If `rep_shift` has no rows for today, that is a `CONFIGURATION_ERROR`, not "everyone works." Alert management, show a board banner. Optionally fall back to a recurring template — but only as an explicit, visible store setting.

### 6.4 Timezone rules

1. Store all instants as `timestamptz`; all app logic in UTC.
2. Convert to store-local **only** at boundaries: at write time (denormalize `business_date`, `period_key`) and when jobs decide "which day is it."
3. Store IANA names (`America/Chicago`), never fixed offsets. Postgres/ICU handle DST.
4. **Cron must fire on local wall-clock time** (`node-cron` `timezone` option), not a fixed UTC hour, or your 05:30 job drifts an hour twice a year. Alternative: a scheduler that wakes every minute and picks stores whose `next_run_at` has passed.
5. React formats via `Intl.DateTimeFormat` with the **store's** tz from context — never the browser's. A manager traveling shouldn't see shifted days.
6. DST is largely harmless here because days are buckets: a call logged during the ambiguous 1:30am hour is stored unambiguously in UTC. Test both transitions anyway.

---

## 7. Reactivation Workflow

1. Disqualified rep sees a persistent banner with **the exact snapshot numbers**: _"Out today. Tuesday: 11 of 18 calls, 3 of 6 notes. 2 leads had no note logged."_
2. They submit a `reactivation_request`: claim text, claimed counts, evidence (pasted CRM text and/or screenshots via short-lived presigned S3 upload).
3. Uploads are hashed (`sha256`) — resubmitting yesterday's screenshot is caught by the index. Malware scan gates reviewer access.
4. Managers see a review queue sorted by `sla_due_at` (submitted + 60 min) with an aging badge.
5. **Approval**, in one transaction that takes the assignment lock:
   - `reactivation_request.status = 'APPROVED'`
   - `status_override` row with mandatory `reason_code` + `reason_note`
   - `rep_daily_status.status = 'REACTIVATED'`, optional `granted_daily_cap` (partial remedy: back in, but capped at 2 ups today)
   - `audit_events` row
   - realtime publish → every board updates
6. **The original failed snapshot is never rewritten.** Approval affects _today only_. You cannot retro-fix yesterday and shouldn't try.
7. Rejection requires a reason. A manager **cannot approve their own** request.

Reactivation makes the rep eligible for the **next** cycle. If they were already terminally skipped in the current cycle, that cycle is not reopened.

**A PII caution the design must handle:** reactivation evidence is screenshots of a CRM, which contain _other customers'_ names, phones, and notes. That store becomes a secondary, uncontrolled PII repository. Therefore: redaction guidance in the upload UI, access restricted to reviewers, short retention (90 days default with a lifecycle rule), and **do not OCR it** unless you've accepted that you're making that PII searchable.

---

## 8. API Surface

tRPC v11 routers, every procedure wrapped in `authedProcedure.use(requirePerm(...))`. Complete for MVP+.

```
── Board / assignment ────────────────────────────────────────────────
board.roster              query   board.view      → full ranked list + version + today's status
board.nextUp              query   board.view      → advisory highlight only
leads.createAndAssign     mut     lead.assign     → { lead, assignedTo, version, duplicateWarning }
                                                    header: Idempotency-Key
leads.checkDuplicate      query   lead.assign     → debounced as-you-type soft check
leads.undo                mut     lead.void       → own lead < undoWindowSeconds
leads.void                mut     lead.void.any   → manager+
leads.reassign            mut     lead.reassign   → manager+, reason required
leads.updateStatus        mut     lead.disposition→ assigned rep or manager
leads.list                query   lead.view       → cursor pagination + filters
queue.drainUnassigned     mut     lead.assign     → assign held leads when someone qualifies

── Activity (the eligibility inputs) ─────────────────────────────────
activity.logCall          mut     activity.self
activity.logNote          mut     activity.self
activity.mine             query   activity.self
activity.forRep           query   activity.view.any → manager+

── Eligibility / status ──────────────────────────────────────────────
eligibility.today         query   board.view
eligibility.snapshot      query   activity.self | activity.view.any
eligibility.reevaluate    mut     rep.override    → new snapshot version, prior preserved
status.override           mut     rep.override    → { repId, date, status, reasonCode, reasonNote }

── Reactivation ──────────────────────────────────────────────────────
reactivation.submit       mut     reactivation.self
reactivation.presignUpload mut    reactivation.self
reactivation.queue        query   reactivation.review
reactivation.review       mut     reactivation.review  → approve/deny, no self-approval

── Schedule ──────────────────────────────────────────────────────────
schedule.range            query   schedule.view
schedule.setDay           mut     schedule.manage
schedule.import           mut     schedule.manage → CSV, dry-run + diff preview

── Metrics ───────────────────────────────────────────────────────────
metrics.live              query   metrics.view    → role-scoped (rep sees self)
metrics.reps              query   metrics.view
metrics.bdc               query   metrics.view
metrics.calendar          query   metrics.calendar → manager+
audit.search              query   audit.view

── REST seam (deliberate, non-tRPC) ──────────────────────────────────
POST /api/v1/telephony/activity     HMAC-signed  → future CDR ingestion
```

`board.nextUp` is read-only and **advisory**. The response includes `version` (the `rr_state.version` OCC token). Clients may send `expectedVersion`; the server fast-fails `409 STALE_BOARD` for manager force-assigns, but for ordinary BDC entry it **assigns anyway and reports the actual assignee**.

---

## 9. The BDC Screen — Keyboard-First

This screen pays for the whole system. **Budget: a complete lead in ≤12 keystrokes beyond the data itself, zero mouse.**

**Layout:** left 60% lead form, right 40% roster table always visible. The Next Up row is pinned to the top of the eligible section with a pulsing accent border, an icon, and the literal text "NEXT UP" — never color alone.

### Interaction contract

| Key                | Action                                                           |
| ------------------ | ---------------------------------------------------------------- |
| `F2` or `/`        | Focus new-lead form from anywhere                                |
| `Enter`            | **Advance** to next field (does not submit until the last field) |
| `Tab`              | Advance field                                                    |
| `Ctrl+Enter`       | Assign to Next Up, clear form, refocus Customer Name             |
| `Ctrl+Shift+Enter` | Open "assign to specific rep" picker (arrows + Enter)            |
| `Alt+1..9`         | Set source from the nine most common (`lead_source.hotkey_slot`) |
| `Alt+C`            | Copy the last-assigned phone number                              |
| `Esc`              | Clear form (dirty-guard confirm)                                 |

Hotkeys with no modifier (`/`) are suppressed while a text input has focus. All shortcuts are configurable — hard-coded single keys collide with screen-reader navigation.

### Phone input and clipboard

```ts
import { AsYouType, parsePhoneNumberFromString } from "libphonenumber-js";

function onPhoneChange(raw: string) {
  setDisplay(new AsYouType("US").input(raw)); // (512) 555-1234 as they type
  const parsed = parsePhoneNumberFromString(raw, "US");
  setE164(parsed?.number ?? null); // null → red ring, but never blocks submit
}

export async function copyPhone(value: string) {
  try {
    await navigator.clipboard.writeText(value); // requires HTTPS + user gesture
    announce("Phone number copied"); // aria-live="polite"
  } catch {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy"); // deprecated, universally available
    ta.remove();
    if (!ok)
      throw new Error("Clipboard unavailable — number shown for manual copy");
  }
}
```

**The actual CRM workflow, end to end.** After a successful assign, a **just-assigned card** appears for 5 seconds with a large `(512) 555-1234 ⎘` button **auto-focused**. The agent hits `Enter` and the number is on the clipboard, ready to paste into the external CRM. So the whole loop is: _type the lead → `Ctrl+Enter` → `Enter` → paste in CRM._ `Alt+C` recalls it afterward. That is what "quick copy to clipboard" has to mean in practice.

### Speed details that matter

- Notes are **optional at entry.** Never block a live phone call on a notes field.
- Source is a typeahead over `short_key` (`cc` → Cars.com), defaulting to the store's most common.
- All selects are `<select>`-backed comboboxes — native keyboard behavior for free.
- One real `<form>` with real `<label>`s → autofill, screen readers, and focus order come free.
- Duplicate check fires debounced at 400ms and renders an inline amber hint; it never gates submit.

### Resilience

The form draft lives in Zustand and is **untouched by inbound board events**. On network failure the draft plus its idempotency key go to an **IndexedDB outbox** and retry on reconnect — a store with flaky Wi-Fi must not lose an inbound customer. Because the idempotency key is minted client-side and unique-indexed server-side, replay is exactly-once.

### Accessibility

- Next Up announced via `aria-live="polite"` — _not_ `assertive`, which would interrupt typing.
- Status is always icon + text, not color alone; disqualified rows are striped. Deuteranopia-safe palette, contrast ≥ 4.5:1.
- The roster is a real `<table>` with `scope` attributes so screen readers navigate it as data, not a div soup.
- Visible focus rings, full keyboard operability, respect `prefers-reduced-motion`.
- Focus never moves while the user is typing.

---

## 10. React Component Tree & State

```
<App>
  <AuthGate>
   <StoreProvider>            // store tz, policy, current user + permission set
    <RealtimeProvider>        // WS lifecycle → dispatches into QueryClient
     <AppShell>
      /board → <BdcBoardPage>                          ← THE screen
        <BoardHeader> <ConnectionStatus/> <BusinessDate/> <LiveMetricStrip/> </BoardHeader>
        <NoEligibleRepsBanner/>  <UnassignedQueueBadge/>
        <BoardWorkspace>
          <LeadEntryPanel>                             // Zustand draft
            <LeadEntryForm>
              <CustomerNameField/>
              <PhoneField masked>  <DuplicateHint/> </PhoneField>
              <SourceTypeahead hotkeys/>
              <VehicleField/>  <NotesField optional/>
              <SubmitBar hotkeyHints/>
            </LeadEntryForm>
            <JustAssignedCard autoFocusCopy/>           // the CRM handoff
          </LeadEntryPanel>
          <RosterPanel>                                // TanStack Query, WS-patched
            <RosterTable>                              // plain <table>, <100 reps
              <RepRow nextUp status monthCount servedThisCycle scheduleBadge/>
            </RosterTable>
          </RosterPanel>
        </BoardWorkspace>
        <DuplicateDrawer/>

      /my-day → <RepHomePage>
        <DisqualificationBanner snapshotNumbers/>
        <ActivityComposer/>  <MyLeadQueue/>  <ReactivationForm/>

      /manage → <ManagerPage>
        <RosterStatusGrid overrideModal/>               // reason mandatory
        <ReactivationQueue slaBadges/>
        <MetricsDashboard/>
        <RepCalendar/>
        <OverrideAbuseReport/>

      /admin → <AdminPage>
        <PolicyEditor enforcementModeToggle/>  <ScheduleImport dryRun/>  <AuditSearch/>
```

**State discipline — no exceptions:**

- **TanStack Query owns all server state.** Roster, leads, metrics, calendar, snapshots. No server data in Zustand ever.
- **Zustand owns client-only state.** Form draft, hotkey scope, WS status, panel sizing, calendar filters. ~100 lines total.
- **No Redux.** It solves problems this app doesn't have and costs boilerplate that slows the team.
- One `EventSource`/WebSocket shared across browser tabs via `BroadcastChannel`, so five open tabs at a BDC station don't open five connections.

---

## 11. Real-Time Sync

Clients → WS → Node (socket rooms per `storeId`). On **commit** (never inside the transaction), services call `realtime.publish()` → Redis channel `store:{id}` → all instances fan out locally.

```ts
type ServerEvent =
  | {
      type: "assignment.created";
      version: number;
      repId: string;
      repName: string;
      leadId: string;
      cycleNo: number;
      cycleClosed: boolean;
    }
  | { type: "cycle.completed"; version: number; cycleNo: number }
  | {
      type: "dailyStatus.updated";
      version?: number;
      date: string;
      repId?: string;
    }
  | {
      type: "lead.voided" | "lead.reassigned";
      version: number;
      leadId: string;
      repId: string;
    }
  | { type: "metrics.invalidated"; scope: "dashboard" | "calendar" }
  | { type: "agent.drafting"; agentName: string }; // cosmetic presence

function useBoardSync(storeId: string) {
  const qc = useQueryClient();
  useWebSocket(`wss://api/ws?store=${storeId}`, {
    onMessage: (ev: ServerEvent) => {
      const cached = qc.getQueryData<BoardState>(["board.roster"]);

      // Gap detection: versions must be strictly sequential.
      if (ev.version && cached && ev.version !== cached.version + 1) {
        qc.invalidateQueries({ queryKey: ["board"] }); // refetch the snapshot
        return;
      }
      qc.setQueryData(["board.roster"], applyEvent(cached, ev)); // surgical, zero refetch
      if (ev.type === "assignment.created") toast(`Assigned to ${ev.repName}`);
    },
    // Reconnect uses the exact same code path as cold load. Non-negotiable.
    onReconnect: () => qc.invalidateQueries({ queryKey: ["board"] }),
    onStatusChange: (s) => setConnectionStatus(s), // "Live updates delayed" banner
  });
}
```

**Events are hints to refresh, not truth.** If Redis or WS dies, Postgres still assigns correctly, the UI shows a degraded banner, and polling at 10s takes over.

---

## 12. Roles & Permissions

Roles map to permission strings; handlers check **permissions**, not role names. Enforced server-side on every request and every WS subscription. Client hiding is UX only.

| Permission                                  | BDC Agent  | Sales Rep | Sales Mgr |  GM   | Admin |
| ------------------------------------------- | :--------: | :-------: | :-------: | :---: | :---: |
| `board.view`                                |     ✅     |  limited  |    ✅     |  ✅   |  ✅   |
| `lead.assign`                               |     ✅     |     —     |    ✅     |  ✅   |  ✅   |
| `lead.assign.override` (force rep)          |     —      |     —     |    ✅     |  ✅   |  cfg  |
| `lead.void` (own, time-boxed)               |     ✅     |     —     |    ✅     |  ✅   |  ✅   |
| `lead.void.any` / `lead.reassign`           |     —      |     —     |    ✅     |  ✅   |  cfg  |
| `lead.disposition`                          |     —      |    own    |    any    |  any  |   —   |
| `activity.self`                             |     —      |    ✅     |    ✅     |  ✅   |   —   |
| `activity.view.any`                         |     —      |     —     |    ✅     |  ✅   |  ✅   |
| `rep.override` (status toggle)              |     —      |     —     |    ✅     |  ✅   |  ✅   |
| `reactivation.self`                         |     —      |    ✅     |     —     |   —   |   —   |
| `reactivation.review`                       |     —      |     —     |    ✅     |  ✅   |   —   |
| `schedule.view` / `schedule.manage`         |    view    |    own    |    ✅     |  ✅   |  ✅   |
| `metrics.view`                              | board only | self only |   store   | store | store |
| `metrics.calendar`                          |     —      |     —     |    ✅     |  ✅   |  ✅   |
| `audit.view`                                |     —      | own reqs  |    ✅     |  ✅   |  ✅   |
| `admin.*` (policy, roles, enforcement mode) |     —      |     —     |     —     |  ✅   |  ✅   |

```ts
const requirePerm = (perm: Permission) =>
  middleware(({ ctx, next }) => {
    if (!ctx.actor.perms.has(perm)) throw new TRPCError({ code: "FORBIDDEN" });
    return next();
  });

// Scoping is a SECOND axis. Permission alone is never sufficient.
export const updateStatus = authed
  .use(requirePerm("lead.disposition"))
  .input(z.object({ leadId: z.string().uuid(), status: LeadStatusEnum }))
  .mutation(async ({ ctx, input }) => {
    const lead = await getLead(input.leadId);
    // Tenancy from the SESSION, never from client input:
    assert(lead.storeId === ctx.actor.storeId, "FORBIDDEN");
    if (ctx.actor.role === "SALES_REP")
      assert(lead.assignedRepId === ctx.actor.repId, "FORBIDDEN");
    return applyStatus(lead, input.status, ctx.actor);
  });
```

**Non-negotiable governance rules:**

- Every query filters by `storeId` from the session. Postgres RLS scoped by store as defense in depth.
- Every mutating procedure writes `audit_events` **in the same transaction**.
- Overrides require a non-empty structured `reason_code` **at the API level**, not just the UI.
- A manager cannot approve their own reactivation request.
- `ADMIN` does **not** automatically imply unrestricted customer PII access — separate capability.
- **Overriding status on past dates is forbidden entirely.** Retroactively changing history is a metrics lie. Override controls render only for today and future.

**Override abuse** is countered by reporting, not blocking: weekly digest to the GM listing overrides per manager, reps benefited, reason codes, after-hours overrides, and rep concentration. `overrideSecondApprovalAfterPerMonth` escalates to dual approval past a threshold. Overrides show as badges on the calendar so they're visible in context.

---

## 13. Metrics & Aggregation

Scale check: a busy store does ~3,000 leads/month. **On-demand SQL with good indexes is genuinely fine** for most of this. Rollups exist for year-views and to keep the board query cheap.

| Metric                                        | Strategy                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next-up ordering (hot path)                   | `rep_month_counters` written transactionally + `rds_available` partial index                                                                                                                                                                                                                                                                                               |
| Leads/rep, leads/BDC agent, total distributed | On-demand `GROUP BY period_key` over `assignment_events` (indexed), Redis-cached 60s, invalidated by `metrics.invalidated`                                                                                                                                                                                                                                                 |
| **Round-robin cycles**                        | `COUNT(*)` on `rotation_cycle WHERE closed_at IS NOT NULL`. Report **three** numbers: `cycles_completed`, `clean_cycles` (`skip_count = 0`), and `cycles_with_skips` — otherwise management reads a one-rep cycle during a staffing shortage as a full rotation                                                                                                            |
| Monthly disqualifications                     | `eligibility_snapshot GROUP BY computed_status` — free. Count **distinct episodes**, not job runs                                                                                                                                                                                                                                                                          |
| Conversion per rep / overall                  | `lead.sold_rep_id` frozen at sale time. **Attribution is decided once and displayed in the UI**: the rep holding the lead at time of sale gets credit; a later reassignment cannot silently rewrite history. Offer both cohorts: _assignment-month_ ("of leads distributed in June, how many eventually sold") and _sale-month_ ("how many phone-up sales closed in June") |
| 12-month trends, GM reports                   | Nightly `rollup.dailyFacts` into `daily_facts`, rebuilt incrementally                                                                                                                                                                                                                                                                                                      |
| **Reconciliation**                            | Nightly: recompute counters from the ledger, assert equality, **alert on any drift**. This is the alarm that tells you the projection lied                                                                                                                                                                                                                                 |

**Skip Postgres materialized views.** They fit per-store tz bucketing poorly and refresh locking is a nuisance. Rollup **tables** plus an idempotent `recompute(store, period)` function you can run anytime are simpler and safer.

**Define every metric in writing and show the definition in a tooltip.** "Leads distributed" = sum of positive `credit_delta`, net of corrections. "Leads per rep" = net assignment credit, not current ownership. Ambiguity here becomes an argument on the sales floor.

---

## 14. Calendar View

Hand-roll the month grid. `react-big-calendar` fights you on custom cell rendering and you need dense cells.

- **Data:** one endpoint `metrics.calendar(month, repId?)` returning per-day objects assembled from `rep_shift` (shift/off), `rep_daily_status` (status + reason), `eligibility_snapshot` (calls/notes vs. target, evaluated-from date), and event counts (leads, sales, overrides).
- **Cell:** date number, status chip (color **+ letter**: E/D/R/O/C), then `3 leads · 1 sold · 11/18 calls`. **DQ days show the snapshot numbers inline** so managers see _why_ without clicking.
- **Click a day** → side panel with the full activity timeline, the verbatim `computed_reason`, any override with its reason and actor, and reactivation history.
- **Manager actions** on today/future only: override status (reason required), toggle day off.
- **Multi-rep view:** 20 reps × 31 days does not fit a month grid. Render a **row-per-rep heatmap**, GitHub-contributions style, one row per rep, one cell per day, colored by status with lead count as intensity. Virtualize if you exceed ~50 reps.
- Cells keyed by **store-local date strings** (`'2026-06-14'`), never `Date` objects crossing the wire.

---

## 15. Testing, Observability, Migrations, Roadmap

### Testing

**Property-based (fast-check) on `packages/core`** — the highest-value tests in the codebase, and they run in milliseconds because `core` has zero I/O:

- `sortKeys` produces a **total order** for any member set (no ties, ever).
- Determinism: same input → same output, across runs and processes.
- A `DISQUALIFIED` / `OFF_SCHEDULE` rep is **never** selected.
- No rep is served twice in one cycle.
- After _N_ eligible reps each receive one up, the cycle increments **exactly once**.
- `decideStatus` precedence: overrides beat computed, schedule beats eligibility.

**Concurrency integration (Testcontainers Postgres)** — the test that proves the design:

```ts
it("serializes 50 parallel assignments across 10 reps with zero double-serve", async () => {
  await seedReps(10);
  await Promise.all(
    range(50).map((i) =>
      createAndAssignLead(fakeLead(i), agents[i % 2], `idem-${i}`),
    ),
  );

  const events = await ledgerEvents({ eventType: "ASSIGN" });
  expect(events).toHaveLength(50);
  expect(new Set(events.map((e) => e.seq)).size).toBe(50); // no seq collision
  expectNoDuplicateRepWithinAnyCycle(events);
  expect(await countersFromTable()).toEqual(await countersFromLedger()); // projection intact
  expect(await openCycleCount()).toBe(1); // invariant holds
});

it("is exactly-once under retry", async () => {
  const a = await createAndAssignLead(lead, agent, "same-key");
  const b = await createAndAssignLead(lead, agent, "same-key");
  expect(b.lead.id).toBe(a.lead.id);
  expect(await ledgerCount()).toBe(1);
});
```

Also test concurrently: manager disqualification racing an assignment; reactivation racing cycle closure; month rollover mid-lock.

**Eligibility calendar table tests:** Sunday closures, holiday Monday (Tuesday evaluates Saturday), rep day-off exemption, month boundary (May 31 evaluated on June 1), DST spring-forward and fall-back weekends, week-of-PTO return with `max_prior_workday_age`, new hire inside grace window.

**E2E (Playwright)** — test the keyboard contract _as a contract_: tab order, `Enter` advancing not submitting, `Ctrl+Enter` submitting, clipboard copy with fallback, and _two browser contexts_ — agent A assigns, agent B's Next Up highlight moves within 500ms. Plus `axe-core` scans and one manual screen-reader pass per release.

### Observability

- pino structured logs with `storeId` / `actorId` / `leadId` / `requestId` correlation. **Never log raw phone numbers, names, or note bodies.**
- OpenTelemetry spans around the assignment transaction. SLOs: p50 < 150ms, p95 < 400ms.
- Named metrics with alerts:
  - `assignment_lock_wait_seconds` — your only serialized resource; page if p99 > 50ms
  - `eligibility_job_lag_seconds` — **page if > 2h past scheduled.** A silently dead 05:30 job means nobody is ever disqualified and the whole accountability loop quietly dies while looking healthy
  - `counter_reconciliation_mismatch_total` — must be 0
  - `unassigned_queue_depth`
  - `manager_override_total` by actor
  - `evidence_scan_failure_total`
- Weekly audit digest email to the GM: overrides, reactivations, disqualifications. Abuse detection as a shipped feature, not an afterthought.
- Managed PG with PITR and a **tested** restore procedure. Hourly `audit.sealHashChain`.

### Migrations & seed

Drizzle Kit migrations in CI, expand/migrate/contract for zero downtime: (1) additive schema, (2) deploy code reading both shapes, (3) async backfill, (4) verify counts, (5) flip feature flag, (6) drop old columns in a _later_ release.

`seed.ts` creates a demo store (`America/Chicago`, closed Sundays, one holiday), 12 reps with varied counters and weights, 2 BDC agents, a manager, a GM. Critically: it **replays 30 days of synthetic events through the real service layer**, not raw inserts — so snapshots, counters, cycles, and rollups are mutually consistent. For an event-ledger system this is the only seeding discipline that produces a valid demo state. `pnpm seed` → working demo in two minutes.

### Phased roadmap

**Phase 0 — validate before building (1 week).** Sit with actual BDC agents and time the current process. Agree the exact "sufficient work" rule, the skip-charging policy, and the sale-attribution rule _in writing_. Paper-prototype the keyboard flow. This week saves a month.

**Phase 1 — MVP (4–5 weeks).** Auth + RBAC + tenancy. Roster board + ranked Next Up + keyboard lead entry + clipboard handoff. Assignment ledger under advisory lock, with counters and reconciliation. Manual schedule entry. Morning eligibility job in **SHADOW mode**. Manager override with mandatory reason + audit. Unassigned holding queue. Duplicate-phone warning. WS board sync. Basic metrics: leads/rep, per-BDC, cycles completed, disqualification counts.

**Phase 2 — accountability loop (3 weeks).** Flip `enforcement_mode` to `ENFORCE` per store after reviewing shadow reports. Structured activity logging with note-quality rules. Reactivation workflow with evidence upload and SLA queue. Calendar view. CSV schedule import with dry-run diff. Disqualification notifications.

**Phase 3 — performance & trust (3 weeks).** Dispositions and conversion tracking. Cohort reporting. Daily rollups. GM override-abuse report. Rep self-serve "why am I out" page. Reconciliation alarms hardened.

**Phase 4 — the integration that matters.** Telephony CDR ingestion via the REST seam, reconciling logged calls against actual dialed calls. This is what turns the accountability engine from self-reported to verified. Then: rep push notifications for speed-to-lead, mobile activity logging, multi-rooftop GM rollups.

---

## 16. Edge Cases — Decisions, Not Deferrals

| Case                           | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Rep quits mid-month**        | Set `terminated_on`. All history intact — past leads still attribute to them. Excluded from the pool by the employment predicate. Any pending cycle slot resolves as `SKIP / TERMINATED`, `charged = false`. No cycle surgery needed, because the wrap check runs against the _current_ eligible set. Reassign their open leads separately; that never rewrites distribution history.                                                                                          |
| **Mid-month hire**             | Zero counter would make them Next Up constantly until they catch up. Default (`midMonthHireSeedStrategy: 'MEDIAN'`): emit a `BALANCE_CREDIT` ledger event seeding `credit_mtd` to the **median** of active reps. Auditable and replayable because it's an event, not a manual `UPDATE`. Grace window (`grace_days_after_hire`) governs their qualification. If you prefer pure zero-seeding, the one-turn-per-cycle rule already prevents flooding — pick one and document it. |
| **Undo (data-entry error)**    | `VOID` event, `credit_delta = -1`, cycle slot restored. Time-boxed to `undoWindowSeconds` for BDC agents, unlimited for managers, always reasoned and audited.                                                                                                                                                                                                                                                                                                                 |
| **Reassignment**               | `REASSIGN_OUT` + `REASSIGN_IN`. Original rep keeps credit; recipient's turn isn't consumed. Flagged so it doesn't pollute fairness metrics.                                                                                                                                                                                                                                                                                                                                    |
| **No-show / lost**             | Disposition only. **Never returns the rep's turn** — otherwise reps cherry-pick by declaring leads junk. Track no-show _rate_ per rep as a quality metric instead.                                                                                                                                                                                                                                                                                                             |
| **Duplicate phone**            | Normalize to E.164, look back `duplicateLookbackDays` (90). **Warn, never block** — spouses and households share numbers, and blocking a live phone-up is worse than a dupe. Amber banner post-submit with one-click mark-duplicate/void.                                                                                                                                                                                                                                      |
| **No eligible reps at all**    | Persist the lead into `unassigned_queue`, alert managers, show a board banner. `queue.drainUnassigned` auto-assigns the moment someone qualifies or is reactivated. **A live phone-up is never dropped.**                                                                                                                                                                                                                                                                      |
| **Eligibility job didn't run** | Catch-up on boot; lazy `ensureEligibilitySnapshots()` inside the assignment transaction; fail-open to `ELIGIBLE` with a page.                                                                                                                                                                                                                                                                                                                                                  |
| **Missing schedule import**    | Fail **safe**: `CONFIGURATION_ERROR`, alert management, board banner. Never silently mark everyone active.                                                                                                                                                                                                                                                                                                                                                                     |
| **DST**                        | UTC storage, IANA tz, local-bucket-at-write, tz-aware cron. Non-issue if §6.4 is followed; a bug farm if not.                                                                                                                                                                                                                                                                                                                                                                  |
| **Month rollover**             | No reset job. `period_key` on every event; new counter rows on first assignment of the month. Close any prior-month open cycle as `MONTH_END_CLOSE`. The June 1 job evaluates May 31 activity — evaluation window ≠ bucket window, and that's correct.                                                                                                                                                                                                                         |
| **Two agents simultaneously**  | Advisory lock serializes; the second recomputes after the first commits. Version OCC converges both UIs. Agent B is told who _actually_ got it.                                                                                                                                                                                                                                                                                                                                |
| **Manager override abuse**     | Mandatory structured reason; immutable audit; no self-approval; past-date overrides forbidden; weekly GM digest; dual approval past a monthly threshold. Report, don't block — a hard block just moves the workaround off-system.                                                                                                                                                                                                                                              |
| **Rep games notes**            | `min_note_chars`, `note_hash` duplicate rejection, note must reference a lead or contain ≥7 digits, `log_delay_sec` flags 9pm burst-backdating. Managers see the actual note text in the calendar day panel. And be honest with management that none of this verifies a call was placed — that's Phase 4.                                                                                                                                                                      |
| **Reactivation after hours**   | Requests are per-date. Approval applies to `business_date = today`; otherwise it's a no-op. You cannot retro-fix yesterday, and shouldn't — snapshots are immutable.                                                                                                                                                                                                                                                                                                           |
| **Network drops mid-entry**    | Draft + idempotency key to IndexedDB outbox, retried on reconnect, exactly-once server-side.                                                                                                                                                                                                                                                                                                                                                                                   |
| **Customer deletion request**  | Scrub `customer` (set `redacted_at`, null the PII), leave the ledger intact. Fairness history survives; the person doesn't appear.                                                                                                                                                                                                                                                                                                                                             |

---

## 17. What I'd Push Back On

Three honest objections to the requirements as stated, in priority order.

**1. "Calls made" is unverifiable, and it's the linchpin.** Every consequence in this system — losing leads, losing income — hangs on a number the rep types into a box. Your phone system already produces CDRs. Until you reconcile against them, a rep who wants to game this can do so in thirty seconds, and the honest reps will figure that out and lose faith in the whole thing. I've designed the REST seam and the `entry_source: 'TELEPHONY'` field for it. Move it earlier than Phase 4 if you can.

**2. Eligibility is not the same as availability, and dealerships live on the difference.** A rep can be scheduled, qualified, and standing in the F&I office with another customer, or on a test drive, or at lunch. Real floors track "on the floor / with a guest" turn state. This design has no presence concept, which means Next Up will sometimes point at someone who physically cannot take the call — and _that_ is the most common reason strict round-robin systems get abandoned in practice. Consider a one-click "skip me, I'm with a guest" that demotes without charging, before you ship enforcement.

**3. Nothing here notifies the rep.** A phone-up's entire value is immediacy. The BDC agent copies a number and pastes it into a CRM; the assigned rep learns about it… when? Add rep push/SMS on assignment and an escalation if `first_touch_at` stays null for N minutes. The `first_touch_at` column is already in the schema for exactly this.

Also worth pricing before you commit: **the human process load.** Who reviews six reactivation requests at 8:00am? What happens when a manager overrides everyone daily and the system becomes decorative? Withholding leads mechanically reduces commission income — check the wage-and-hour and commission-plan implications with counsel, and give reps a documented appeal path beyond ad-hoc reactivation. And before building any of this, confirm your CRM (VinSolutions, DealerSocket, eLead) doesn't already ship a rotation module you'd be double-entering against.

---

## The Three Things to Remember

1. **The algorithm reads `rep_daily_status`; everything else only writes it.** One indexed query on the hot path, and every edge case becomes a status write instead of an algorithm branch.
2. **Append-only ledger + derived counters + nightly reconciliation.** Auditability from the ledger, speed from the counters, _trust_ from the reconciliation alarm.
3. **`pg_advisory_xact_lock` around recompute-and-assign.** At dealership scale this is strictly simpler and strictly more correct than optimistic or `SKIP LOCKED` approaches. The Next Up you see is advisory; the assignment under the lock is authoritative.
