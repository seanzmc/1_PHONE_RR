# Plan Comparison: fusion-plan.md vs poe-plan.md

Both target same system: dealership phone-up round-robin + accountability dashboard. Same core algorithm shape (rank reps, advisory lock, ledger-ish counters, eligibility from schedule + activity, disqualification with reactivation). Diverge hard on rigor, stack, and scope.

## Stack summary

| | fusion-plan | poe-plan |
|---|---|---|
| API | Fastify + tRPC v11 + Zod | Fastify + REST |
| ORM | Drizzle (raw SQL mirror) | Prisma |
| Realtime | WS (`ws`) + Redis pub/sub | Socket.IO + Redis |
| Truth model | Append-only `assignment_events` ledger + derived `rep_month_counters` projection, nightly reconciliation | Direct counter increments (`RepMonthlyStat.totalUps++`) inside tx, no ledger, no reconciliation job |
| Jobs | node-cron in-proc w/ leader lock → graduate to Graphile Worker | BullMQ |
| Length | 1758 lines | 1071 lines |

## Comprehensiveness — fusion-plan is more comprehensive

fusion-plan has several things poe-plan lacks entirely:
- **Ledger + reconciliation.** Assignment history is append-only (`ae_no_update`/`ae_no_delete` DB rules), counters are a rebuildable projection, nightly job asserts `projection == fold(ledger)` and alerts on drift. poe-plan increments `RepMonthlyStat` directly with no way to detect or repair drift, and no way to answer "replay exactly what happened" beyond the `assignmentReason` JSON snapshot on the lead.
- **Shadow-mode enforcement rollout** for disqualification (`enforcement_mode: SHADOW|ENFORCE`) so bad thresholds don't cut real pay before they're calibrated. poe-plan disqualifies for real from day one of Phase 3.
- **Fail-open vs fail-safe distinction** stated explicitly (eligibility job fails open, missing schedule import fails safe/`CONFIGURATION_ERROR`). poe-plan doesn't address what happens if the nightly job dies.
- **Explicit "what I'd push back on"** section (unverifiable call counts, no presence/availability concept, no rep notification) — poe-plan raises the notes-gaming problem but doesn't call out CDR verification, presence, or rep-side notification as gaps.
- **PII handling for reactivation evidence** (screenshots contain other customers' PII — redaction guidance, no OCR, 90-day retention). Not addressed in poe-plan.
- **Wage/commission legal flag** — fusion-plan explicitly says to check wage-and-hour/commission-plan implications with counsel before withholding leads mechanically reduces someone's pay. poe-plan doesn't raise this.
- **Property-based testing** of the ranking invariant (10k random sequences, total order, no double-serve) vs poe-plan's stated intent to do the same but without the concrete pure-module boundary (`packages/core`, zero I/O, enforced by lint rule) that makes it actually fast to run.
- More edge cases enumerated (rotation groups as first-class, fiscal periods ≠ calendar month, house accounts, weighted part-timers, BALANCE_CREDIT for mid-month hires as an auditable event rather than a raw UPDATE).

poe-plan is not thin, though — it has real content fusion-plan doesn't spell out as concretely:
- A literal ASCII mockup of the entry screen and calendar heatmap.
- A cleaner permission matrix table and REST route list that's easier to skim.
- The `manualStatus: FORCE_ACTIVE` beats `DISQUALIFIED` precedence rule is stated with equal clarity.

**Verdict: fusion-plan is meaningfully more comprehensive** — it covers failure modes, legal/audit exposure, and long-term data integrity that poe-plan doesn't touch.

## Realism — mixed, edge to poe-plan for team size, edge to fusion-plan for correctness-under-load

fusion-plan's design is *internally* more defensible (it justifies every choice against alternatives — SERIALIZABLE vs advisory lock, WS vs SSE, Drizzle vs Prisma) but it's also heavier to actually build:
- Raw DDL with exclusion constraints (`EXCLUDE USING gist`), partial indexes, `CREATE RULE` for append-only enforcement, hash-chained audit log, S3 evidence pipeline with malware scanning — this is infrastructure a 1-2 person team will spend real time on before shipping anything a BDC agent touches.
- Drizzle + hand-written SQL mirrors requires the dev to be comfortable in raw Postgres, not just an ORM. That's a real skill/time cost fusion-plan itself flags as a tradeoff (§2 stack table).
- The ledger-and-reconciliation model is the *correct* long-term answer but is overkill relative to the stated scale (~1,000–3,000 assignments/month) until you actually hit a dispute. fusion-plan concedes this ("at ~1,000-3,000 assignments/month... costs ~1-2ms") but the schema complexity (assignment_events, rotation_cycle, rr_cycle_assignments, rr_state, rep_month_counters — five tables for one concept) is a lot of surface for that volume.

poe-plan is more realistic to actually execute in the stated phase timeline:
- Prisma is the more common ORM choice for small teams; faster onboarding, though fusion-plan's critique of Prisma's `$queryRaw` returning `unknown` for the ranking query is a legitimate and specific weakness that materializes in poe-plan's own `assignment.service.ts` (it does exactly this: `$executeRaw`/`$queryRaw` for the lead-note-coverage query, undermining Prisma's main selling point).
- Fewer moving parts (no separate ledger + projection + reconciliation job, no hash-chained audit log, no S3 evidence malware scan pipeline at MVP).
- `isolationLevel: 'RepeatableRead'` **plus** an advisory lock in the same transaction (poe-plan §3.3) is redundant/confused — the advisory lock alone already serializes; layering `RepeatableRead` on top adds retry-on-conflict exposure fusion-plan explicitly designed to avoid. This is a real correctness/complexity smell in poe-plan that fusion-plan's own reasoning (§5.2) would flag as a mistake.
- poe-plan's lack of a reconciliation job means counter drift (a bad `UPDATE`, a bug in an increment) is silently permanent — this is the exact failure mode fusion-plan's ledger design was built to make impossible, and it's a believable failure given poe-plan does raw increments in several code paths (assignment, void would presumably need symmetric decrements not shown).

