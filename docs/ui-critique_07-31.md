# UI Critique — 2024-07-31

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
