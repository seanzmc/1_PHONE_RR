# UI Critique — 2026-07-31

I've read all 8 pages, the shared UI components, and the server messages that surface raw into the UI. Here is the full audit, ranked by impact on the core loop (assign correctly in seconds) and on dead ends.

────────────────────────────────────────────

## TIER 1 — CORE LOOP + HARD DEAD ENDS

────────────────────────────────────────────

1. AssignScreen — invalid input produces raw server JSON, not guidance
   Location: apps/web/src/pages/AssignScreen.tsx:118-141, 227
   The form has no client-side validation and the Assign button is never disabled. Empty name or a 9-digit phone hits the Zod schema (packages/contracts/src/schemas.ts:5-6) and tRPC returns the stringified issues array, which renders verbatim as the error. A BDC agent mid-call sees a JSON blob at the worst possible moment.
   Fix: validate before submit, disable Assign until valid, and show inline errors:
   - Name empty: "Enter the customer's name."
   - Phone: "Enter the 10-digit phone number — we add the +1 for you."
     Add placeholders to encourage interaction: name "Customer name", phone "(555) 123-4567", notes "Anything the rep should know before calling".

2. AssignScreen — a failed roster load renders as a false "nobody is available"
   Location: apps/web/src/pages/AssignScreen.tsx:77
   loadRoster().catch(() => {}) is silent. On a network/API failure the buckets render the empty-state copy ("No eligible unserved rep — the next lead queues as unassigned.", "Everyone is available.") which is actively wrong guidance — it reads as truth, not as a failure.
   Fix: track loadError and replace the roster column with:
   "Couldn't load the roster — check your connection." + Retry button.
   Same silent-catch pattern exists at Dashboard.tsx:16, StaffList.tsx:148, RepDetail.tsx:74-78, UserManagement.tsx:42. Fix the class, not just this site.

3. Rep "My Dashboard" — no answer to the only question a rep has
   Location: apps/web/src/pages/RepDetail.tsx:153-168
   A rep sees five month-to-date metrics but nothing about today: am I in the rotation? why was I skipped? what do I do about it? The truth model exists precisely to answer "why wasn't I next", and the rep-facing screen doesn't surface any of it. CLAUDE.md's role table also lists "submit reactivation requests" as a REP capability — there is no UI for it anywhere, so a deactivated rep hits a complete dead end.
   Fix: add a today-status card at the top, above the metrics:
   - Eligible: "You're in today's rotation. Ups go to the next unserved rep in line."
   - Ineligible: "You're not in rotation today — {reason}. Suspensions run through Saturday. Think this is wrong? Talk to your manager."
   - If they have a recurring day off: "Your recurring day off: Thursday."
     If reactivation requests aren't being built yet, the "talk to your manager" line is the interim fix — the current screen says nothing at all.

