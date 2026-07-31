Queue for this round

Status as of 2026-07-31. Items 1 and 2 are built, reviewed and merged to `main`
(merge commit of `feat/bulk-staff-actions`, 12 commits). Everything below the
"Remaining" heading is still open.

## Done

1. ~~Bulk activate/deactivate on Staff List, replacing the shifts button~~ — merged.
2. ~~Preset reasons + Other; no prompt when status wouldn't change~~ — merged.

Shape of what landed: one shared `isOverrideNoOp` rule in `packages/core`,
`rep.bulkOverrideStatus` applying every rep inside a single transaction under a
single advisory lock, per-row and bulk modals both surfacing mutation errors
inside the modal, and `board.roster` now returning `decidedBy`.

`FOLLOW_SCHEDULE` was dropped from the application surface as part of this
(core, contracts, API domain, Staff List UI). Its disabled-rule was
unsatisfiable — `upsertOverride` hardcodes `decidedBy: 'MANAGER_OVERRIDE'`, so
the rep still read as manager-decided after applying it and the button never
disabled. The Postgres enum and Drizzle schema keep the value so historic rows
stay readable; no migration. The day-off half of the old shifts button is
**not** covered by this and is now item 3 below, needing its own spec pass.

## Remaining

3. Days off: Save button, gate on all-week. Needs its own spec pass — this is
   what the dropped shifts button used to reach, and nothing replaced it.
4. View-as picks a real rep
5. Master audit log screen
6. Nav hub; logout and change-password behind a menu
7. Back from rep detail returns to Staff List
8. Sortable Users and Staff lists
9. Assign screen: Enter→notes, required markers, remove `tel:` link, reassign past Alt-V
10. Deactivated accounts leak into every list. A user with a disabled login should
    disappear from Staff List, Assign screen roster, dashboards and drill-downs —
    appearing only on the Users page, in a separate "Inactive" group below the
    active ones.

One thing to be careful about: this app has two different "deactivated" states
that the UI currently blurs together.

Account disabled (`app_user.is_active = false`) — can't log in, shouldn't appear anywhere.
Rep inactive (`rep_daily_status = INELIGIBLE`) — still an employee, temporarily out of
rotation. Has to stay visible on the Staff List in the unavailable bucket, otherwise I
can't see who's sitting out or put them back.

So the rule is "hide disabled accounts everywhere," not "hide anyone marked
inactive" — collapsing those two would make deactivated reps vanish and become
unreactivatable. Verify which of the two each list is currently filtering on
when you start.

## Carried debt from the items 1–2 pass

**`apps/api/src/routers/board.test.ts` leaks fixture rows.** It has a `beforeAll`
that inserts 3 `app_user` + 3 `sales_rep` rows and no `afterAll`. It is the only
API test file that adds reps without deleting them, and that accumulation is what
produced a `voidLead` flake during the build session. CI uses a throwaway
Postgres so this is local-only. One `afterAll` closes it — not yet written.

**Dev database residue.** `phoneup_dev` holds one `status_override` row and its
audit event against fixture rep `Preview Override 1785392789989…`, left by manual
verification. Audit is append-only by design, so it was not deleted.

## Not verified — needs a human eye or a working Playwright

Playwright's browser profile was locked by another session on this machine, so
no DOM-level behaviour on the Staff List was exercised in a real browser:

- checkbox column alignment
- indeterminate select-all
- disabled-button rendering

Read-only review cleared two of the likely failure modes: `Table` keys headers by
index (so the spread-not-ternary header cell is fine), and `.ui-btn:disabled` does
not set `pointer-events: none` (so tooltips on disabled buttons still show). The
select-all indeterminate ref at `apps/web/src/pages/StaffList.tsx:272` is an
inline arrow, so React 19 detaches and reattaches it on every render and
`el.indeterminate` is recomputed each time — correct by reading, still unconfirmed
in a browser.

## Findings worth keeping

Both real defects this round originated in the plan, not the implementation.

1. The plan's rollback test could never have passed. An unknown rep id under
   `FORCE_INACTIVE` is a no-op by the shared rule, so no insert fires and no
   foreign-key violation happens. Caught by an implementer, not a reviewer. The
   fix — reject the whole batch on an unknown id — was better than what the plan
   specified, and review then caught that the fix hollowed out the test, so a real
   mid-batch rollback test replaced it.

2. `reasonNote` was derived from `pendingStatus`, which is always null while the
   bulk modal is open, so every preset except Other sent an empty string into a
   `z.string().min(1)` field — 8 of 11 presets dead on arrival. No suite covered
   it; only the plan's own manual browser step would have. Confirmed against the
   running dev server that an empty `reasonNote` is rejected with `too_small`,
   exactly what the pre-fix client sent.

Verified by hand against a real server and the dev database, using a throwaway
manager account since deleted: bulk apply with a preset reason lands; an immediate
replay returns `applied: []` / `skipped: [rep]`, proving the server-side re-check
inside the lock; unauthenticated calls get `UNAUTHORIZED`; the written row carries
`reason_code SUSPENSION_LIFTED` rather than echoing the status.

Working top-down. Next up is item 3.
