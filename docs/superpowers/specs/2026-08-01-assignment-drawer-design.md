# Assignment Drawer and Roster Presentation Design

## Status

Approved in conversation on August 1, 2026. This design supersedes the dedicated Assign-page layout and the assignment-screen clipboard decisions in `2026-07-29-assign-screen-ux-design.md`. It does not authorize implementation until this written spec is reviewed.

## Context

The assignment workflow is functionally correct, including guarded repeatable Skip, Void, audit logging, realtime roster refresh, and rotation locking only after submission. The remaining problem is structural: Assign occupies a dedicated page even though it is a short operational action that depends on the same roster and dashboard data shown elsewhere.

The current result card also overemphasizes the customer, exposes redundant phone-copy behavior, and presents served reps in ranking order. Because Skip removes the rep's up while preserving their served cycle slot, the skipped rep can move unexpectedly into the middle of `Served This Round`.

## Goals

- Remove the dedicated Assign page and expose assignment as a global BDC+ action.
- Keep the form and live round-robin roster together in one accessible drawer.
- Preserve all assignment, rotation, permission, audit, realtime, Skip, and Void behavior.
- Make the assigned rep the dominant element in the success state.
- Make skipped reps understandable without exposing Skip reasons outside Audit Log.
- Remove assignment-screen clipboard behavior while preserving useful phone-copy controls on Rep Dashboard assignment records.
- Keep closing the drawer simple: close means discard the local drawer state and start fresh next time.

## Selected approach

Use one wide assignment drawer containing both the working area and the live roster. This replaces both the dedicated Assign page and the rejected two-overlay approach of opening a modal and a separate roster shelf simultaneously.

The single drawer is preferred because it has one focus boundary, one close behavior, and one responsive layout. It keeps Team Dashboard as the normal work surface while making Assign available from the header.

## App-shell behavior

- Team Dashboard becomes the normal landing screen for BDC, Manager, and Admin users.
- The dedicated Assign navigation item and Assign page route are removed.
- A prominent `Assign lead` button appears in the global header for users with `lead.assign` permission.
- The button opens the assignment drawer over the user's current screen. Closing the drawer returns to that same screen.
- When Admin View-as is active, the drawer is not actionable. The UI must not expose a form that server-side read-only enforcement will reject.
- Rep accounts do not see the Assign action.

## Drawer lifecycle

### Opening

- Opening loads the current roster and focuses Customer name.
- Opening does not acquire the rotation advisory lock and does not reserve a rep.
- The drawer starts in a clean assignment-form state every time it is opened.

### Assignment form

- Fields remain Customer name, Phone, and optional Notes.
- The primary action stays beneath the form, where it follows the entry flow naturally.
- The button names the current target when available, for example `Assign to Frederick Tellis`.
- Existing validation, Enter field progression, and `Ctrl+Enter` submission remain.
- Submission uses the existing assignment mutation and only then enters the locked server transaction.

### Successful assignment

- The working area transforms from the form into an assignment confirmation; no additional confirmation step is introduced.
- The assigned rep's name is the largest and most prominent text.
- Customer name and formatted phone appear together beneath the rep.
- Assignment time appears as supporting information.
- Only Skip and Void actions appear in this result state.
- The drawer remains open for as long as the BDC needs to learn whether the rep accepts the lead.
- The roster updates through the existing refresh and realtime paths.

### Successful Skip

- The existing lead passes to the next eligible rep, and the result state updates in place to emphasize the new rep.
- No post-Skip acknowledgement or second confirmation is added.
- Skip remains available for another deliberate pass.
- Existing expected-rep, idempotency, permission, ownership, audit, and transaction protections remain unchanged.

### Closing

- Close and idle-state Escape dismiss the drawer without a warning.
- Closing clears the form, result, Skip, Void, and local error state.
- Reopening always starts a new assignment; no unresolved-assignment header indicator or restored confirmation is added.
- Dashboard ups continue to update through their existing data path. Closing the drawer does not create a separate dashboard confirmation card or toast.
- The drawer cannot close while Assign, Skip, or Void is in flight.

## Skip reasons

