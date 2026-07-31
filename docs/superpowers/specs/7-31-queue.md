Queue for this round

Status as of 2026-07-31. All queued implementation items are complete in the working
tree. Items 1 and 2 were previously reviewed and merged to `main` (merge commit of
`feat/bulk-staff-actions`, 12 commits); the current round is not committed yet.

## Done

1. ~~Bulk activate/deactivate on Staff List, replacing the shifts button~~ — merged.
2. ~~Preset reasons + Other; no prompt when status wouldn't change~~ — merged.
3. ~~Days off: one recurring day off per rep~~ — `feat/one-recurring-day-off`. Landed as a
   narrower design than originally scoped, deliberately: this item as written assumed
   multi-select ("Save button, gate on all-week"), but the spec pass it needed (item 3's
   own note above) concluded a rep gets **at most one** recurring day off. That changes
   both things it asked for. A radio click is already a complete intent — there is nothing
   to batch before saving, so immediate-save-per-click stays correct and no Save button was
   built. "Every day off" is unreachable with a radio group rather than something to guard,
   so no all-week gate was built either. The Staff List's six day-off toggle buttons became
   a None + Mon–Sat radio group; the days-off column's per-rep N+1 query was folded into the
   same pass as a new batch query, `rep.allDaysOff`.

4. ~~View-as picks a real user profile~~ — ADMIN selects an active real account, and the
   server applies that account's identity, role permissions, and self-data scope to GET
   requests. View-as is deliberately read-only: any POST is rejected until the ADMIN exits.
5. ~~Master audit log screen~~ — a dedicated, paginated Audit Log page shows actor, time,
   action, entity and complete before/after JSON. `audit.view` is enforced server-side for
   ADMIN/MANAGER; BDC/REP are denied. Historic disabled actors remain identifiable there.

6. ~~Nav hub; logout and change-password behind a menu~~ — the signed-in identity now opens
   a native profile menu containing both account actions; they no longer occupy the main nav.
7. ~~Back from rep detail returns to its opening screen~~ — the app captures Assign, Staff
   List, or Dashboard before opening a rep and returns there instead of defaulting to Assign.
8. ~~Sortable Users and Staff lists~~ — Users sorts by name, email, role, or account status;
   Staff sorts by rep, rotation status, or ups MTD. Users now also uses Enable/Disable account
   terminology while Staff keeps Activate/Deactivate for round-robin eligibility.
9. ~~Assign and reassignment workflow~~ — Enter advances Name → Phone → Notes, then Enter
   assigns; Name and Phone have visible/semantic required markers; phone numbers render as
   plain text rather than `tel:` links. Managers/Admins can reassign any assigned lead,
   including older leads, through an advisory-locked REASSIGN_OUT/REASSIGN_IN ledger path.
10. ~~Disabled-account leakage~~ — operational rep selection now joins through active
    `app_user` rows for assignment, roster, Staff, dashboard, rep drill-downs, days off,
    eligibility/materialization and activity import. Users alone shows disabled accounts in
    a separate Inactive accounts bucket. Active-but-INELIGIBLE reps remain visible.

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

None.

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

~~`apps/api/src/routers/board.test.ts` leaked fixture rows.~~ It now deletes its fixture
statuses, reps and users in `afterAll` while holding the assignment advisory lock, so cleanup
cannot race another test that selected those reps inside an assignment transaction.

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

Item 3 adds to that list, for the same reason — the profile is still locked. From
the day-off pass, nothing below has been seen render:

- the None + Mon–Sat radio group, and that a row's radios are scoped to that row
  (the `name` is `day-off-<repId>`, so a click in one row must not clear another's)
- a selection saving with no Save button, and surviving a reload
- the `—` placeholder shown while `rep.allDaysOff` is still in flight or has failed
- the "Thu, Fri stored — pick one" note for a rep holding more than one legacy day
- the optimistic rollback and error banner when the mutation fails
- the profile menu opening and its Change password / Log out actions
- Back returning to each of Assign, Staff List and Dashboard
- Users and Staff sort controls toggling direction
- the assign form's Enter sequence (Name → Phone → Notes → assign)
- real-profile view-as navigation and read-only banner across all four roles
- the Audit Log page rendering and pagination controls
- Users' enabled/inactive account buckets
- manager reassignment modal and post-submit refresh

`apps/web` runs vitest with `environment: 'node'` and every case in
`StaffList.test.ts` tests an exported pure function, so none of this is reachable
from the suite either. The pure parts — `selectedDayOff`, `dayOffPayload` — are
covered; the rendering is not.

Two of those were reached by reading rather than running, during the final review:
the "not loaded" state used to render the None radio *checked*, which would have
suppressed the "pick one" note and let a click silently discard a legacy rep's two
days. Fixed before merge. That defect sat squarely in the unverified region — the
gap is not theoretical.

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

Final automated verification for this working tree: `pnpm run test` (240 tests passed),
`pnpm run typecheck`, and `pnpm run build`. The browser-only items above remain explicitly
unverified until a logged-in browser session is available.
