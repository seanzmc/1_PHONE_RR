# Design: Frontend User Management (sub-project 6)

## Context

Gap identified while writing the roster-import spec ([2026-07-28-roster-import-design.md](./2026-07-28-roster-import-design.md)): there's no UI to add/deactivate `app_user` accounts, assign roles, or reset passwords. Today that's raw SQL only. This is now a real launch blocker — `importRoster.ts` just created 39 accounts (38 staff + 1 admin) all sharing the temp password `changeme`; ADMIN/MANAGER need a way to force real per-user resets.

This is sub-project 6 of six identified in this session (roster import, permission refinements, CRM-import name-matching, assign-screen UX overhaul, dashboard metric respec, frontend user management). This spec covers **user management only**.

## Decisions

- **Access: ADMIN + MANAGER**, gated by a new `user.manage` permission. **Deliberate deviation from CLAUDE.md's role table**, which currently lists "role grants" under ADMIN only (MANAGER's listed permissions are rep activate/deactivate + schedule — the separate `rep_daily_status` concern `StaffList` already owns). Flagged explicitly per CLAUDE.md's own "when in doubt" instruction; the user chose to widen this rather than keep it ADMIN-only. CLAUDE.md's role table itself should be updated to match — tracked as a followup, not done in this spec.
- **New permission `user.manage`**, kept separate from the existing `admin.*` catch-all (which stays ADMIN-only, reserved for policy/enforcement-mode config per CLAUDE.md). Avoids quietly widening what `admin.*` means elsewhere in the system.
- **Password reset**: admin/manager types a new password directly into the UI and relays it out-of-band (text/in-person). No email-sending infra exists in this app (cookie-session auth only) and the team is ~44 people — generating-and-displaying a random temp password was considered and rejected as unnecessary complexity for this scale.
- **New REP accounts auto-enroll in rotation**: creating an account with role REP also creates `sales_rep` (hireDate = today) + today's `rep_shift(WORK)` + `rep_daily_status(ELIGIBLE, decidedBy SYSTEM)`, same mapping `importRoster.ts` uses. One form, immediately assignable. BDC/MANAGER/ADMIN accounts just create the `app_user` row — no rotation rows, same as the import script's role mapping.
- **`app_user.display_name` column added** (nullable text). Currently only `sales_rep.displayName` exists, so BDC/MANAGER/ADMIN accounts have no human-readable name anywhere in the DB. New migration adds this column; populated on every new account going forward regardless of role. A one-time backfill script (`packages/db/src/backfillDisplayNames.ts`) fills it for the 39 already-imported accounts by re-reading the gitignored TSV and matching on email. The admin account (`seanzmc9613@gmail.com`, no TSV row) stays null — UI falls back to showing email when `displayName` is null.
- **Role changes handle the REP transition**, not just a bare `role` update:
  - REP → other role: find their `sales_rep` row, write today's `rep_daily_status` to `INELIGIBLE` (`decidedBy MANAGER_OVERRIDE`, reason `"role changed to {newRole}"`). Same effect as an existing `overrideStatus` FORCE_INACTIVE call, just triggered from a role change instead of a manual override. **Never deletes the `sales_rep` row** — it's FK'd from `assignment_events`/`rep_month_counters`, and CLAUDE.md's append-only ledger model means history is never destroyed.
  - Other role → REP: reuse an existing `sales_rep` row if one exists (rehire case — someone who was previously REP, changed away, now changing back) and mark today `ELIGIBLE`; otherwise create one fresh, same as new-account creation.
- **Deactivating a REP account also pulls them from rotation ranking**, not just login. `loadSession` already re-checks `app_user.isActive` on every request, so deactivation kills login immediately — but per CLAUDE.md, `rankReps`/the assignment algorithm only ever reads `rep_daily_status`, never `app_user.isActive`. Without an explicit write, a deactivated REP would still show up in the rotation. So `setActive(false)` on a REP account applies the same today's-status write as a role change away from REP; `setActive(true)` (reactivate) applies today's `ELIGIBLE` write, same as new-account creation.
- **Safety guards**: refuse to deactivate your own account; refuse any `setRole`/`setActive` that would drop the last active ADMIN account. Both checked inside the same transaction as the write they'd guard.
- **Known limitation, accepted rather than solved here**: the INELIGIBLE/ELIGIBLE writes above only cover *today's* `rep_daily_status` row. There's no forward-looking recurring schedule anywhere in this codebase yet (no code generates future `rep_shift` rows) — that's a pre-existing gap, not something this feature introduces or regresses. Tomorrow, the eligibility job recomputes from scratch same as it always has. This matches the existing limitation of `StaffList`'s FORCE_INACTIVE override; not a permanent "off rotation forever" switch. Worth a real fix later if it causes problems in practice, not part of this spec.
- **Architecture: inline domain functions, not calling `rep.overrideStatus` internally.** Considered having `setRole`/`setActive` call the existing `rep.overrideStatus` tRPC procedure to reuse its logic, rejected — that procedure is shaped for a human-supplied reason/actor at the HTTP boundary, and calling a tRPC procedure from another procedure internally is the wrong seam. Instead, `apps/api/src/domain/userManagement.ts` reuses the *pattern* (same advisory lock key, same `rep_daily_status` write shape) as its own domain functions, consistent with CLAUDE.md's "one table, no new branches — add a status write instead" rule.

