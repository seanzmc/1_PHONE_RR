# Priority 1 Authentication and Password Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver accessible password controls, simplified first-login password setup, and a secure Resend-backed single-use password-reset flow for active PhoneUp users.

**Architecture:** Persist SHA-256 reset-token digests in Postgres, expose generic public request/complete-reset procedures, and send reset links through a small injected Resend REST client using native `fetch`. Reuse the existing session, password hashing, audit, and SPA surfaces; add focused web components and shared safe error translation without changing manager-issued temporary-password behavior.

**Tech Stack:** TypeScript, React 19, Zustand, Fastify, tRPC, Drizzle/Postgres, Vitest, native `fetch`, Resend REST Email API.

## Global Constraints

- Email only an active email already stored in `app_user`; never expose account existence or activity in a public response.
- Reset tokens use at least 32 random bytes, are stored only as SHA-256 digests, expire after 30 minutes, and are single-use.
- A successful self-service reset clears `must_change_password`, revokes every session, invalidates every outstanding reset token, and creates a secret-free audit event.
- Use `POST https://api.resend.com/emails` with native `fetch`; do not add the Resend SDK or another dependency.
- Read `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and `APP_BASE_URL` from the API environment; never log them or a plaintext reset token/URL.
- Forced first login uses authenticated session proof and asks only for new password plus confirmation; voluntary password change still verifies the current password.
- Preserve manager/Admin temporary-password issuance, existing login throttling, password hashing, roles, permissions, and deployment topology.
- Unknown server errors render safe fallback copy, not raw server text.
- Work test-first and keep repository changes uncommitted unless the user explicitly authorizes a commit.

## File Map

- `packages/db/src/schema/store.ts`: owns `password_reset_token` table definition.
- `packages/db/src/migrations/0006_*.sql` and `packages/db/src/migrations/meta/*`: generated database migration and Drizzle metadata.
- `apps/api/src/email/resend.ts`: isolated Resend request construction and response handling.
- `apps/api/src/domain/passwordRecovery.ts`: token lifecycle, account eligibility, delivery coordination, reset transaction, and audit.
- `apps/api/src/auth/recoveryThrottle.ts`: independent public recovery email/IP request limiter.
- `apps/api/src/routers/auth.ts`: public request/complete-reset procedures and forced/voluntary password-change branching.
- `apps/api/src/domain/passwordReset.test.ts`: authenticated forced/voluntary password-change regression coverage.
- `apps/api/src/domain/passwordRecovery.test.ts`: database-backed reset-token and delivery behavior.
- `apps/api/src/email/resend.test.ts`: exact Resend HTTP contract without network calls.
- `apps/api/src/routers/auth.test.ts`: public contract, generic response, and throttle behavior.
- `apps/web/src/ui/PasswordInput.tsx`: reusable accessible Show/Hide password control.
- `apps/web/src/lib/authErrors.ts`: shared safe authentication/password error translation.
- `apps/web/src/pages/PasswordRecovery.tsx`: recovery request screen and generic success state.
- `apps/web/src/pages/ResetPassword.tsx`: token completion screen.
- `apps/web/src/pages/Login.tsx`: visible Forgot password entry and reusable password input.
- `apps/web/src/pages/ChangePassword.tsx`: simplified forced flow, voluntary current-password check, and success status.
- `apps/web/src/pages/UserManagement.tsx`: reusable password controls and safe password-operation errors.
- `apps/web/src/state/authStore.ts`: optional current password input plus public request/complete-reset actions.
- `apps/web/src/App.tsx`: unauthenticated login/recovery/reset screen selection from root query state.
- `apps/web/src/styles/ui.css`: password-control and recovery-action layout using existing tokens.
- `.env.example` and `docs/RUNBOOK.md`: required Resend and app URL configuration plus delivery smoke-test instructions.

---

### Task 1: Persist Hashed Reset Tokens

**Files:**
- Modify: `packages/db/src/schema/store.ts`
- Create: `packages/db/src/migrations/0006_*.sql`
- Modify/Create: `packages/db/src/migrations/meta/_journal.json`, `packages/db/src/migrations/meta/0006_snapshot.json`
- Test: `apps/api/src/domain/passwordRecovery.test.ts`

**Interfaces:**
- Produces: `schema.passwordResetToken` with `id`, `userId`, `tokenHash`, `expiresAt`, `usedAt`, and `createdAt`.
- Consumes: existing `schema.appUser` UUID primary key.

- [ ] **Step 1: Write the failing schema contract test**

Create `apps/api/src/domain/passwordRecovery.test.ts` with a first contract that refers to the wished-for schema and verifies plaintext is not a column:

```ts
import { describe, expect, it } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import { schema } from '@phoneup/db'

describe('password reset token schema', () => {
  it('stores only a token digest with expiry and consumption timestamps', () => {
    const columns = getTableColumns(schema.passwordResetToken)
    expect(Object.keys(columns)).toEqual([
      'id', 'userId', 'tokenHash', 'expiresAt', 'usedAt', 'createdAt',
    ])
    expect('token' in columns).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test and confirm the expected red state**

Run: `pnpm --filter @phoneup/api test -- src/domain/passwordRecovery.test.ts`

Expected: type/runtime failure because `schema.passwordResetToken` does not exist.

- [ ] **Step 3: Add the table definition**

Add this shape to `packages/db/src/schema/store.ts`:

```ts
export const passwordResetToken = pgTable('password_reset_token', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => appUser.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

- [ ] **Step 4: Generate and inspect the migration**

Run: `DATABASE_URL=postgresql://localhost/phoneup_test pnpm --filter @phoneup/db generate`

Expected: one `0006_*.sql` migration plus matching journal/snapshot changes. Inspect the SQL and confirm it creates only the table, unique token-digest constraint, and user foreign key.

- [ ] **Step 5: Apply the migration to the isolated test database**

Run: `DATABASE_URL=postgresql://localhost/phoneup_test pnpm --filter @phoneup/db migrate`

Expected: migration succeeds without altering existing account/session tables.

- [ ] **Step 6: Run the schema contract test green**

Run: `pnpm --filter @phoneup/api test -- src/domain/passwordRecovery.test.ts`

Expected: one passing test.

---

### Task 2: Build the Resend REST Boundary

**Files:**
- Create: `apps/api/src/email/resend.ts`
- Create: `apps/api/src/email/resend.test.ts`

**Interfaces:**
- Produces:

```ts
export type PasswordResetEmail = {
  to: string
  displayName: string | null
  resetUrl: string
  expiresAt: Date
}

export type PasswordResetEmailSender = (email: PasswordResetEmail) => Promise<void>

export function createResendPasswordResetSender(
  config: { apiKey: string; from: string },
  fetchImpl?: typeof fetch,
): PasswordResetEmailSender
```

- Consumes: Resend `POST /emails` contract, bearer key, configured sender, and native `fetch`.

- [ ] **Step 1: Write failing HTTP-contract tests**

Create tests that inject a fake `fetch` and assert the real request boundary:

```ts
it('sends a plain-text and HTML reset email through Resend', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'email-1' }), { status: 200 }))
  const send = createResendPasswordResetSender(
    { apiKey: 're_test_key', from: 'PhoneUp <security@example.test>' },
    fetchImpl as typeof fetch,
  )

  await send({
    to: 'active@example.test',
    displayName: 'Active User',
    resetUrl: 'https://phoneup.example/?reset_token=plaintext',
    expiresAt: new Date('2026-08-01T17:30:00.000Z'),
  })

  expect(fetchImpl).toHaveBeenCalledOnce()
  expect(fetchImpl.mock.calls[0][0]).toBe('https://api.resend.com/emails')
  expect(fetchImpl.mock.calls[0][1]).toMatchObject({
    method: 'POST',
    headers: expect.objectContaining({
      Authorization: 'Bearer re_test_key',
      'Content-Type': 'application/json',
      'User-Agent': 'PhoneUp/1.0',
    }),
  })
  const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
  expect(body).toMatchObject({
    from: 'PhoneUp <security@example.test>',
    to: ['active@example.test'],
    subject: 'Reset your PhoneUp password',
  })
  expect(body.text).toContain('30 minutes')
  expect(body.html).toContain('https://phoneup.example/?reset_token=plaintext')
})
```

Also assert that non-2xx responses throw a stable `Resend email request failed (STATUS)` error without including the API key, recipient, or response body.

- [ ] **Step 2: Run tests red**

Run: `pnpm --filter @phoneup/api test -- src/email/resend.test.ts`

Expected: module-not-found failure.

- [ ] **Step 3: Implement the smallest injected Resend client**

Implement `createResendPasswordResetSender` to validate non-empty config, format escaped HTML plus plain text, call `fetchImpl('https://api.resend.com/emails', ...)`, and throw only a sanitized status-based error on failure. Do not log inside this module.

- [ ] **Step 4: Run the Resend tests green**

Run: `pnpm --filter @phoneup/api test -- src/email/resend.test.ts`

Expected: all Resend boundary tests pass with zero network traffic.

---

### Task 3: Implement the Database-Backed Recovery Domain

**Files:**
- Create: `apps/api/src/domain/passwordRecovery.ts`
- Modify: `apps/api/src/domain/passwordRecovery.test.ts`

**Interfaces:**
- Consumes: `PasswordResetEmailSender`, `schema.passwordResetToken`, existing `hashPassword`, sessions, and audit table.
- Produces:

```ts
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000

export type PasswordRecoveryDeps = {
  sendEmail: PasswordResetEmailSender
  appBaseUrl: string
  now?: () => Date
  randomToken?: () => string
  logDeliveryFailure?: (error: unknown) => void
}

export function hashResetToken(token: string): string

export async function requestPasswordReset(
  db: DB,
  input: { email: string },
  deps: PasswordRecoveryDeps,
): Promise<void>

export async function completePasswordReset(
  db: DB,
  input: { token: string; newPassword: string },
  now?: Date,
): Promise<void>
```

- [ ] **Step 1: Add failing eligibility and storage tests**

Using unique users created in `beforeAll`, prove:

```ts
it('emails only the stored address of an active matching account', async () => {
  await requestPasswordReset(db, { email: activeEmail.toUpperCase() }, deps)
  expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: activeEmail }))
  const rows = await db.select().from(schema.passwordResetToken)
  expect(rows).toHaveLength(1)
  expect(rows[0].tokenHash).toBe(hashResetToken('fixed-secret-token'))
  expect(JSON.stringify(rows[0])).not.toContain('fixed-secret-token')
})

it.each([['unknown', unknownEmail], ['inactive', inactiveEmail]])(
  'returns silently and sends nothing for an %s email',
  async (_label, email) => {
    await requestPasswordReset(db, { email }, deps)
    expect(sendEmail).not.toHaveBeenCalled()
  },
)
```

Add delivery-failure coverage proving the created token is consumed/invalidated and only the injected sanitized logger is called.

- [ ] **Step 2: Run the domain tests red**

Run: `pnpm --filter @phoneup/api test -- src/domain/passwordRecovery.test.ts`

Expected: failures because recovery functions do not exist.

- [ ] **Step 3: Implement reset request creation and delivery coordination**

Implement case-insensitive trimmed lookup, active-account eligibility, 32-byte URL-safe token generation, SHA-256 hashing, 30-minute expiry, root-query URL creation from `appBaseUrl`, and injected email delivery. If sending fails, mark that token used and invoke `logDeliveryFailure` with the sanitized Resend error; return without revealing eligibility.

- [ ] **Step 4: Run request tests green**

Run: `pnpm --filter @phoneup/api test -- src/domain/passwordRecovery.test.ts -t 'emails|unknown|inactive|delivery'`

Expected: request-path tests pass.

- [ ] **Step 5: Add failing completion tests**

Add tests for success, expiry, reuse, deactivation, and multiple links. The success assertion must cover every security side effect:

```ts
await completePasswordReset(db, { token: 'fixed-secret-token', newPassword: 'newPassword9' }, now)

const user = await reloadUser(activeUserId)
expect(verifyPassword('newPassword9', user!.passwordHash)).toBe(true)
expect(user!.mustChangePassword).toBe(false)
expect(await sessionsFor(activeUserId)).toHaveLength(0)
expect(await unusedTokensFor(activeUserId)).toHaveLength(0)
expect(await auditFor(activeUserId, 'user.resetOwnPassword')).toHaveLength(1)
```

For invalid, expired, used, and inactive-user cases, assert rejection with stable message `RESET_LINK_INVALID_OR_EXPIRED` and unchanged password/session state.

- [ ] **Step 6: Run completion tests red**

Run: `pnpm --filter @phoneup/api test -- src/domain/passwordRecovery.test.ts -t 'complete|expired|used|inactive|outstanding'`

Expected: failures because completion is not implemented.

- [ ] **Step 7: Implement the atomic completion transaction**

Hash the supplied token, select and lock the matching row, enforce unused/unexpired/active conditions, update the password and forced flag, mark all unused tokens for the user used, delete all user sessions, and insert `user.resetOwnPassword` audit data containing only `{ source: 'self_service' }`.

- [ ] **Step 8: Run the full recovery domain test green**

Run: `pnpm --filter @phoneup/api test -- src/domain/passwordRecovery.test.ts`

Expected: every token, eligibility, delivery, audit, and session test passes.

---

### Task 4: Expose Safe Public Recovery Procedures and Throttling

**Files:**
- Create: `apps/api/src/auth/recoveryThrottle.ts`
- Modify: `apps/api/src/routers/auth.ts`
- Modify: `apps/api/src/routers/auth.test.ts`

**Interfaces:**
- Consumes: domain request/complete functions and Resend env configuration.
- Produces: `auth.requestPasswordReset({ email }) -> { ok: true }` and `auth.completePasswordReset({ token, newPassword }) -> { ok: true }`.
- Produces recovery limiter functions mirroring the existing login-throttle test seam:

```ts
export function checkRecoveryThrottle(keys: string[], now?: number): { throttled: boolean; retryAfter: number }
export function recordRecoveryRequest(keys: string[], now?: number): void
export function resetRecoveryThrottle(): void
```

- [ ] **Step 1: Write failing throttle tests**

Add pure tests proving three requests per email/IP in 15 minutes are allowed and the fourth is blocked, different email addresses from the same IP share the IP limit, and `resetRecoveryThrottle()` isolates tests.

- [ ] **Step 2: Run throttle tests red**

Run: `pnpm --filter @phoneup/api test -- src/routers/auth.test.ts -t 'recovery throttle'`

Expected: module/function-not-found failure.

- [ ] **Step 3: Implement the independent limiter**

Use a process-local map, `MAX_REQUESTS = 3`, `WINDOW_MS = 15 * 60 * 1000`, pruning timestamps per key. Do not reuse login failure counters because a recovery request is not a failed login.

- [ ] **Step 4: Add failing router contract tests**

Inject or spy on the domain seam so the router tests prove:

```ts
expect(await caller.requestPasswordReset({ email: 'known@example.test' })).toEqual({ ok: true })
expect(await caller.requestPasswordReset({ email: 'unknown@example.test' })).toEqual({ ok: true })
await expect(caller.completePasswordReset({ token: 'bad', newPassword: 'password9' }))
  .rejects.toMatchObject({ message: 'RESET_LINK_INVALID_OR_EXPIRED' })
```

Also verify syntactically invalid email/password inputs are rejected, the request keys use normalized email and request IP, and throttle messages do not mention eligibility.

- [ ] **Step 5: Run router tests red**

Run: `pnpm --filter @phoneup/api test -- src/routers/auth.test.ts`

Expected: recovery procedures are missing.

- [ ] **Step 6: Implement the router procedures and configuration boundary**

In `auth.ts`, construct the sender from `RESEND_API_KEY` and `RESEND_FROM_EMAIL`, pass `APP_BASE_URL`, and pass a logger that emits only `password reset email delivery failed` plus sanitized error text. Return `{ ok: true }` from requests even when no account matches or delivery fails. Throw `TOO_MANY_REQUESTS` with a rounded retry window when the public limiter blocks. Map completion's stable invalid-link domain error to a tRPC `BAD_REQUEST` with the same stable message.

- [ ] **Step 7: Run router and domain tests green**

Run: `pnpm --filter @phoneup/api test -- src/routers/auth.test.ts src/domain/passwordRecovery.test.ts src/email/resend.test.ts`

Expected: all focused recovery API tests pass.

---

### Task 5: Simplify Forced First-Login Server Behavior

**Files:**
- Modify: `apps/api/src/domain/userManagement.ts`
- Modify: `apps/api/src/routers/auth.ts`
- Modify: `apps/api/src/domain/passwordReset.test.ts`
- Modify: `apps/api/src/routers/auth.test.ts`

**Interfaces:**
- Changes:

```ts
changeOwnPassword(db, {
  userId: string
  currentPassword?: string
  newPassword: string
  keepSessionId?: string
}): Promise<void>
```

- `currentPassword` is optional only when current database state has `mustChangePassword === true`; voluntary changes require it.

- [ ] **Step 1: Write failing forced-change tests**

Add a domain test that first issues a temporary password, then calls:

```ts
await changeOwnPassword(db, {
  userId,
  newPassword: 'myRealPassword9',
  keepSessionId: keep,
})
```

Assert success, forced flag cleared, other sessions revoked, and current session retained. Add a companion test proving the same omitted `currentPassword` is rejected with `CURRENT_PASSWORD_REQUIRED` after `mustChangePassword` is false.

- [ ] **Step 2: Run forced-change tests red**

Run: `pnpm --filter @phoneup/api test -- src/domain/passwordReset.test.ts -t 'without resubmitting|requires current'`

Expected: input/type failure or current-password rejection in the forced case.

- [ ] **Step 3: Implement server-state branching**

Load the user before verification. When `user.mustChangePassword` is false, require and verify `currentPassword`; when true, skip current-password verification. In both branches reject reuse when a supplied current password equals the new value, update the hash, clear the flag, preserve only `keepSessionId`, and retain the existing audit action.

- [ ] **Step 4: Update and test the tRPC schema**

Make `currentPassword` optional in `changePasswordInputSchema`; add router tests proving a forced session can omit it while an ordinary session cannot bypass verification.

- [ ] **Step 5: Run all password-domain and auth-router tests green**

Run: `pnpm --filter @phoneup/api test -- src/domain/passwordReset.test.ts src/routers/auth.test.ts`

Expected: existing admin reset, login throttle, voluntary change, forced change, and new recovery contracts all pass.

---

### Task 6: Add the Shared Accessible Password and Error Components

**Files:**
- Create: `apps/web/src/ui/PasswordInput.tsx`
- Create: `apps/web/src/ui/PasswordInput.test.tsx`
- Create: `apps/web/src/lib/authErrors.ts`
- Create: `apps/web/src/lib/authErrors.test.ts`
- Modify: `apps/web/src/styles/ui.css`

**Interfaces:**
- Produces:

```ts
export type PasswordInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: string
}
export function PasswordInput(props: PasswordInputProps): JSX.Element

export type AuthErrorContext = 'login' | 'change_password' | 'request_reset' | 'complete_reset' | 'manager_reset'
export function authErrorCopy(error: unknown, context: AuthErrorContext): string
```

- [ ] **Step 1: Write failing password-control markup tests**

Render `PasswordInput` to static markup and assert the initial input is `type="password"`, the button says `Show Login password`, and it has `aria-pressed="false"`. Export a pure helper `passwordVisibilityLabel(label, visible)` and test both Show and Hide labels so interaction state is testable in the Node environment.

- [ ] **Step 2: Run password-control tests red**

Run: `pnpm --filter @phoneup/web test -- src/ui/PasswordInput.test.tsx`

Expected: module-not-found failure.

- [ ] **Step 3: Implement `PasswordInput` and styles**

Wrap the existing `Input` in `.ui-password-input`, use local `visible` state, preserve forwarded input props, render a same-row text button, and toggle `type` without replacing the input node. Add focus-visible styling and mobile-safe spacing using existing CSS tokens.

- [ ] **Step 4: Write failing safe-copy tests**

Cover exact translations for invalid credentials, one/many-minute login throttle, incorrect/missing current password, invalid reset link, recovery throttle, network failure, password length, and unknown raw server text. The unknown assertion must be:

```ts
expect(authErrorCopy(new Error('database host secret.internal refused'), 'complete_reset'))
  .toBe('We couldn’t reset your password. Request a new link and try again.')
```

- [ ] **Step 5: Run safe-copy tests red**

Run: `pnpm --filter @phoneup/web test -- src/lib/authErrors.test.ts`

Expected: module-not-found failure.

- [ ] **Step 6: Implement the context-aware translator**

Match only known stable messages/codes and network failure patterns. Return a context-specific safe fallback for everything else. Move the existing login throttle/invalid-credentials behavior into this module and stop preserving unknown server messages.

- [ ] **Step 7: Run shared UI tests green**

Run: `pnpm --filter @phoneup/web test -- src/ui/PasswordInput.test.tsx src/lib/authErrors.test.ts`

Expected: password accessibility and safe-copy tests pass.

---

### Task 7: Build Public Recovery and Reset Screens

**Files:**
- Create: `apps/web/src/pages/PasswordRecovery.tsx`
- Create: `apps/web/src/pages/PasswordRecovery.test.ts`
- Create: `apps/web/src/pages/ResetPassword.tsx`
- Create: `apps/web/src/pages/ResetPassword.test.ts`
- Modify: `apps/web/src/state/authStore.ts`
- Modify: `apps/web/src/state/authStore.test.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.ts`
- Modify: `apps/web/src/pages/Login.tsx`
- Modify: `apps/web/src/pages/Login.test.ts`

**Interfaces:**
- Auth store produces:

```ts
requestPasswordReset(email: string): Promise<void>
completePasswordReset(token: string, newPassword: string): Promise<void>
changePassword(currentPassword: string | undefined, newPassword: string): Promise<void>
```

- App helpers produce:

```ts
export type PublicAuthPage = 'login' | 'recovery' | 'reset'
export function resetTokenFromLocation(search: string): string | null
```

- [ ] **Step 1: Write failing auth-store request tests**

Mock `mutate` and prove the store sends `auth.requestPasswordReset` with `{ email }`, `auth.completePasswordReset` with `{ token, newPassword }`, and omits `currentPassword` from forced change payloads rather than sending an empty string.

- [ ] **Step 2: Run store tests red**

Run: `pnpm --filter @phoneup/web test -- src/state/authStore.test.ts`

Expected: missing store methods/signature failures.

- [ ] **Step 3: Implement the store methods**

Use the existing `mutate` helper; do not persist reset tokens or recovery state in Zustand.

- [ ] **Step 4: Write failing pure screen-state tests**

For `PasswordRecovery`, export and test a generic success copy constant that never claims an account exists. For `ResetPassword`, export and test validation helpers for minimum length/mismatch and a `clearResetTokenFromUrl()` helper that calls `history.replaceState` with `/` after success. For `App`, test that `?reset_token=abc` selects reset mode and blank/missing values do not.

- [ ] **Step 5: Run public-screen tests red**

Run: `pnpm --filter @phoneup/web test -- src/pages/PasswordRecovery.test.ts src/pages/ResetPassword.test.ts src/App.test.ts`

Expected: new modules/helpers do not exist.

- [ ] **Step 6: Implement the recovery request screen**

Render an email field with `autoComplete="username"`, generic explanation, submit/busy state, `authErrorCopy(..., 'request_reset')`, the generic success status, resend/back actions, and no account-specific information.

- [ ] **Step 7: Implement the reset completion screen**

Render new/confirm `PasswordInput` fields, local validation, submit/busy state, invalid-link actionable alert, request-new-link action, and a success status that clears the reset token from browser history before returning to login.

- [ ] **Step 8: Wire login and App public modes**

Add a visible `Forgot password?` button to `Login`. In unauthenticated App state, initialize reset mode from `window.location.search`, allow login/recovery navigation without a router dependency, and ensure a bootstrap network error still takes precedence over all credential screens.

- [ ] **Step 9: Run public auth web tests green**

Run: `pnpm --filter @phoneup/web test -- src/state/authStore.test.ts src/pages/Login.test.ts src/pages/PasswordRecovery.test.ts src/pages/ResetPassword.test.ts src/App.test.ts`

Expected: store payload, generic response, validation, URL, and screen selection tests pass.

---

### Task 8: Update First-Login, Voluntary Change, and Manager Password Fields

**Files:**
- Modify: `apps/web/src/pages/ChangePassword.tsx`
- Create: `apps/web/src/pages/ChangePassword.test.ts`
- Modify: `apps/web/src/pages/UserManagement.tsx`
- Modify: `apps/web/src/pages/UserManagement.test.ts`

**Interfaces:**
- Consumes: `PasswordInput`, `authErrorCopy`, and updated auth-store `changePassword` signature.
- Preserves: existing `adminPasswordInputProps` autocomplete contract, manager temporary-password display, and Users-page mutations.

- [ ] **Step 1: Write failing first-login form-shape tests**

Export a pure helper and test it explicitly:

```ts
export function changePasswordFields(forced: boolean): Array<'current' | 'new' | 'confirm'>

expect(changePasswordFields(true)).toEqual(['new', 'confirm'])
expect(changePasswordFields(false)).toEqual(['current', 'new', 'confirm'])
```

Add a success-state reducer/helper test proving voluntary success clears all fields and returns `Password changed successfully`, while forced completion delegates to the existing app unlock/navigation behavior.

- [ ] **Step 2: Run ChangePassword tests red**

Run: `pnpm --filter @phoneup/web test -- src/pages/ChangePassword.test.ts`

Expected: module/helper-not-found failure.

- [ ] **Step 3: Implement the forced/voluntary UI split**

Render current password only when `forced === false`; compute valid state without it when forced; pass `undefined` to the store in forced mode. Use `PasswordInput` for every field. On voluntary success, clear all inputs and render a `role="status" aria-live="polite"` confirmation before the user chooses the return action; on forced success preserve automatic unlock. Translate failures through `change_password` context.

- [ ] **Step 4: Write failing Users-page password-surface tests**

Replace the old static `adminPasswordInputProps` equality assertion with tests proving the initial-password and manual-reset surfaces consume `PasswordInput` labels `Initial password` and `Temporary password for NAME`. Keep a separate autocomplete assertion if the exported props remain useful.

- [ ] **Step 5: Run Users-page tests red**

Run: `pnpm --filter @phoneup/web test -- src/pages/UserManagement.test.ts`

Expected: new password-surface contract is missing.

- [ ] **Step 6: Adopt the shared component and safe errors in Users**

Replace both editable password `Input` elements with `PasswordInput`, preserve `new-password` autocomplete and keyboard-submit handlers, and translate only create/reset/issue password failures through `manager_reset` context. Leave non-password role/status errors unchanged because they are outside Priority 1.

- [ ] **Step 7: Prove every rendered password field uses the shared control**

Run: `rg -n 'type="password"|type: .password.' apps/web/src --glob '*.{ts,tsx}'`

Expected: password typing exists only inside `PasswordInput.tsx` and test fixtures; no page owns a raw password input.

- [ ] **Step 8: Run all affected web tests green**

Run: `pnpm --filter @phoneup/web test -- src/ui/PasswordInput.test.tsx src/lib/authErrors.test.ts src/pages/Login.test.ts src/pages/PasswordRecovery.test.ts src/pages/ResetPassword.test.ts src/pages/ChangePassword.test.ts src/pages/UserManagement.test.ts src/state/authStore.test.ts src/App.test.ts`

Expected: all Priority 1 web tests pass.

---

### Task 9: Document Configuration and Verify the Complete Path

**Files:**
- Modify: `.env.example`
- Modify: `docs/RUNBOOK.md`
- Modify: `docs/superpowers/plans/2026-08-01-priority-1-auth-recovery.md` only to check completed steps during execution

**Interfaces:**
- Documents: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `APP_BASE_URL`, verified sender-domain requirement, send-only access, deployment boundary, and delivery smoke test.

- [ ] **Step 1: Add configuration documentation**

Document these exact production variables without values:

```dotenv
# Canonical public application origin used to build password-reset links.
# APP_BASE_URL=https://phoneup.example.com

# Send-only Resend API key. Set in Railway; never commit a real key.
# RESEND_API_KEY=re_...

# Sender on a domain verified in Resend.
# RESEND_FROM_EMAIL=PhoneUp <security@example.com>
```

Update Runbook onboarding/recovery statements that currently say there is no email or self-service reset. Keep `recover-admin` as the break-glass path when email delivery/configuration is unavailable.

- [ ] **Step 2: Run focused API verification fresh**

Run: `pnpm --filter @phoneup/api test -- src/email/resend.test.ts src/domain/passwordRecovery.test.ts src/domain/passwordReset.test.ts src/routers/auth.test.ts src/routers/userManagement.test.ts`

Expected: zero failures.

- [ ] **Step 3: Run focused web verification fresh**

Run: `pnpm --filter @phoneup/web test -- src/ui/PasswordInput.test.tsx src/lib/authErrors.test.ts src/pages/Login.test.ts src/pages/PasswordRecovery.test.ts src/pages/ResetPassword.test.ts src/pages/ChangePassword.test.ts src/pages/UserManagement.test.ts src/state/authStore.test.ts src/App.test.ts`

Expected: zero failures.

- [ ] **Step 4: Run workspace static/build gates**

Run: `pnpm typecheck`

Run: `pnpm --filter @phoneup/web build`

Run: `pnpm --filter @phoneup/web lint`

Expected: typecheck and build exit 0. Record lint warnings separately if they are confirmed pre-existing.

- [ ] **Step 5: Run the broader relevant suites serially**

Run: `pnpm --filter @phoneup/api test`

Run: `pnpm --filter @phoneup/web test`

Expected: zero failures, or separately reproduce any shared-test-database failure at untouched HEAD before attributing it to Priority 1.

- [ ] **Step 6: Perform browser verification without live email delivery**

Start the local API/web stack against `phoneup_test` or another non-production database. Verify desktop and mobile:

1. Login shows a keyboard-accessible Show/Hide control and Forgot password action.
2. Recovery always shows generic success.
3. A test-injected/reset fixture link opens the reset screen; invalid and expired links guide a new request.
4. Forced first login contains only new and confirm fields and unlocks after success.
5. Voluntary change requires current password and visibly confirms success.
6. Users-page editable password fields have independent accessible Show/Hide controls.

Do not use or request a production Resend key for this local browser pass.

- [ ] **Step 7: Inspect migration, secrets, diff, and dirty state**

Run: `rg -n 're_[A-Za-z0-9_]{8,}|reset_token=[A-Za-z0-9_-]{16,}' . --glob '!node_modules' --glob '!docs/superpowers/plans/2026-08-01-priority-1-auth-recovery.md'`

Expected: no real-looking key or plaintext generated token in tracked implementation/docs/tests.

Run: `git diff --check`

Run: `git status --short`

Inspect the complete diff and confirm only Priority 1 source, tests, migration metadata, configuration docs, design, and plan files changed.

- [ ] **Step 8: Report the external production blocker precisely**

State that repository implementation and local tests do not prove real email delivery. Production requires the user to create/provide:

1. A Resend API key restricted to sending access.
2. A verified sending domain.
3. A sender value for `RESEND_FROM_EMAIL` on that domain.
4. The deployed origin for `APP_BASE_URL`.

Do not add these to Railway or deploy without explicit authority.
