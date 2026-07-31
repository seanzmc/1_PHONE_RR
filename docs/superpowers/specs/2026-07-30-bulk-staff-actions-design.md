# Bulk staff actions and preset reasons — design

Queue items 1 and 2. They ship together: a bulk action needs a reason, and the reason
modal is what item 2 changes.

## Problem

The Staff List gives a manager three per-row buttons — Reactivate, Deactivate, Follow
schedule — each opening a modal with a required free-text reason. Two things are wrong
with it day to day.

**Post-ship correction:** Follow schedule was removed before this shipped to production.
It was redundant once bulk actions existed, and its disabled-rule could never actually
hold — `upsertOverride` hardcodes `decidedBy: 'MANAGER_OVERRIDE'`, so after applying it
the rep still read as manager-decided and the button never disabled. The tables below are
corrected to match what shipped: two status actions, not three.

Sitting down five reps after a bad call day is five separate modals and five typed
reasons. There is no way to act on a group.

Every button opens a modal, including when it cannot accomplish anything. Clicking
Deactivate on a rep who is already ineligible prompts for a reason and then writes an
override that changes nothing a manager can see. Clicking Reactivate on an eligible rep
does the same. The prompt implies a decision is being made when none is.

## Scope

In: multi-select on the Staff List, a bulk apply for all three status actions, preset
reasons replacing free text, and disabling buttons that would be no-ops.

Out: the Staff List's active/inactive bucketing and the disabled-account filtering
(queue item 10), the days-off Save button (item 3). Those are separate passes over the
same screen and are specified separately.

## Server

### `rep.bulkOverrideStatus`

New mutation on the rep router, permission `rep.override`, input:

```ts
{
  repIds: string[]        // 1..200, uuid, deduped
  status: 'FORCE_ACTIVE' | 'FORCE_INACTIVE'
  reasonCode: string      // preset key, or 'OTHER'
  reasonNote: string      // preset label, or the manager's text when OTHER
}
```

Returns `{ applied: string[], skipped: string[] }` so the client can report what actually
happened rather than assuming.

**One transaction, one advisory lock, for the whole batch.** Not one call per rep from the
client. Status changes reorder the rotation, so they take `pg_advisory_xact_lock(42_100_1)`
like every other ordering-changing path; N separate transactions would mean a partial apply
is a reachable outcome and would take and release the lock N times while a BDC agent waits
to assign a lead.

Structurally this means extracting the body of `overrideStatus` into an
`applyOverrideStatus(tx, input)` that assumes it is already inside a locked transaction.
`overrideStatus` becomes a thin wrapper that opens the transaction, takes the lock and
calls it once; `bulkOverrideStatus` opens one transaction, takes the lock once and calls it
per rep. There stays exactly one definition of what an override does.

**The no-op check is re-evaluated server-side, inside the transaction.** The client's
roster can be seconds stale. A rep whose status changed since the last render is skipped
and named in `skipped`, not applied blindly.

**One audit event per rep, not one per batch.** Item 5's audit screen and the existing
per-rep drill-down both query `rep.override` by `entityId`; a single batch-shaped event
would make a rep's own history incomplete. Each event carries the same `reasonCode` and
`reasonNote`, so a batch is still recoverable by grouping on actor and timestamp.

### `board.roster` returns `decidedBy`

The payload has `isEligible` and `ineligibleReason` but not who decided. Without it the
client cannot distinguish "ineligible because it is their scheduled day off" from
"ineligible because a manager sat them down", which is what the Follow schedule button
keys on.

Add it at the response layer, the same way `displayName` already works: build a
`decidedByRep` map alongside `nameById` in the router and merge it into the mapped result.
`RepRankInput` in `packages/core` is the ranking algorithm's input and stays untouched —
`decidedBy` is presentation, and the ranking core has no business reading it.

Value is `rep_daily_status.decidedBy` for today, or `null` when the rep has no row.

## Client

### No-op rule

A button is rendered disabled rather than opening a modal:

| Button | Disabled when |
|---|---|
| Reactivate | rep is already `ELIGIBLE` |
| Deactivate | rep is already `INELIGIBLE` |