## What this feature does

### Data model
- Migration: `app_user.display_name text` (nullable).
- `packages/db/src/backfillDisplayNames.ts` — one-time script, reads the roster TSV, updates `app_user.display_name` by email match for existing rows. Same "not committed, one-shot" treatment as `importRoster.ts`.

### Permissions
- `packages/contracts/src/permissions.ts`: add `Permission` variant `'user.manage'`, add to `ADMIN` and `MANAGER` arrays in `MATRIX`.

### API — `apps/api/src/domain/userManagement.ts`
Four functions, each its own transaction, using advisory lock key `42_100_1` (same as `assignLead`/`overrideStatus`) whenever touching `rep_daily_status`/`sales_rep`:

- `createAccount({ email, displayName, role, password, actorUserId })`
  - Insert `app_user` (email, `hashPassword(password)`, role, displayName).
  - If `role === 'REP'`: insert `sales_rep` (userId, displayName, hireDate = today), `rep_shift` (WORK, today), `rep_daily_status` (ELIGIBLE, today, decidedBy SYSTEM).
  - Insert `audit_events` row (action `user.create`).
- `setRole({ userId, newRole, actorUserId })`
  - Guard: if target is the last active ADMIN and `newRole !== 'ADMIN'`, throw.
  - Update `app_user.role`.
  - If REP → other: find `sales_rep` by userId, write today's `rep_daily_status` INELIGIBLE (decidedBy MANAGER_OVERRIDE, reason `"role changed to {newRole}"`).
  - If other → REP: find-or-create `sales_rep` by userId (reuse if exists), write today's `rep_daily_status` ELIGIBLE. Create `rep_shift(WORK, today)` if none exists for today.
  - Insert `audit_events` row (action `user.setRole`, before/after role).
- `setActive({ userId, isActive, actorUserId })`
  - Guard: refuse if `userId === actorUserId` and `isActive === false`.
  - Guard: if target is the last active ADMIN and `isActive === false`, throw.
  - Update `app_user.isActive`.
  - If target role is REP: write today's `rep_daily_status` (INELIGIBLE if deactivating, ELIGIBLE if reactivating), same shape as `setRole`'s REP-transition write.
  - Insert `audit_events` row (action `user.setActive`).
- `resetPassword({ userId, newPassword, actorUserId })`
  - Update `passwordHash = hashPassword(newPassword)`.
  - Insert `audit_events` row (action `user.resetPassword`) — actor, target, timestamp only, never the password value.

### API — `apps/api/src/routers/userManagement.ts`
New router, all procedures `.use(requirePerm('user.manage'))`:
- `list` (query) — returns `{ id, email, displayName, role, isActive, createdAt }[]` for all `app_user` rows.
- `create`, `setRole`, `setActive`, `resetPassword` (mutations) — thin wrappers over the domain functions above, `actorUserId` from `ctx.session`.

Wire into `apps/api/src/trpc/router.ts`'s combined router alongside the existing `adminRouter`, `boardRouter`, etc.

### UI — `apps/web/src/pages/UserManagement.tsx`
- New "Users" nav tab in `App.tsx`, shown only when `hasPermission(session.role, 'user.manage')`.
- Table: name (displayName or email fallback), email, role, active/inactive, actions.
- Create-account form: email, display name, role dropdown, initial password.
- Per-row actions: role dropdown (triggers `setRole`), activate/deactivate toggle (triggers `setActive`), inline "new password" field + button (triggers `resetPassword`).
- Same plain inline-style pattern as `StaffList.tsx` — no new UI framework/library.

## Testing

- Table-driven unit tests for `userManagement.ts` domain functions — the REP↔other transition branches and the last-admin/self-deactivation guards are exactly the kind of branchy logic worth covering, unlike `importRoster.ts`'s straight-line script.
- Manual verification of the actual screens via Playwright MCP against a local dev DB (create an account, change its role both directions, deactivate/reactivate, reset a password and log in with it), same verification approach used for the existing screens per the phase-1 status handoff.

## Out of scope (queued separately, not this spec)

- Updating CLAUDE.md's role table to reflect `user.manage` being granted to MANAGER (flagged above, real followup, not done here).
- A real forward-looking recurring schedule / permanent "off rotation" flag (the known limitation noted above) — pre-existing gap, not introduced by this feature.
- Bulk account operations (bulk deactivate, bulk role change).
- Self-service password change (a user changing their own password while logged in) — this spec is admin/manager-driven resets only.
- Audit log *viewing* UI for these new `user.*` audit events — they're written (via existing `audit_events` table and `audit.view` permission machinery) but no new UI is built here beyond what already exists.
