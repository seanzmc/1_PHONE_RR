# Protected owner account

Status: approved design, not yet implemented
Date: 2026-08-04

## Problem

`seanzmc9613@gmail.com` is the solo dev's ADMIN account. Today:

- A MANAGER can deactivate it. `userManagement.setActive` is the one user-management route
  with no target-is-ADMIN guard; `setRole`, `resetPassword` and `issueTempPassword` all have one.
- Any other ADMIN can rename its role, deactivate it, or reset its password.
- It appears in the Users page like any other account, which invites exactly those clicks.

The account needs to be unmodifiable by anyone else, invisible to everyone else, and still a
normal signed-in user whose every action lands in `audit_events`.

## Non-goals

- A fifth role. The role set stays ADMIN / MANAGER / BDC / REP.
- A secret login URL, a hardcoded credential, or an env-var password. The account signs in
  through the normal login page with a normal password, under the normal login throttle.
- Hiding the account from the database or from the audit log. Hidden means hidden from the
  application's user-facing lists only. Anyone holding `DATABASE_URL` sees it, which matches
  the boundary already documented for `recover-admin`.
- TOTP. See "Deliberately deferred".

## Design

### The flag

One column:

```
app_user.is_protected  boolean  not null  default false
```

Role stays `ADMIN`. The single flag means both *protected* (no other user may mutate this row)
and *hidden* (not listed to other users). It is not split into two columns until a
protected-but-visible account actually exists.

The flag is never settable from the application. A flag the app can clear is a flag an
attacker with an ADMIN session can clear.

### Layer A — domain choke point

`apps/api/src/domain/userManagement.ts` holds the only three functions that write
`app_user.role`, `.is_active` or `.password_hash` on another user's behalf: `setRole`,
`setActive`, `resetPassword`. Each already loads the target row inside its transaction.

Each gains the same rejection: **if `target.isProtected`, throw — regardless of who the actor
is, including the protected user acting on itself.**

The guard goes in the domain function, not the router. Routers get added and forget guards;
these three functions are the complete set of writers, so the check cannot be routed around.

Consequences:

- `userManagement.issueTempPassword` funnels into `resetPassword`, so it is covered with no
  separate change.
- `createAccount` cannot collide with the protected account — `app_user.email` is unique.
- Self-lockout is impossible: the protected user cannot demote or deactivate itself.

What the protected user can still do to its own account in-app:

- `auth.changeOwnPassword` — requires the current password, writes only `password_hash` and
  `must_change_password`.
- The forgot-password flow (`domain/passwordRecovery.ts`) — email-gated, writes only
  `password_hash` and `must_change_password`, never calls `resetPassword`. Unaffected.

Anything else — including recovering a lost password with no mailbox access — goes through
`recover-admin`.

### Layer B — Postgres trigger

`BEFORE UPDATE OR DELETE ON app_user`, a trigger function raises when `OLD.is_protected` is
true and either:

- the statement is a DELETE, or
- the UPDATE changes `email`, `role`, `is_active`, or `is_protected`.

An UPDATE touching only `password_hash`, `must_change_password`, `display_name` or
`totp_secret` passes. That is what keeps `changeOwnPassword` and the forgot-password flow
working with no escape hatch.

The escape hatch for the two scripts that legitimately need it is a session GUC:

```sql
SET LOCAL app.protected_write = 'on';
```

The trigger checks `current_setting('app.protected_write', true)` and allows the write when it
is `'on'`.

This layer does **not** defend against someone holding `DATABASE_URL` — they can set the GUC
themselves, and per `CLAUDE.md` they can already rewrite every row. It defends against a future
router or job that writes `app_user` directly and never learned about Layer A.

Precedent in this repo: `audit_events` already revokes UPDATE/DELETE for the app role via raw
SQL in migration `0000_pretty_whistler.sql`.

### Layer C — visibility

`userManagement.list` filters out rows where `is_protected` is true. A caller whose own user is
protected gets the unfiltered list — every row, protected ones included — so the account can
see itself, and so a second protected account would not be invisible to the first.

No other query lists users. The protected account is an ADMIN and therefore has no `sales_rep`
row, so it never appeared in board, roster, or eligibility listings.

The audit-log viewer is unchanged: rows authored by the protected account stay visible to
anyone with `audit.read`. Hidden is a UI-listing property, not an accountability exemption.