The Skip dialog keeps the named-rep review and explicit confirmation but replaces free-text-only entry with fast preset choices:

- Rep unavailable
- Rep already assisting a customer
- Customer requested another rep
- Manager-directed pass
- Other

Selecting a preset does not submit immediately. The BDC selects a reason and then confirms `Skip rep and pass lead`. `Other` reveals required detail before confirmation can be enabled.

The implementation may continue sending the existing `reasonNote` string, using the preset label or `Other: <detail>`. No database migration is needed. Full reasons remain visible only in Audit Log and are never returned in roster data.

## Roster presentation

The four existing non-leaky buckets remain:

1. Next Up
2. On Deck
3. Served This Round
4. Unavailable

Core `rankReps` ordering remains authoritative for assignment selection, Next Up, On Deck, and Unavailable. The redesign changes presentation ordering only inside `Served This Round`.

Within `Served This Round`:

- All reps stay in one bucket.
- Skipped reps appear first.
- Each skipped rep receives a compact yellow `Skipped` badge.
- Skipped rows use the same neutral row styling as other served reps; there is no full-row highlight.
- Normally served reps follow the skipped reps.
- Each subgroup is ordered by its cycle service time from earliest to latest, with rep ID only as a deterministic final tie-breaker.
- The displayed ups-MTD value remains the actual counter value, so a skipped rep may correctly show zero ups.
- Skip reasons do not appear in the roster.

This separates business ranking from historical presentation. A skipped rep's counter change can no longer reposition them unpredictably among normally served reps.

## Roster data contract

The board roster response gains presentation-only metadata:

- `servedAt: string | null`, derived from the active cycle's `rr_cycle_assignments.assigned_at`.
- `skippedThisCycle: boolean`, derived from a `SKIP` ledger event for that rep in the active cycle.

The response must not include Skip reason text. These fields are added after ranking is computed; they do not enter `RepRankInput` and cannot affect assignment order.

No database migration is expected. The required service timestamp already exists on `rr_cycle_assignments`, and Skip events already exist in the append-only assignment ledger.

## Clipboard boundary

Remove all assignment-workspace clipboard behavior:

- No automatic phone copy after assignment.
- No `Copy phone` button in the confirmation.
- No assignment-workspace `Alt+C` shortcut or copied-phone notice.

Phone-copy controls remain on assignment records shown in Rep Dashboard and Rep Detail, where the number is needed for follow-up work.

## Component boundaries

The current `AssignScreen.tsx` owns too many independent responsibilities for the drawer design. Refactor only along the new interaction boundaries:

- `AssignmentDrawer`: open/close lifecycle, focus boundary, reset behavior, and high-level state transition.
- `AssignmentForm`: field validation, keyboard progression, and assignment submission.
- `AssignmentResult`: rep-first success hierarchy plus Skip and Void entry points.
- `RosterPanel`: roster loading, four-bucket rendering, and presentation-only served ordering.
- `SkipDialog`: preset selection, `Other` detail, confirmation, and inline errors.

The exact filenames may follow the existing web component conventions, but these responsibilities must remain independently testable. Do not refactor unrelated pages or introduce a new state-management dependency.

## Error behavior

- Assign, Skip, and Void disable their controls while submitting.
- Mutation errors remain in the drawer, use the shared friendly error translator, and preserve the user's actionable input.
- A failed Skip keeps the selected reason available for correction or retry.
- Duplicate-phone and no-eligible-rep guidance remains in the result state.
- Roster refresh continues to distinguish stale last-good data from a total load failure and retains Retry.
- A stale or repeated Skip remains harmless through the existing expected-rep and idempotency checks.
- Closing while idle intentionally discards unsaved form input without an extra warning.

## Accessibility and responsive behavior

- The drawer is one modal focus boundary with an accessible name.
- Background content becomes inert while the drawer is open.
- Idle-state Escape closes the drawer; focus returns to the header `Assign lead` button.
- During an in-flight mutation, close and Escape are disabled.
- Keyboard assignment behavior remains intact, and every Skip preset is reachable and identifiable without color.
- The `Skipped` label supplements the yellow badge color.
- On narrow screens, the drawer becomes a full-screen workspace. The form/result precedes the roster in reading order, and both remain reachable without horizontal page overflow.
- Reduced-motion preferences disable nonessential drawer animation.

