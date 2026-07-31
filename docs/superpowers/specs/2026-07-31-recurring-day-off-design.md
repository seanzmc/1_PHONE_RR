# Recurring day off — design

Queue item 3, "Days off: Save button, gate on all-week."

The item as written assumed a rep can have several recurring days off, so it asked for a
Save button to batch the toggles and a gate to stop a manager marking the whole week. That
assumption turned out to be wrong: on this floor a rep gets exactly one recurring day off,
or none. Constraining the model to that is what this pass does, and it removes the need
for both the Save button and the gate rather than building them.

## Problem

The Staff List renders six toggle buttons per rep, Mon through Sat. Each click fires
`rep.setDaysOff` immediately with the full new set.

**Multi-select does not match the floor.** A rep gets one day off a week or none. Six
independent toggles let a manager express a schedule the store does not run, including the
degenerate "every day off," which produces a rep who is `OFF` on every materialized shift
and can never be assigned a lead.

**Immediate save is only correct because each click is a complete intent.** With
multi-select it is not: moving a rep from Tuesday to Wednesday is uncheck-then-check, which
is two mutations, two audit events, and a moment where the rep has no day off at all. That
is what the queue item's Save button was for. Under a single-day model the problem
disappears — one selection is the whole intent — so immediate save stays correct and the
Save button is not built.

**The days-off column is an N+1.** `refresh()` issues one `rep.daysOff` query per rep,
so a ~30-rep roster is ~30 requests, re-run on every board realtime event — every assign,
void and status change. Each of those responses also carries an `upcoming` shift list from
`getUpcomingShifts` that no caller reads. Meanwhile `getRecurringDaysOffForReps`, a batch
reader that would answer the whole column in one query, exists in the domain and has never
been called.

## Scope

In: constraining a rep to at most one recurring day off, server-side and in the UI;
replacing the toggle buttons with a radio group; replacing the per-rep days-off fetch with
one batch query; deleting the now-unused per-rep query and shift preview.

Out: any policy config for how many days off are allowed (the limit is one, hardcoded, the
same way Sunday-closed is hardcoded), bulk days-off editing across reps, a UI for upcoming
shifts, and the Staff List's disabled-account filtering (queue item 10).

Not needed, and deliberately not built: a shared rule module in `packages/core`. The
override no-op rule lives there because the client and the server both evaluate it. Here
the client cannot express more than one day — a radio group has one value — so there is no
second evaluator to keep in sync. A core module with a single consumer is worse than none.

## Server

### The rule

`setRecurringDaysOff` already normalizes its input: filter to 1–6, dedupe, sort. Sunday is
dropped because the store is closed and it must not consume a rep's entry.

The new check goes **after** normalization, inside the existing transaction and advisory
lock, before any write:

```
if (requested.length > 1) throw new Error('a rep can have at most one recurring day off, got: ...')
```

A plain `Error`, not a `TRPCError`. No domain module in this codebase throws `TRPCError` —
`bulkOverrideStatus`, `voidLead` and `userManagement` all throw `Error` and let the router
layer map it — and the web client renders `error.message` regardless of code, so the
manager sees the same sentence either way.

After normalization, not before, so the rule is about working days off. `[0, 3]` is Sunday
plus Wednesday, which is one recurring day off and must be accepted. `[4, 5]` is two and is
rejected.

The limit stays out of `setDaysOffInputSchema`. A `.max(1)` on the raw array would reject
`[0, 3]`, which is legal. Shape belongs in contracts, meaning belongs in the domain.

No lock change. Days off change rotation ordering, so this path already takes
`pg_advisory_xact_lock(42_100_1)` like every other ordering-changing path, and the
rejection happens inside it.

### `rep.allDaysOff`

New query on the rep router, permission `schedule.manage`, no input:

```ts
() => Promise<Record<string, number[]>>   // repId -> sorted days off
```

It wraps `getRecurringDaysOffForReps`. Reps with no recurring day off are present with an
empty array rather than absent, so the client never has to distinguish "no day off" from
"not loaded."

### Deletions

`rep.daysOff` (the per-rep query) and `getUpcomingShifts` are both removed. `rep.daysOff`
loses its only caller to `rep.allDaysOff`; `getUpcomingShifts` exists only to populate that
procedure's `upcoming` field, which nothing reads. `getRecurringDaysOff` (single-rep) stays
— it is the natural read for a future rep-detail view and costs nothing.

## Client

The days-off cell becomes a native radio group per row: **None**, then Mon through Sat,
with `name` scoped to the rep so the groups do not interfere. The selected radio is the
rep's stored day.

Selecting fires `rep.setDaysOff` immediately with `[dow]`, or `[]` for None — the existing
optimistic-update-and-roll-back path, minus the toggle arithmetic. A failed mutation
restores the previous selection and shows the message in the existing `ui-error` banner
above the table — the same one `toggleDayOff` writes to today. There is no per-row error
slot on the Staff List and this pass does not add one: the radio is a single click with an
immediate visible rollback, so the banner is unambiguous about which action failed.

`refresh()` replaces its per-rep loop with a single `rep.allDaysOff` call, still gated on
`canManageSchedule`.

### More than one stored day

A rep can already have several rows — from before this change, or from a direct database
write. Such a row renders with **no radio selected** and a short note naming the stored
days, e.g. "Thu, Fri stored — pick one." The manager's next selection collapses it to one.

The alternative, selecting whichever day sorted first, would show a schedule that is not
what the database holds and would let a stray click silently discard the other day. This
state is expected to be empty in practice; it costs a few lines and prevents a silent
mangle.

No migration collapses existing rows. There is no correct automatic answer to which of a
rep's two days to keep, and a manager picking is both cheap and auditable.

## Tests

**API, against the live test database:**

- Two working days off are rejected, and nothing is written — neither `rep_recurring_day_off`
  rows nor an audit event.
- `[0, 3]` is accepted and stores exactly `[3]` — the Sunday-drop happens before the count
  check. (Extends the existing case at `eligibility.test.ts:356`.)
- A valid save writes one row, appends one `rep.days_off.set` audit event with before/after,
  and re-materializes shifts forward only.
- `rep.allDaysOff` returns an entry for every rep, including an empty array for reps with no
  recurring day off.

**Two existing tests use multi-day input and must be rewritten:**

- `eligibility.test.ts:387`, "re-materializing after a days-off change never rewrites a PAST
  date," sets `[1,2,3,4,5,6]` so that any backwards reach would flip the seeded past row to
  `OFF`. Rewrite it to set the single day off to the past date's own weekday. The detection
  is the same and the input is legal.
- `eligibility.test.ts:404`, the audit before/after case, sets `[2]` then `[4,5]`. The
  second becomes `[4]`.

**Web:**

- Selecting a weekday radio sends `daysOfWeek: [dow]`; selecting None sends `[]`.
- A failed mutation restores the prior selection.
- A rep with two stored days renders with nothing selected.

## Consequences

A rep can no longer be scheduled off more than one day a week through the app. Genuine
multi-day absence goes through the shift kinds that already exist — `PTO`, `SICK`,
`TRAINING` — which `materializeShifts` deliberately never overwrites. That is the right
place for it: those are dated exceptions, not a recurring weekly pattern.

If the floor later needs two recurring days off, the change is a checkbox group, a
different count in the domain check, and the Save button and conflict handling this pass
skipped. Nothing in the schema blocks it — `rep_recurring_day_off` stays row-per-day, so
the constraint is application-level and reversible without a migration.
