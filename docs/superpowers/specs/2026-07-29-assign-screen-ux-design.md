# Design: Assign-Screen UX Overhaul (sub-project 4)

## Context

Fourth of six sub-projects identified this session (roster import [done], permission refinements, CRM-import name-matching, assign-screen UX overhaul, dashboard metric respec, frontend user management [done]). This spec covers **assign-screen UX only**.

Goal: keyboard-first, "spreadsheet-feel" speed for BDC agents rapid-firing lead entry. This is UX polish on top of the existing core loop — per CLAUDE.md, the ranking/assignment algorithm itself is untouched. No backend changes; the void action reuses an existing, already-tested procedure (`assignmentRouter.void`, `apps/api/src/routers/assignment.ts:21-65`) that currently has no UI anywhere.

Existing screen: `apps/web/src/pages/AssignScreen.tsx` — hand-rolled fetch-based tRPC client, plain inline styles, no UI framework. Already has `autoFocus` on Name and a `Ctrl+Enter` global submit shortcut.

## Decisions

- **Scope: entry-flow speed only.** Roster panel (On Deck/Unavailable lists) is explicitly untouched — confirmed with the user rather than bundling roster-display changes into this pass.
- **In-place patch to `AssignScreen.tsx`**, not new components. Rejected extracting a reusable `QuickEntryForm`/`VoidAction` — nothing else calls this form today, and CLAUDE.md's YAGNI stance applies. Rejected a reducer/state-machine approach as overkill for a 3-field form.
- **Field flow**: Name → `Enter` → focus Phone. Phone → `Enter` → submit directly, skipping Notes (Notes is optional and rarely used; still reachable via Tab/click). `Ctrl+Enter` stays as the existing global submit-from-anywhere shortcut, including from within Notes.
- **Phone auto-formatting**: if the Phone field's value doesn't start with `+`, auto-prepend `+1` client-side before validation/submit. BDC types raw 10 digits; never types "+1" by hand. API's `^\+1\d{10}$` validation is untouched — this is a client-side transform only, applied right before the `mutate` call.
- **Auto-copy on assign**: on a successful assign with `assignedRepId` present, automatically write `digitsOnly(phone)` to the clipboard via the existing `useClipboardStore`'s `setLastCopiedPhone` — capturing the `phone` value before the post-submit form reset (same value just used in the `mutate` call). Removes a click from the hot path. The "Copy phone" button on the result card stays as a manual re-copy fallback (clipboard writes can silently fail, e.g. permissions denied), and the existing `Alt+C` re-copy shortcut is unchanged.
- **Auto-refocus after assign**: focus returns to the **Name** field (not the Copy button, which is the current behavior) so the next lead can be typed immediately. The Copy Phone button no longer needs to steal focus since copying happens automatically.
- **Void action (new UI, existing backend)**: on the "Just Assigned" result card, add a void action gated by `hasPermission(session.role, 'lead.void')` (BDC/MANAGER/ADMIN per `packages/contracts/src/permissions.ts` — REP does not have this screen). Session/role obtained via the existing `useAuthStore()` hook — no prop threading needed.
  - Shortcut: **`Alt+V`**, not bare `V`. Since Name auto-refocuses after a successful assign, a bare `V` keystroke would leak into the next lead's name as the agent starts typing.
  - `Alt+V` opens an inline reason-note text input on the result card (the backend's `voidLeadInputSchema` requires `reasonNote: z.string().min(1)` — void is not a bare one-keystroke undo).
  - `Enter` in that input confirms: calls `assignment.void` with `{ leadId: lastResult.leadId, reasonNote }`.
  - `Esc` cancels the reason-note input, discarding it, no mutation sent.
  - On success: clear `lastResult` and refresh the roster (the void reverts the rep's monthly credit server-side, so the roster's `monthlyLoad` numbers change).
  - On failure (e.g., void window closed for the business day — `apps/api/src/routers/assignment.ts:34-37`): show the backend's error message inline, same display pattern as the existing top-of-form assign-error path.
- **No backend changes.** `voidLeadInputSchema` and `assignmentRouter.void` already exist, are already covered by existing backend tests, and are reused as-is — this spec is UI-only.

## What this feature does

### `apps/web/src/pages/AssignScreen.tsx` (modified in place)

- Name field: `onKeyDown` handler — `Enter` (no modifier) calls `e.preventDefault()` and focuses the Phone input via a new `phoneRef`.
- Phone field: `onKeyDown` handler — `Enter` (no modifier) calls `e.preventDefault()` and calls `handleAssign()` directly (same function the button already calls).
- Phone value transform: in `handleAssign`, before calling `mutate`, compute `const phoneE164 = phone.startsWith('+') ? phone : \`+1${phone}\``and send that instead of the raw`phone` state.
- `handleAssign` success path: before clearing `phone` state, call `setLastCopiedPhone(digitsOnly(phoneE164))` (auto-copy). Replace the existing "focus Copy button" `useEffect` with one that focuses a `nameRef` instead.
- New state: `voidReasonOpen: boolean`, `voidReason: string`, `voidError: string | null` — local to the component, reset whenever `lastResult` changes.
- New global keydown case (alongside the existing `Ctrl+Enter` handler): `Alt+V` — only wired when `lastResult?.assignedRepId` is present and `hasPermission(session.role, 'lead.void')` — sets `voidReasonOpen = true` and focuses the reason input.
- Reason input: rendered conditionally on the result card when `voidReasonOpen`. `onKeyDown`: `Enter` → `handleVoid()`, `Escape` → close and clear.
- `handleVoid()`: calls `mutate('assignment.void', { leadId: lastResult.leadId, reasonNote: voidReason })`. On success: `setLastResult(null)`, `refreshRoster()`. On failure: `setVoidError(err.message)`, keep the reason input open so the agent can see the error and retry or cancel.
- Session/role: `const { session } = useAuthStore()` (new import), used only for the `hasPermission` gate on rendering/wiring the void action.

## Out of scope (queued separately, not this spec)

- Roster panel redesign (On Deck/Unavailable display) — explicit scope decision, left as bullet lists.
- Pre-submit duplicate-phone checking — stays a post-hoc `duplicatePhone` flag on the result, no added round-trip.
- Any change to `assignLead` domain logic, ranking, or the advisory-lock path.
- Permission refinements, CRM-import name-matching, dashboard metric respec — the other queued sub-projects, untouched here.

## Testing

- No backend/domain logic changes, so no new backend unit tests.
- Manual verification via Playwright MCP against a local dev DB if the browser-automation sandbox issue from sub-project 6 (socket-path-too-long under this session's `TMPDIR`) doesn't recur. If it does recur, substitute the same approach used there: document the specific gap and verify what's verifiable another way (e.g., a scripted keydown/focus assertion isn't meaningful without a real DOM — in that case, note this as a known limitation same as before rather than skipping verification silently).