Each disabled button carries a `title` saying why, so the state is explainable on hover
rather than just dead.

The rule is deliberately about the visible status, not about whether the write would
technically differ. A consequence: a rep who is ineligible today only because it is their
scheduled day off has Deactivate disabled, so they cannot be suspended through Saturday
while they are out — that is done the next day they are in. Accepted; the simpler rule is
worth more than the edge case.

### Selection

A leading checkbox column, plus a select-all checkbox in the header that reflects an
indeterminate state on a partial selection. Selection is component state keyed by `repId`,
and is dropped for any rep no longer in the roster after a refresh — the list refreshes on
every board realtime event, and a stale id would silently widen a later batch.

The per-row buttons stay. A one-rep change should not require selecting a row first.

### Bulk toolbar

Appears only when the selection is non-empty. Shows the count and the three actions. Each
bulk button applies the same no-op rule against the selection: enabled when at least one
selected rep would change, disabled when none would.

The confirm modal names the split — "Deactivate 3 of 5 selected" — and lists the skipped
reps so nothing is silently dropped. After the mutation returns, the result is reported
from `applied`/`skipped`, which may differ from the preview if the roster moved underneath.

### Reason presets

The free-text `Textarea` becomes a `<select>` of presets. `reasonCode` gets the preset key
— today it is set to the status string, which is redundant with the status field and makes
the code useless for grouping. `reasonNote` gets the preset's label.

Choosing Other reveals the textarea, and the note is required; the submit stays disabled
until it is non-empty. Every other preset submits with no typing.

| Status | Presets |
|---|---|
| Deactivate | Below call minimum · Called out / absent · PTO · Training · Disciplinary · Other |
| Reactivate | Suspension lifted early · Absence resolved · Deactivated in error · Other |

The lists live in one module-level constant keyed by status, shared by the per-row and bulk
modals so the two cannot drift.

### Toolbar cleanup

`Generate 14 days of shifts` is removed. `materializeShifts` runs weekly via cron
(`0 3 * * 0`), new reps materialize on creation, and `pnpm --filter @phoneup/api
materialize-shifts` covers the post-roster-import case the button existed for. The bulk
toolbar takes its place.

## Errors

A bulk apply is atomic: any rep failing rolls the whole transaction back and the client
reports the failure with nothing applied. Partial success is not a state a manager should
have to reason about, and the lock is already held for the whole batch.

The existing inline `ui-error` paragraph carries the message. Selection is preserved on
failure so the manager can retry without re-picking.

## Testing

Domain, against the test database:

- Bulk apply writes one `status_override`, one `rep_daily_status` row per date through
  Saturday, and one audit event per applied rep.
- A rep already at the target status is skipped: no override row, no audit event.
- A mixed batch applies the changeable reps and skips the rest, and the returned
  `applied`/`skipped` match what was written.
- `FORCE_ACTIVE` in a batch clears each rep's `SYSTEM` `INELIGIBLE` tail, and leaves
  another manager's explicit future decision alone — the single-rep guarantee holds per rep
  in a batch.
- A failure mid-batch leaves the database unchanged.

The lock itself is not re-tested here. `assignLead.concurrency.test.ts` already exercises
`ADVISORY_LOCK_KEY`, and the batch reaches it through the same `pg_advisory_xact_lock` call
on the same key — a bulk-specific race test would either duplicate that coverage or pass
vacuously when the batch leaves no eligible rep for the racing assign to find.

Client, pure functions extracted for test as `AssignScreen.test.ts` does:

- The no-op predicate per status against each roster shape (eligible, ineligible by system,
  ineligible by manager override, no status row).
- Selection reconciliation drops ids missing from a refreshed roster.
- The bulk split — which selected reps are applied versus skipped for a given status.

## Documentation

`CLAUDE.md` gains a line under the architecture section: bulk status changes go through one
transaction and one advisory lock, and the no-op rule is on visible status.

`docs/RUNBOOK.md` line 345 offers "Staff List → Generate shifts" as a fix for
`CONFIGURATION_ERROR`. That button is going away, so the row keeps only the
`materialize-shifts` CLI remedy.