## Expected implementation surfaces

- `apps/web/src/App.tsx`: Team Dashboard landing behavior, header action, dedicated Assign-page removal, and drawer mounting.
- `apps/web/src/pages/AssignScreen.tsx`: refactor existing assignment behavior into drawer-oriented components and remove clipboard behavior.
- `apps/web/src/pages/AssignScreen.test.ts`: preserve helper coverage and add drawer, result, Skip-preset, and served-order tests.
- `apps/web/src/styles/ui.css`: drawer, responsive, confirmation hierarchy, and compact badge styling.
- `apps/api/src/routers/board.ts`: add presentation-only active-cycle service metadata without changing ranking.
- Relevant board-router and web tests for the enriched roster response.
- `docs/Revised consolidated action list.md`: record the superseding Priority 2/3 design status when implementation is completed and verified.

This list is directional rather than permission to touch every file. Implementation must use the smallest set of files that satisfies the approved behavior.

## Verification

### Automated

- Contract/type tests for the enriched roster response where needed.
- Board-router tests proving `servedAt` and `skippedThisCycle`, including that reason text is absent.
- Core ranking tests proving ranking remains unchanged.
- Web tests covering:
  - header permission and View-as behavior;
  - drawer open, close, reset, focus return, and in-flight close prevention;
  - assignment form and rep-first result transition;
  - removal of automatic copy, Copy button, copied notice, and `Alt+C`;
  - preset Skip choices, required `Other` detail, deliberate confirmation, repeated Skip, and error retention;
  - one `Served This Round` bucket with skipped-first presentation, badge-only styling semantics, and chronological subgroup ordering;
  - responsive/full-screen drawer rules.
- Workspace type checking, web lint, production web build, and `git diff --check`.

### Browser

Run an authenticated local BDC flow:

1. Start on Team Dashboard.
2. Open Assign from the header and confirm focus enters Customer name.
3. Assign a lead and verify the rep-first result, customer plus phone, live roster update, and absence of clipboard behavior.
4. Skip using a preset and verify the same lead passes, the drawer stays open, and the skipped rep appears at the top of `Served This Round` with only the yellow badge.
5. Open another Skip, verify repeatability and confirmation safeguards, then cancel.
6. Close and reopen the drawer and verify a clean assignment state.
7. Verify narrow-screen full-screen behavior and keyboard focus restoration.

Also inspect the dashboard ups list after closing to confirm the existing count update remains intact.

## Preserved behavior

- Assignment selection and `rankReps` business rules.
- Advisory-lock timing and transaction boundaries.
- Same-lead Skip semantics and repeatability.
- Rep remains consumed in the relevant round after Skip.
- Skip/void permissions, BDC ownership rules, Manager/Admin override, audit events, and idempotency.
- Duplicate and unassigned guidance.
- Realtime roster/dashboard updates.
- Rep Dashboard and Rep Detail phone-copy controls.

## Out of scope

- Redesigning Team Dashboard content or metrics.
- Consolidating Staff List, User Management, Audit Log, Import Activity, or Rep Detail in this pass.
- Changing assignment ranking, monthly counter semantics, Skip ledger accounting, or cycle boundaries.
- Adding persistent unresolved-assignment state, a dashboard assignment card, or a new notification system.
- Showing Skip reasons anywhere except Audit Log.
- Database schema changes or new frontend dependencies.
- Deployment or production verification.

## Acceptance criteria

The design is implemented successfully when a BDC can complete the existing assignment workflow from a single header-opened drawer, wait in the rep-first result state, deliberately Skip or Void, close back to the underlying screen, and reopen a clean drawer. The roster must preserve core assignment ranking while presenting skipped reps first inside one neutral `Served This Round` list with badge-only identification and no reason leakage. Assignment-workspace clipboard behavior must be absent, dashboard ups must remain correct, and all automated and browser checks above must pass or have a specific documented external blocker.