4. Login — the most common support moment has no exit
   Location: apps/web/src/pages/Login.tsx
   - Server's "invalid credentials" renders raw. Suggest mapping it to: "Email or password didn't match — passwords are case-sensitive. Forgot it? A manager can reset it from the Users page."
   - The throttle message "try again in N minute(s)" is dev-speak; pluralize client-side: "Too many failed attempts — try again in about N minutes."
   - No first-day guidance. Add under the h1: "First time signing in? Use the temporary password you were given — you'll choose your own right after."
   - Missing autocomplete="username" / "current-password" (ChangePassword has them; Login doesn't). Free password-manager support.

────────────────────────────────────────────

## TIER 2 — DEAD-END OR CONFUSING STATES ON WORKING SCREENS

────────────────────────────────────────────

5. AssignScreen — success card teaches nothing, warnings dead-end
   Location: apps/web/src/pages/AssignScreen.tsx:233-254
   - Auto-copy is silent. Add: "Number copied — Alt+C copies it again." Teaches the two shortcuts before the user needs them.
   - "Warning: this phone number already exists." → what now? Suggest: "This number is on another lead. Repeat caller? You're fine. Entered twice by mistake? Void this one below." Turns a warning into a decision.
   - "No eligible rep — lead queued as unassigned." → no next step, and nothing in the app surfaces the unassigned queue. Suggest: "Saved to the unassigned queue — no rep is eligible right now. Flag a manager so this lead doesn't sit."
   - Next Up empty state (line 268): same fix — "...A manager can reactivate someone from the Staff List." for roles that can; "tell your manager" for BDC.

6. StaffList — the one-day-off limit (this branch) fails with dev text; bulk actions are invisible
   Location: apps/web/src/pages/StaffList.tsx:240-252, 290-319
   - The new limit throws "a rep can have at most one recurring day off, got 2: 2, 4" (apps/api/src/domain/daysOff.ts:33) which renders raw. Better: prevent it client-side — when a rep already has a day set, disable the other weekday buttons with title "One recurring day off per rep — clear {day} first", and add a hint under the column header: "Reps are automatically out of rotation on their day off each week. One per rep."
   - The bulk bar only appears after discovering the checkboxes. Add a persistent muted hint when nothing is selected: "Select reps with the checkboxes to deactivate or reactivate several at once."
   - Existing good copy worth keeping: the no-op tooltips, the named-skips list, "Applies through the end of the business week (Saturday)."

7. Import Activity — strong screen, three cryptic labels remain
   Location: apps/web/src/pages/ActivityImport.tsx:352-403
   This is the best-guided flow in the app. Remaining jargon in the summary table:
   - Badge "0 unless manually corrected" → plain sentence: "No numbers in this file for these reps — correct on their page if they actually worked."
   - "Manual rows preserved" → "Hand-entered corrections kept — this file did not overwrite them."
   - "Unmatched names / not imported" → add "…matched on display name; check the spelling against the Staff List."
   - After a deactivation commit, the success card could point onward: "Suspensions run through Saturday — lift one early from the Staff List."

8. UserManagement — two reset paths with indistinguishable names; hints undersell the flow
   Location: apps/web/src/pages/UserManagement.tsx:179-187, 239
   - "Reset password" (generates a temp password) vs "Set manually" (type one yourself) — rename to "Generate temp password" and "Set password…" so the difference is visible before clicking.
   - Add account, "Initial password" hint: the server sets mustChangePassword (userManagement.ts:42) but the hint only says "Minimum 8 characters." Suggest: "Minimum 8 characters. They'll be forced to pick their own at first sign-in, so keep this one simple."
   - "Set name" (line 154) is styled like an affordance but isn't clickable. Change to muted "(no display name)".

9. Nav — "My Dashboard" and "Dashboard" are near-identical labels for different screens
   Location: apps/web/src/App.tsx:66, 83
   A manager sees both. Rename the manager audit view to "Team Overview" (or "Team Board") and keep "My Dashboard" for the personal view.

────────────────────────────────────────────

## TIER 3 — POLISH

────────────────────────────────────────────

10. Manager Dashboard — metric cards lack definitions; drill-in is undiscoverable
    Location: apps/web/src/pages/Dashboard.tsx:26-56
    - Add hints: Ineligible today → "Reps out of rotation today, for any reason." Overrides today → "Manager status changes made today." Cycle progress → "The cycle restarts once everyone has been served."
    - "Ups per rep" names are clickable but nothing says so. Add a muted line: "Click a name for their full month."
    - Also: the catch is silent (Tier 1, item 2) — a failed load here shows "Loading…" forever.

11. RepDetail — empty states describe, don't guide; note field has no prompt
    Location: apps/web/src/pages/RepDetail.tsx:172-174, 217-219, 195-199
    - "No leads assigned through the app this month." → "No ups yet this month — new phone-ups appear here as they're assigned."
    - "No activity imported for this month yet." → "Call numbers appear here after the daily CRM import."
    - Note textarea: add placeholder "Note for this lead…" — an empty box with no prompt gets no interaction.
    - "Copied" state (line 184) sticks indefinitely; reset after ~2 seconds.

12. ChangePassword — good forced copy; small gaps
    Location: apps/web/src/pages/ChangePassword.tsx
    - Voluntary change gives no success confirmation — it just navigates away. Show a brief "Password updated" state before onDone, or a notice on arrival.
    - Consider one line of strength guidance beyond length ("A short phrase works better than a word with symbols.") — optional.

────────────────────────────────────────────

## GLOBAL PATTERNS (fix once, apply everywhere)

────────────────────────────────────────────

A. Error copy is passed through raw everywhere (err.message → ui-error). Add one small map in apps/web/src/lib (e.g. errorCopy.ts) translating known server messages: "invalid credentials", "void window has closed for this business day", "can only void your own leads", the day-off limit, "no sales_rep record for this user". Everything else falls through to the raw message. That single helper upgrades every screen at once.

B. Every roster/summary load has a silent .catch — failure states currently masquerade as empty states (the worst UX lie in the app, see item 2). One shared "load failed — Retry" pattern covers all five sites.

C. Small a11y wins: autocomplete attrs on Login, inputmode="tel" on the phone input, aria-live="polite" on the Just Assigned card (it's the confirmation of the app's one critical action).

D. What's already good and shouldn't change: the Import preview/commit copy, the temp-password modal ("Shown once…"), the void modal's "goes straight back to this rep", the FORCE_ACTIVE suspension hint, the modal keyboard hints, and the dead-button tooltips. This app's weak spots are concentrated in error paths and empty/failure states, not in the happy-path flows.

Top 3 by impact if you want to triage: item 1 (raw Zod JSON in the core loop), item 2 (silent failures rendering as truth), item 3 (rep dead end). Want me to implement the top tier as one commit per task?

## Hermes Orchestrator Independent Review — 2026-07-31

### Method and coverage

Three independent reviewers completed source-first visual/interaction, role/workflow, and accessibility/implementation passes without reading the critique above. Their evidence was then compared with the existing numbered findings and checked against the current frontend, contracts, server paths, and design-system source.

Browser coverage used the current production bundle with a local, non-persistent in-memory fixture API; it did not write to PostgreSQL. True CSS viewports were captured at 1440×900, 1024×768, and 390×844. Rendered states included Login; forced password change; BDC Assign validation, success, duplicate warning, copy controls, and Void modal; ADMIN Assign, View as, Staff List, Team Dashboard, Import Activity initial state, Users, and Audit Log; MANAGER navigation; and the REP dashboard. The existing local Vite process was also checked directly; its blank-page failure is reported below. Reviewer checks additionally ran the web build, 54 web tests, typecheck, and lint (warnings only).

### Confirmed findings

- **Items 1 and 2 are no longer current in their original form.** Assign now performs readable client validation and disables invalid submission (`apps/web/src/pages/AssignScreen.tsx:37-49,154-181,250-295`). Completed roster failures now show explicit retry/stale-data states instead of silently claiming nobody is available (`AssignScreen.tsx:103-118,326-340`), and Dashboard, Staff List, Rep Detail, and Users have equivalent load-error handling. A separate initial-loading gap remains and is listed as net-new.
- **Item 3 is substantially addressed.** Rep Detail now leads with today's eligibility, reason, recurring day off, and role-appropriate manager guidance (`apps/web/src/pages/RepDetail.tsx:70-89,257-290`). The interim “talk to your manager” path exists; no reactivation-request UI was found.
- **Item 4 is confirmed.** Login still passes server error text through, omits first-day/recovery guidance, and lacks `autocomplete="username"` / `autocomplete="current-password"` (`apps/web/src/pages/Login.tsx:11-18,21-35`).
- **Item 5 and Global C are confirmed.** The success card still does not identify the customer or time, duplicate/unassigned warnings still stop short of a next action, and assignment/copy outcomes are not live-announced (`apps/web/src/pages/AssignScreen.tsx:298-319`). The rendered BDC flow made the ambiguity visible immediately after submission.
- **Item 6 is partially confirmed.** Bulk actions remain undiscoverable until a checkbox is selected (`apps/web/src/pages/StaffList.tsx:353-386`). The day-off editor now uses one radio group per rep and surfaces ambiguous stored data rather than allowing a multi-day selection (`StaffList.tsx:105-113,430-477`), so the original raw one-day-limit path is no longer the normal UI behavior.
- **Items 7, 8, and 9 are confirmed.** Import summary jargon remains (`apps/web/src/pages/ActivityImport.tsx:332-404`); “Reset password” versus “Set manually” and the underspecified initial-password hint remain (`apps/web/src/pages/UserManagement.tsx:225-235,302-345`); and MANAGER/ADMIN still see both “My Dashboard” and “Dashboard” (`apps/web/src/App.tsx:80-103`).
- **Items 10–12 are partially confirmed.** Dashboard metric definitions and drill-in affordance, Rep Detail empty-state/copy behavior, and voluntary password-change confirmation remain weak (`apps/web/src/pages/Dashboard.tsx:45-81`; `apps/web/src/pages/RepDetail.tsx:293-369`; `apps/web/src/pages/ChangePassword.tsx:24-36`). The Dashboard's former endless-loading failure is fixed.

### Net-new findings

No P0 issue was found: the reviewed client defects do not change the server's authoritative assignment transaction or ranking result.

#### P1 — Assign shows a false empty roster before the first response

- **Screen and affected role:** Assign; BDC, MANAGER, and ADMIN.
- **State or viewport:** Initial load or a slow first roster request; all widths.
- **Evidence:** `roster` starts as `[]`, with no `rosterLoading` state (`apps/web/src/pages/AssignScreen.tsx:80-118`). That value is immediately bucketed (`:238-240`) and rendered as “No eligible unserved rep” plus “Everyone is available” (`:334-351`); assignment is gated only by form validity (`:293-295`).
- **What happens now:** Unknown roster state is presented as authoritative empty-state copy, and a valid form can be submitted before the first roster snapshot arrives.
- **User impact:** A BDC agent can hesitate or act while the UI is making mutually misleading claims about availability. The server still chooses correctly, so this is a serious confidence/decision defect rather than assignment corruption.
- **Smallest appropriate recommendation:** Add an explicit first-load state, show “Loading roster…,” and disable every submit path until one roster request succeeds. Preserve the existing stale-last-good and Retry behavior for later refresh failures.
- **Confidence:** High.

#### P1 — Assignment has no in-flight state

- **Screen and affected role:** Assign; BDC, MANAGER, and ADMIN.
- **State or viewport:** After valid submission while `assignment.assign` is pending; all widths.
- **Evidence:** `handleAssign` awaits the mutation without a busy flag (`apps/web/src/pages/AssignScreen.tsx:154-181`); click, Ctrl+Enter, and Notes Enter remain available (`:184-210,293-295`).
- **What happens now:** The button continues to say “Assign,” the fields remain editable, and repeated keyboard activation can send repeated requests. The idempotency key protects backend correctness but gives the operator no progress signal.
- **User impact:** During the app's highest-frequency task, latency looks like a missed keypress and invites repeated attempts.
- **Smallest appropriate recommendation:** Add one `assigning` flag, render “Assigning…,” and disable the button and both keyboard submit paths until the request settles.
- **Confidence:** High.

#### P1 — ADMIN View as exposes writes that the server will reject

- **Screen and affected role:** ADMIN View as for BDC or MANAGER.
- **State or viewport:** Any View-as session; rendered at the desktop viewport with BDC selected.
- **Evidence:** The client changes effective permissions to the viewed role (`apps/web/src/state/authStore.ts:48-57,69-75`), so mutating screens and controls remain present (`apps/web/src/App.tsx:53-58,71-132,179-205`). The banner says “View-as is read-only,” while the API rejects every POST carrying the header (`apps/api/src/trpc/context.ts:20-29`). The rendered BDC preview showed editable lead fields and an enabled Assign action once valid.
- **What happens now:** ADMIN can fill a form or open a management flow and only learns at submission that the action is forbidden.
- **User impact:** This is a predictable, serious dead end in a tool explicitly intended to help ADMIN verify role workflows.
- **Smallest appropriate recommendation:** While View as is active, keep read-only navigation and data but hide or disable mutation controls with one shared explanation; do not wait for the server rejection.
- **Confidence:** High.

#### P1 — Auth bootstrap failure masquerades as a logged-out state

- **Screen and affected role:** Login/app bootstrap; all roles.
- **State or viewport:** `auth.me` network/API failure.
- **Evidence:** `App` calls `refresh()` without recovery (`apps/web/src/App.tsx:38-47`). `refresh` clears loading in `finally` but stores no bootstrap error (`apps/web/src/state/authStore.ts:89-97`).
- **What happens now:** A failed session check falls through to the credential form with an unhandled rejection and no distinction between “not signed in” and “service unavailable.”
- **User impact:** Users retry credentials or seek a password reset for what is actually a connectivity/API outage.
- **Smallest appropriate recommendation:** Store a bootstrap error and show a connection message with Retry before presenting Login as the recovery path.
- **Confidence:** High.

#### P1 — Critical state changes are not exposed consistently to assistive technology

- **Screen and affected role:** Login, Assign, Staff List, Users, Rep Detail, Import completion, and all SPA navigation; all roles.
- **State or viewport:** Dynamic errors, assignment/copy/bulk/import outcomes, and page changes.
- **Evidence:** Most outcomes are ordinary paragraphs without `role="alert"` or `role="status"` (`apps/web/src/pages/Login.tsx:32`; `AssignScreen.tsx:292,313,318`; `StaffList.tsx:389-398,522,567`; `UserManagement.tsx:261-269`; `RepDetail.tsx:247-255`; `ActivityImport.tsx:188,316-328`). Import progress is the lone explicit live region (`ActivityImport.tsx:204-215`). SPA navigation only changes local page state and has no `<main>` landmark or heading-focus handoff (`apps/web/src/App.tsx:34-36,60-64,66-211`).
- **What happens now:** A screen-reader user can miss whether the core assignment succeeded or failed and can remain focused on a navigation button without announcement of the replacement page.
- **User impact:** The fastest workflow becomes an accessibility barrier because the decisive result is visual only.
- **Smallest appropriate recommendation:** Add scoped alerts/status live regions for short outcomes, add a `<main>` landmark, and focus the new page heading after SPA page changes.
- **Confidence:** High.

#### P1 — Admin-entered passwords are displayed as plain text

- **Screen and affected role:** Users; ADMIN and MANAGER.
- **State or viewport:** Add account and Set manually modals.
- **Evidence:** Both password fields use the default text `Input` with no password type or autocomplete metadata (`apps/web/src/pages/UserManagement.tsx:325-327,337-343`).
- **What happens now:** Initial and reset passwords remain readable on screen and are not identified as new-password fields to password managers.
- **User impact:** Credentials are exposed during shoulder-surfing, screen sharing, or training, and password-manager behavior is degraded.
- **Smallest appropriate recommendation:** Set `type="password"` and `autoComplete="new-password"`; an optional reveal control can remain a later polish item.
- **Confidence:** High.

#### P1 — The documented local Vite app currently renders a blank page

- **Screen and affected role:** Local development app before Login; every role.
- **State or viewport:** `pnpm dev` / existing Vite server on `localhost:5173`.
- **Evidence:** `StaffList` imports the `@phoneup/core` barrel (`apps/web/src/pages/StaffList.tsx:2`), which re-exports `generateTempPassword` (`packages/core/src/index.ts:1-9`); that module imports `node:crypto` (`packages/core/src/tempPassword.ts:1`). The live Vite page had an empty `#root` and raised “Module node:crypto has been externalized for browser compatibility.” The production build emitted the same warning but tree-shook the server-only export and rendered successfully.
- **What happens now:** The documented source-development frontend is blank even before API state can be evaluated.
- **User impact:** This does not prove a production outage, but it blocks the normal local browser loop and makes UI regressions materially harder to catch.
- **Smallest appropriate recommendation:** Give browser-safe core exports a separate entrypoint or import the override helper from a browser-safe subpath so the frontend never evaluates the temp-password module.
- **Confidence:** High.

#### P2 — Core small text and primary action colors miss WCAG AA contrast

- **Screen and affected role:** Global navigation, primary buttons, hints, and table headers; all roles.
- **State or viewport:** Enabled controls and normal text at all rendered widths.
- **Evidence:** Tokens define accent `#5980a6` and background `#f2f2f3` (`apps/web/src/styles/tokens.css:44-50`). Enabled primary buttons use that pair at 14px (`apps/web/src/styles/ui.css:108-135`), producing **3.707:1**; muted 55% text computes to **3.636:1** (`ui.css:94-100`), and 60% table-header text computes to **4.247:1** (`ui.css:269-277`). All are below 4.5:1 for normal-size text. The design-system guide itself says the base accent is suitable for chrome, not body copy (`design-system/_ds/industry-f245fcdb-4fae-47dc-8fc7-9e6b2c66e81f/readme.md:47`).
- **What happens now:** The design-system palette is applied consistently, but important labels—including the enabled Assign button—are visually faint on ordinary workstation displays.
- **User impact:** Repeated reading and action recognition are harder for low-vision users and in glare/poor-monitor conditions.
- **Smallest appropriate recommendation:** Use a darker ramp step for small accent text and enabled button contrast, and raise essential muted/header text to an AA-passing token. Keep disabled-control styling separate.
- **Confidence:** High.

#### P2 — Navigation has no working active style, and ADMIN's wrapped profile menu clips offscreen

- **Screen and affected role:** Authenticated navigation; especially ADMIN.
- **State or viewport:** Every page for active state; ADMIN at 1024px and 390px for profile access.
- **Evidence:** Buttons receive `aria-current` (`apps/web/src/App.tsx:71-130`), but CSS targets the never-applied `.ui-nav-tab` class (`apps/web/src/styles/ui.css:325-328`), so rendered nav actions look alike. The wrapping nav and right-anchored menu (`ui.css:311-350`) move the ADMIN profile trigger to the left edge; true-viewport measurement placed the 170px panel at x = -25.86px at both 1024 and 390, and rendered “Change password” / “Log out” with their leading text clipped.
- **What happens now:** Users lack a reliable visual current-page cue, and ADMIN account actions become partially offscreen after header wrapping.
- **User impact:** Role orientation is slower, and essential account/password/logout actions are impaired at a realistic 1024px workstation width.
- **Smallest appropriate recommendation:** Style the actual `.ui-btn[aria-current="page"]`, and constrain/reposition the profile panel against the viewport when its trigger wraps to the left.
- **Confidence:** High.

#### P2 — Rep Detail reports “Copied” even when clipboard write fails

- **Screen and affected role:** My Dashboard / Rep Detail; REP, MANAGER, and ADMIN.
- **State or viewport:** Clipboard permission or browser failure.
- **Evidence:** Rep Detail swallows the rejected clipboard promise and immediately sets copied state (`apps/web/src/pages/RepDetail.tsx:164-168`), unlike Assign's explicit failure handling (`apps/web/src/pages/AssignScreen.tsx:169-171,313`).
- **What happens now:** The button says “Copied” even if the clipboard is unchanged.
- **User impact:** A user can paste the wrong or empty phone number while trusting false success feedback.
- **Smallest appropriate recommendation:** Set “Copied” only after a resolved write and reuse Assign's visible fallback on rejection.
- **Confidence:** High.

#### P2 — Audit creation events misalign Before and After

- **Screen and affected role:** Audit Log; MANAGER and ADMIN.
- **State or viewport:** Events with `before = null`, rendered at the desktop viewport.
- **Evidence:** Before and After payloads use the generic centered `.ui-toolbar` (`apps/web/src/pages/AuditLog.tsx:30-35`; `apps/web/src/styles/ui.css:78-83`). In the rendered `assignment.created` fixture, the one-line “Before —” block was vertically centered beside the multi-line After JSON, leaving the labels and payload association visibly staggered.
- **What happens now:** A creation event's dash and new object do not read as one aligned comparison.
- **User impact:** Managers can misassociate which payload is Before versus After while investigating an assignment.
- **Smallest appropriate recommendation:** Use a dedicated `align-items: start` two-column diff layout and label null as “Does not exist”; stack the two blocks at narrow widths.
- **Confidence:** High.

#### P2 — Sort state and repeated table controls lack specific accessible names

- **Screen and affected role:** Staff List and Users; MANAGER and ADMIN.
- **State or viewport:** Normal table use.
- **Evidence:** Sort buttons expose arrow glyphs but no `aria-sort` state (`apps/web/src/pages/StaffList.tsx:317-323,346-350`; `apps/web/src/pages/UserManagement.tsx:189-195,243-249`). The shared table emits generic `<th>` cells (`apps/web/src/ui/index.tsx:129-145`), while role selects and repeated password/status actions use identical control names per row (`UserManagement.tsx:198-239`). The browser accessibility snapshot exposed several unlabeled role comboboxes and repeated “Reset password” controls.
- **What happens now:** A screen reader is not told which column is sorted/direction, and control lists do not identify the affected account without reconstructing table context.
- **User impact:** Non-visual staff and account management is slower and more error-prone.
- **Smallest appropriate recommendation:** Put `aria-sort` on the active header and give row controls target-specific names such as “Role for Blake BDC” and “Generate temporary password for Blake BDC.”
- **Confidence:** High.

### Visual-system observations

- **Strong token fidelity:** The app copies the source palette, Barlow/Barlow Condensed typography, spacing scale, radii, and shadows (`apps/web/src/styles/tokens.css:44-110`; `design-system/_ds/industry-f245fcdb-4fae-47dc-8fc7-9e6b2c66e81f/styles.css:4-63`). Self-hosted fonts avoid a production CDN dependency.
- **Consistent operational primitives:** Buttons, fields, cards, badges, tables, focus rings, and square wireframe treatment are applied through shared UI components and token-only classes (`apps/web/src/ui/index.tsx`; `apps/web/src/styles/ui.css`). Semantic status colors extend the mono source palette, but their text labels and measured 5.17:1–6.84:1 contrast make that a useful operational adaptation rather than color-only communication.
- **Documented visual detail is missing:** The design-system guide requires blueprint registration marks on framed cards and primary buttons (`design-system/_ds/industry-f245fcdb-4fae-47dc-8fc7-9e6b2c66e81f/readme.md:14,49-59`), while the app's `Card` and `Button` markup does not emit them (`apps/web/src/ui/index.tsx:27-38,91-99`). This is visual drift, not a workflow blocker.
- **Responsive behavior is uneven:** The core two-column Assign layout stacks below 860px, tables gain bounded horizontal scrolling, and import decisions stack actions below 640px (`apps/web/src/styles/ui.css:72-105,263-285,483-508`). Navigation only wraps; the rendered ADMIN header grew to 88.9px at 1024 and 174.0px at 390, and its profile-menu positioning failed as described above.
- **Density matches the internal-tool brief on Assign:** At 1440 and 1024 the full form and roster fit together above the fold. At 390 the form, primary action, and Next Up remain reachable with no horizontal page overflow; full mobile expansion is not needed for v1.

### Strengths to preserve

- The BDC screen keeps the complete form and roster side by side on dealership workstations, with Next Up visually dominant and the first field focused.
- Client validation, Enter field progression, Ctrl+Enter assignment, Alt+C copy, and Alt+V Void support a fast keyboard loop (`apps/web/src/pages/AssignScreen.tsx:37-55,122-143,184-210`).
- Roster refresh failures distinguish stale-last-good data from a total load failure and provide Retry; the false post-failure empty state from the original critique has been removed.
- The shared modal traps focus, supports Escape, restores prior focus, and has dialog semantics (`apps/web/src/ui/Modal.tsx:40-100`). The Void dialog explains that the up returns to the rep.
- Import Activity preserves the preview-before-commit safety model, has explicit progress semantics, separates log-only from deactivate, and retains the file after a stale/failed commit.
- Statuses include words as well as color, and the added semantic status pairs have good contrast.
- The REP dashboard now clearly explains today's rotation state, recurring day off, and whom to contact when status looks wrong.
- ADMIN View as has a prominent banner and Exit control; the read-only enforcement is correctly server-side even though the client controls need to match it.

### Consolidated priority order

1. **Remove uncertainty from Assign:** add first-roster loading and in-flight assignment states before any further visual work (net-new P1 findings 1–2).
2. **Make View as genuinely read-only in the UI:** remove the form-filling/server-rejection dead end while retaining server enforcement (net-new P1 finding 3).
3. **Complete the assignment outcome:** preserve the current success/void flow but add actionable duplicate/unassigned guidance and accessible status announcements (existing item 5, Global C, and net-new accessibility finding).
4. **Repair authentication and account safety:** distinguish bootstrap outages from logout, improve Login recovery/autocomplete, clarify reset labels, and make admin-entered password fields actual password inputs (existing items 4 and 8; net-new auth/password findings).
5. **Fix the global navigation/accessibility layer:** restore visible active state, keep profile actions onscreen at 1024px, raise essential contrast, and provide main/heading focus semantics (existing item 9 and net-new navigation/contrast findings).

### Verification limitations

- Authenticated rendering used the current production bundle and a local in-memory fixture API, not a real Fastify session or database. Visual state and client behavior were exercised; backend mutation, stale-token, permission, and concurrency paths were source-inspected only.
- The existing production bundle was rebuilt by an independent reviewer and rendered successfully. The Vite source-development page at `localhost:5173` did not render because of the reported `node:crypto` import path, so no claim is made that Vite role workflows were visually exercised.
- The Import Activity initial state was rendered, but no file was uploaded and preview/commit outcomes were not browser-exercised. User creation, role/status changes, password resets, staff overrides, reassignments, real clipboard denial, and real network-failure injection were not performed.
- Login, forced password change, BDC, ADMIN, MANAGER navigation, REP dashboard, View as, profile menu, and the named management/reporting pages were rendered. Voluntary password change shares the inspected component but was not separately browser-exercised.
- True 1440/1024/390 captures covered Assign and ADMIN navigation/profile behavior. Other dense tables were rendered interactively at approximately 1280px and source-inspected for narrower behavior; a full mobile ADMIN/REP experience remains outside v1.
- No application code, dependency, test, configuration, production state, deployment, or database data was changed. Web build/tests/typecheck/lint were verification only; this report update is the sole tracked-file edit.