**Verdict: poe-plan is more realistic for a small team's first cut; fusion-plan is more realistic if "realistic" means "won't need a rearchitecture the first time a rep disputes their count."** Depends what risk you're optimizing for.

## Directness of the development path — poe-plan is more direct

- poe-plan's Phase 1 ("Core loop, 2-3 wk") ships auth, roster, entry screen, atomic round-robin, override toggle, audit log — a working whiteboard-replacement fast. fusion-plan's Phase 1 is "4-5 weeks" and includes the full ledger, reconciliation, SHADOW-mode eligibility, unassigned queue, and WS sync before anything ships — more correct, but a longer runway to first usable version.
- fusion-plan adds an explicit **Phase 0 "validate before building" (1 week)** — good practice, but it's an extra step before code starts, whereas poe-plan goes straight to build.
- poe-plan's data model is one migration away from working (Prisma schema, standard relations). fusion-plan's data model requires hand-maintained raw SQL alongside Drizzle mirrors (explicitly because Drizzle's DSL can't express exclusion constraints/generated columns/rules) — an extra layer of hand-sync discipline (§3.2/3.7) that is a plausible source of drift between the two representations during active development.
- fusion-plan's own stack table is honest that several of its choices (WS over SSE, Drizzle over Prisma, ledger over counters) are the *harder* path chosen for reasons that pay off later, not the fastest path to a demo.

**Verdict: poe-plan has the more direct path to a working v1**; fusion-plan has the more direct path to a system that survives its first real dispute or audit six months in.

## Bottom line

| Dimension | Winner |
|---|---|
| Comprehensiveness | **fusion-plan** — covers failure modes, legal exposure, PII, auditability, verification gaps poe-plan doesn't mention |
| Realism | **Split** — poe-plan fits a small team's actual capacity better; fusion-plan's architecture is more realistic about what a fairness system needs once someone disputes a number |
| Directness of dev path | **poe-plan** — simpler stack, shorter Phase 1, fewer novel Postgres features to learn mid-build |

If the team is small and needs something live fast, and can tolerate rearchitecting the counter/audit layer later: start from **poe-plan**, but graft in fusion-plan's specific fixes — the reconciliation job, SHADOW-mode rollout for disqualification, and dropping the redundant `RepeatableRead` isolation level.

If the team has the bandwidth to build it right once (or this is going to run across multiple rooftops and *will* get disputed), **fusion-plan** is the safer foundation — but budget for its heavier Phase 0/1.
