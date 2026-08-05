The spec is directionally sound, but I would not approve it as written. It contains two correctness contradictions and several avoidable token pits.

## Blocking findings

1. Queued-lead idempotency is not currently protected.

The spec promises exactly one audit event for queued leads while declaring idempotency and `assignment_events` unchanged ([spec lines 51–65](/Users/seandm/Projects/1_PHONE_RR/docs/superpowers/specs/2026-08-04-priority-5-audit-completeness-design.md:51)).

But `assignLead` detects retries only by finding the original key in `assignment_events` ([assignLead.ts:41](/Users/seandm/Projects/1_PHONE_RR/apps/api/src/domain/assignLead.ts:41)). Assigned leads write that row, while the no-eligible path creates the lead and queue row without writing the original idempotency key ([assignLead.ts:142](/Users/seandm/Projects/1_PHONE_RR/apps/api/src/domain/assignLead.ts:142)).

Therefore, retrying a queued submission can create another lead and another audit event. The assertions at spec lines 115–117 and 284–288 are not true for that path.

Simplest resolution: explicitly include the queued-idempotency repair in scope—probably a zero-credit `QUEUE` ledger event carrying the lead ID and original idempotency key—or weaken “exactly once.” I recommend fixing it because this is assignment correctness, not merely audit polish.

2. Offset pagination cannot guarantee no duplicates or omissions.

The spec keeps offset pagination while promising that filtered pagination has no duplicates or omissions ([spec lines 146–148](/Users/seandm/Projects/1_PHONE_RR/docs/superpowers/specs/2026-08-04-priority-5-audit-completeness-design.md:146), [292–293](/Users/seandm/Projects/1_PHONE_RR/docs/superpowers/specs/2026-08-04-priority-5-audit-completeness-design.md:292)). If a new event arrives between page requests, every offset shifts.

Choose one:

- Simplest: state that pagination is correct for a stable result set and accept live-stream shifting.
- Strongest: use cursor pagination based on `(createdAt, id)`.

For this small internal tool, I would keep offset pagination and correct the promise.

## Main token pits

- The custom affected-record combobox is the largest one. Async search, three entity types, duplicate labels, unresolved UUIDs, active-option management, keyboard behavior, stale responses, and narrow-screen browser validation could consume more work than all the audit filtering itself ([spec lines 175–188](/Users/seandm/Projects/1_PHONE_RR/docs/superpowers/specs/2026-08-04-priority-5-audit-completeness-design.md:175), [195–216](/Users/seandm/Projects/1_PHONE_RR/docs/superpowers/specs/2026-08-04-priority-5-audit-completeness-design.md:195)). Simpler: affected-kind select plus a native current user/rep select, with an exact lead UUID input. Add customer-name lead search later only if managers actually need it.

- “Showing N matching events” is underspecified. `audit.list` returns page items and `hasMore`, not a total count ([audit.ts:22](/Users/seandm/Projects/1_PHONE_RR/apps/api/src/routers/audit.ts:22)). Either say “Showing N events on this page” or add a filtered count query. The count query is needless scope for this goal.

- Timezone conversion can become a Date/Intl rabbit hole. Specify PostgreSQL boundaries directly: convert the validated date at `America/New_York`, using the next local midnight as the exclusive upper bound. That avoids dependencies and process-timezone experimentation.

- The sold-status section pre-designs a hypothetical feature while saying it will not pre-decide it ([spec lines 237–260](/Users/seandm/Projects/1_PHONE_RR/docs/superpowers/specs/2026-08-04-priority-5-audit-completeness-design.md:237)). Keep one durable rule: any future lead sold-state mutation must append a same-transaction lead audit event with complete before/after state. Defer the action name, correction model, permissions, reconciliation, and tests to that feature’s design. Do not add this hypothetical contract to `CLAUDE.md` yet.

- The browser matrix is disproportionate: two roles × two viewports × every individual filter × failures × paging × combobox accessibility ([spec lines 317–326](/Users/seandm/Projects/1_PHONE_RR/docs/superpowers/specs/2026-08-04-priority-5-audit-completeness-design.md:317)). One Manager functional pass plus one Admin permission smoke test and one 390px accessibility/layout pass is enough. API permission tests should carry the BDC/Rep burden.

- “All existing audit tests remain passing” is fine as a final suite result, but it should not turn into reopening every audit-producing domain. Focus implementation proof on assignment outcomes, list predicates, formatting, and permissions, followed by one broader suite.

The injected audit failure test is not a major pit: the repository already has a transaction-proxy pattern for simulating an audit insert failure in [overrideStatus.test.ts:90](/Users/seandm/Projects/1_PHONE_RR/apps/api/src/domain/overrideStatus.test.ts:90). Reuse it rather than designing new test infrastructure.

## Recommended reduced design

Keep:

- Same-transaction `lead.assign` and `lead.queue` audit rows.
- Action, actor, primary affected entity, and New York date filtering.
- Dynamic action/actor choices.
- Natural creation/removal formatting.
- Existing authority, ledger, realtime, and responsive audit-card behavior.

Change:

- Bring queued idempotency into scope.
- Qualify offset-pagination guarantees.
- Replace the custom affected combobox with native controls unless customer-name lead search is confirmed necessary.
- Replace the ambiguous result count.
- Reduce the future sold section to one invariant.
- Cut the browser matrix to one functional role, one authorization smoke test, and one narrow accessibility pass.

That version achieves the actual Priority 5 goals with much less state-machine, accessibility, browser-fixture, and hypothetical-design work. No files were changed during this review.