### Layer D — denied-attempt logging

When Layer A rejects, it writes an `audit_events` row. The row is written on its **own
connection, outside the guarded transaction** — the three domain functions load the target
inside `db.transaction`, and throwing there rolls the transaction back, so an audit insert made
inside it would vanish along with the rejection it was meant to record. The write is awaited
before the error is thrown, so a denied attempt is never lost.

Row shape:

- `action`: `user.protectedWriteDenied`
- `actorUserId`: the session user who tried
- `entityId`: the protected user
- `after`: `{ attempted: 'setRole' | 'setActive' | 'resetPassword' }`

Probing the account is then visible after the fact, which a plain FORBIDDEN response would not
be.

## Operations

### New script

```
pnpm --filter @phoneup/db protect-account <email> [--commit]
```

Dry-run by default, matching `recover-admin`, `rotate-passwords` and `restore-drill`. On
`--commit` it opens a transaction, sets `app.protected_write = 'on'`, flips the flag, and
writes an audit row (`action: user.setProtected`, `actorUserId` = the target's own id — the
same attribution `recover-admin` uses when there is no signed-in actor).

Passing `--off` clears the flag through the same path, so the state is reversible from the
same tool that set it.

### `recover-admin` changes

`apps/api/src/recoverAdmin.ts` needs three adjustments:

1. It must keep listing and targeting protected admins. If it filtered them out, the one
   account that cannot be recovered any other way would become unrecoverable.
2. Its `resetPassword` call needs an explicit opt-in — `allowProtected: true` — so the Layer A
   guard is bypassed deliberately at exactly one call site rather than by omission.
3. Its bare reactivation `UPDATE app_user SET is_active = true` must run inside a transaction
   that has set the GUC, or Layer B rejects it.

This preserves the property the user chose: the account is unmodifiable *in-app*, and
`recover-admin` — which is gated on `DATABASE_URL`, not on a login — remains its recovery path.

### Bug fixed in the same change

`userManagement.setActive` gains the target-is-ADMIN guard the other three user-management
routes already carry, so a MANAGER cannot deactivate any ADMIN. This is independent of the
protected flag and is a live hole today.

## Testing

API suite (`TEST_DATABASE_URL`, destructive, database name must contain `test`):

Layer A
- MANAGER calling `setActive` on a protected user → FORBIDDEN
- ADMIN calling `setRole` on a protected user → FORBIDDEN
- ADMIN calling `resetPassword` on a protected user → FORBIDDEN
- ADMIN calling `issueTempPassword` on a protected user → FORBIDDEN
- the protected user calling `setRole` or `setActive` on itself → FORBIDDEN
- each rejection above writes a `user.protectedWriteDenied` audit row
- the protected user calling `changeOwnPassword` → succeeds
- the forgot-password consume-token path against the protected user → succeeds

Layer B
- raw SQL `UPDATE app_user SET role = 'REP'` on a protected row → raises
- raw SQL `DELETE FROM app_user` on a protected row → raises
- raw SQL `UPDATE app_user SET password_hash = ...` on a protected row → succeeds
- the same blocked UPDATE with `SET LOCAL app.protected_write = 'on'` → succeeds

Layer C
- `userManagement.list` as an ADMIN omits the protected row
- `userManagement.list` as the protected user includes it

Regressions
- the "last active ADMIN" guards in `setRole` and `setActive` still count the protected admin,
  so a visible ADMIN cannot be demoted into a zero-admin state on the basis of a hidden one
- `recover-admin` dry-run lists the protected admin; `--commit` resets and reactivates it

Migration
- `pnpm typecheck` and the full api suite pass; the new migration applies cleanly against a
  throwaway Postgres in CI

## Documentation

`docs/RUNBOOK.md` gains:

- `protect-account` in the operational-scripts table
- a note that the owner account is hidden from the Users page by design, and that
  `recover-admin` is its only recovery path when the mailbox is unavailable

`CLAUDE.md` gains a short paragraph under "Accounts & passwords" describing the protected flag
and the fact that it is not settable from the app.

## Deliberately deferred

`app_user.totp_secret` exists in the schema and is completely unimplemented — no code in
`apps/api`, `packages/core` or `packages/contracts` references it. A hidden, protected account
still falls to a stolen password. TOTP on the protected account is the correct next hardening
step and gets its own spec; it is not in this one.
