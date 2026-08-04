Review — 673d855 "prior cycle order in lead assignment"
Verdict: core idea sound, but fix incomplete — three other paths still rank the old way, and it introduces a permanent-demotion fairness hole.

Checks I ran: pnpm typecheck clean, packages/core tests pass (17). API integration test not run — no TEST_DATABASE_URL locally, so the new assignLead.test.ts case is unverified by me.

1. Board shows different order than assign picks — HIGH
board.ts:67 builds rankInputs with no priorCycleOrder. So board.roster ranks by monthlyLoad, assignLead ranks by prior-cycle order. Moment a cycle closes, board's top-of-list ≠ rep who actually gets next lead.

That's exactly the "why wasn't I next" surface the ledger exists for. Code comment at assignLead.ts:97 says "Match the Served This Round display order" — but display order never got the field.

2. Skip picks a different "next rep" — HIGH
skipLead.ts:143 same omission. Two definitions of next-in-line now live in the codebase. A skipped lead reroutes by monthly load; a fresh lead routes by prior cycle order.

3. Rep ineligible one cycle → last place forever — HIGH
SKIP writes assignment_events only, never rr_cycle_assignments (assignLead.ts:121-133). So a rep INELIGIBLE during cycle N has no prior-order entry → ?? Number.MAX_SAFE_INTEGER → sorts behind every served rep in cycle N+1.

Worse: it's self-perpetuating. He gets served last in N+1 → priorCycleOrder = last in N+2 → last again. Forever. Pre-fix, low monthlyLoad put him first, which was the correction mechanism.

Root cause: order derived from who got served, not from ranked position. Deriving priorCycleOrder from the closing cycle's queueSnapshot (already stored on the ledger) covers skipped reps too.

4. Void demotes the rep instead of restoring them — MEDIUM
voidLead.ts:78-83 deletes the rep's rr_cycle_assignments row. Comment line 76: "this is what puts them back at the top." When the cycle can't be reopened (successor already has assignments, voidLead.ts:102), the rep now has no prior-cycle row → back of the line next cycle. Opposite of stated intent.

5. Reassign scrambles next cycle for both reps — MEDIUM
reassignLead.ts:113-132: source slot deleted (→ source has no prior order → last), target slot inserted with fresh assignedAt (→ target sorts to end of prior order). One manager reassign moves two reps to the tail of the next rotation.

6. monthlyLoad is now dead code in steady state — DESIGN
Once every eligible rep serves a cycle, all have a priorCycleOrder, so the monthlyLoad comparator at ranking.ts:24 never fires again. Deviates from plans/v1-plan.md:12 sort spec (served → monthly load → last-assigned-at → seed → id). Intentional per the doc comment, but it removes the only rebalance path for mid-month joins, voids, and forced assigns.

Simpler alternative worth considering: lastAssignedAt ascending already reproduces served order. Swapping monthlyLoad and lastAssignedAt in the comparator fixes "monthly totals reshuffle the rotation" with zero new DB reads, no new field, no permanent-demotion hole, and it degrades gracefully for reps with lastAssignedAt = null. Ask whether prior-cycle order buys anything over that.

7. Test gaps — MEDIUM
assignLead.test.ts:89 is a decent discriminating test (seeded 10/20/30 loads would invert the expectation without the fix). Missing:

rep INELIGIBLE during cycle one (finding 3)
order after a void (finding 4)
no assertion that board.roster agrees with assignLead
Also leaks closed rotation_cycle rows — beforeEach clears rr_cycle_assignments but not cycles. Harmless within the file; matters if suites share a DB with voidLead.test.ts:68, which deletes all cycles.

8. Nit — hot path
Two extra queries inside the advisory lock per assignment. Roster-sized, so fine at ~30 reps. Note only.

Minimum to land safely: feed priorCycleOrder in board.ts and skipLead.ts (extract the prior-cycle lookup into one shared helper — three copies is how they drift), and decide finding 3 before this ships, since one sick day permanently sinks a rep.