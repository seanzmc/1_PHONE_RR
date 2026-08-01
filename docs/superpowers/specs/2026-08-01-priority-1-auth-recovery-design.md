# Priority 1 Authentication and Password Recovery Design

**Date:** 2026-08-01
**Status:** Approved design, pending implementation

## Goal

Complete Priority 1 from `docs/Revised consolidated action list.md`:

- Add accessible Show/Hide controls to every password field.
- Remove the temporary-password field from forced first-login setup.
- Add a visible Forgot password flow.
- Email an eligible user a single-use password-reset link through Resend.
- Confirm voluntary password changes visibly.
- Replace raw authentication and password errors with actionable language.

An email is eligible only when it belongs to an active `app_user` row. The public request
response must not reveal whether the email is eligible.

## Existing Behavior to Preserve

- Login remains protected by the existing email/IP throttle.
- An account with `must_change_password = true` remains blocked from every normal API route.
- Manager/Admin-issued temporary passwords remain short, one-time-display credentials.
- Managers retain the existing Users-page reset tools.
- A voluntary password change requires the current password and keeps the current session.
- Password hashes continue to use the existing password module.
- No deployment, production migration, domain verification, or secret creation is performed
  as part of the repository change.

## Architecture

### Password reset tokens

Add a `password_reset_token` table with:

- `id`
- `user_id`, referencing `app_user`
- `token_hash`, unique
- `expires_at`
- `used_at`, nullable
- `created_at`

The API generates at least 32 cryptographically random bytes and sends the encoded plaintext
token only in the email link. Only a SHA-256 digest is stored. Tokens expire after 30 minutes.
The reset transaction must:

1. Lock or atomically claim a matching unused, unexpired token.
2. Confirm the linked user is still active.
3. Replace the password hash.
4. Clear `must_change_password`.
5. Mark the token used and invalidate every other outstanding token for that user.
6. Revoke every session for that user.
7. Add a password self-reset audit event without recording the token or password.

An invalid, expired, already-used, or deactivated-account token must not change account state.

### Recovery request

Add a public recovery-request mutation accepting an email address. Normalize the address for
lookup and throttling. Apply bounded email/IP throttles before sending.

For an active matching user:

1. Generate and persist a new reset token.
2. Build a root-query URL from the configured application base URL, so the production static
   host can serve the existing SPA without a new deep-link fallback.
3. Send a plain-text and HTML email through `POST https://api.resend.com/emails`.

For an unknown or inactive email, do not create a token and do not call Resend. Every request
returns the same user-facing response: if the address is eligible, instructions will arrive.
Resend failures are logged without secrets or reset URLs and do not expose account existence.

Use Resend's REST API through the runtime's existing `fetch`; do not add an SDK dependency.
The email sender is injected at the domain boundary so tests never make live network calls.

### Resend configuration

The API reads:

- `RESEND_API_KEY`: a send-only Resend API key.
- `RESEND_FROM_EMAIL`: a sender on a verified domain, optionally with a display name.
- `APP_BASE_URL`: the canonical public application origin used in reset links.

The repository documents these variables in `.env.example` and `docs/RUNBOOK.md`. A missing or
invalid email configuration must fail the eligible request safely and produce a server log that
identifies the configuration problem without printing secret values.

No reset-token signing secret is needed because tokens are random and database-backed.

## API Contracts

### Request reset

Input: `{ email: string }`

Output: `{ ok: true }` for syntactically valid requests regardless of account match. User-facing
copy is generic. Rate-limit errors receive specific, actionable copy but do not disclose whether
the email is registered.

### Complete reset

Input: `{ token: string, newPassword: string }`

Output: `{ ok: true }` after password replacement and session revocation. Invalid or expired links
return a stable error that the UI translates into an explanation and a link to request another.

### Change authenticated password

The current authenticated change-password procedure accepts the current password only when the
account is not in forced first-login state:

- `must_change_password = true`: require new password and confirmation in the UI; server proves
  identity from the authenticated session and does not ask for the temporary password again.
- `must_change_password = false`: require and verify the current password before changing it.

The server, not a client flag, chooses the branch from current database state.

## Web Experience

### Reusable password input

Create one password-input control using the existing input styling. It toggles between password
and text presentation without changing the value or focus. Its control has a field-specific
accessible name, an `aria-pressed` state, and visible Show/Hide meaning. Apply it to login,
forced/voluntary password change, self-service reset, account creation, manager manual reset, and
any other rendered password field.

### Login and recovery

Place a visible `Forgot password?` control beside the login form. It opens a public recovery
screen with:

- email input with username autocomplete
- concise explanation that only active PhoneUp accounts can receive a link
- generic success state
- a return-to-login action

When a valid reset token is present in the root query string, show the reset-password screen with
new-password and confirmation fields. On success, remove the token from browser history and guide
the user back to login. Never persist the token in browser storage.

### First-login and voluntary changes

Forced first-login setup shows only new password and confirmation. Voluntary change continues to
show current password, new password, and confirmation. After voluntary success, clear the fields
and show `Password changed successfully` in a status region before navigation.

### Error language

Use a shared authentication/password error translator for known conditions:

- email or password mismatch
- login throttle
- incorrect current password
- password too short or confirmation mismatch
- expired, invalid, or already-used reset link
- recovery-request throttle
- connection/service failure

Unknown server messages are replaced with a safe fallback rather than displayed raw. Field-level
validation remains next to its field; request failures use an alert region; success uses a status
region.

## Security and Privacy

- Public recovery responses do not disclose whether an account exists or is active.
- Recovery emails are sent only to the email stored on the active user row.
- Reset tokens are high-entropy, hashed at rest, time-limited, single-use, and never logged.
- A successful reset revokes all sessions and all other reset links for the account.
- The reset email says what happened, when the link expires, and how to ignore an unsolicited
  request. It does not contain a password.
- Recovery throttling limits email flooding independently of login throttling.
- Reset URLs come only from `APP_BASE_URL`, never an untrusted request Host header.
- Resend uses a send-only key and a verified sender domain.

## Validation

Test-first coverage will prove:

- recovery requests create/send only for active known users while returning identical public
  results for unknown and inactive addresses
- email payload, expiry copy, configured sender, reset URL, and Resend error handling
- tokens are hashed at rest, expire, are single-use, and cannot reset deactivated accounts
- successful reset changes the password, clears the forced flag, revokes sessions, consumes all
  outstanding links, and audits without secrets
- forced first-login change succeeds without resubmitting the temporary password
- voluntary change still rejects a wrong current password
- every password surface uses the accessible toggle contract
- recovery, reset, forced-change, voluntary-confirmation, and safe error-copy UI states

Final verification includes focused API and web tests, the broader relevant suites, workspace
typecheck, web build, lint with pre-existing warnings identified separately, migration validation,
and `git diff --check`. Browser verification covers login, recovery, reset-link, forced first-login,
voluntary change, and manager password fields at desktop and mobile sizes. A real delivery smoke
test remains blocked until the Resend key, verified domain, sender, and public app URL are configured.

## Non-goals

- Emailing managers or every privileged user about reset requests.
- Sending temporary passwords by email.
- Magic-link login or passwordless authentication.
- Changing password complexity beyond the existing minimum.
- Replacing the existing manager-issued temporary-password workflow.
- Deploying, migrating production, creating Resend resources, or adding secrets to Railway.
