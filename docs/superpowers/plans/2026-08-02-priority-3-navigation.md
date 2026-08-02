# Priority 3 Navigation and Role Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Priority 3 with a role-correct Team Dashboard landing page, a workflow-ordered navigation shell, a Manager+ Management menu, accessible shell styling, and an accurate reactivation contract.

**Architecture:** Keep page routing inside the existing `App.tsx` state machine. Add a pure role-navigation model derived from the shared permission contract so tests can verify every role without duplicating authorization rules, then render the existing pages through that model. Preserve manager-driven reactivation and remove only the unused self-request/review permission promise; do not add a new API workflow or remove the dormant database table.

**Tech Stack:** React 19, TypeScript, Zustand, Vitest, CSS design tokens, pnpm workspace.

## Global Constraints

- Preserve the global assignment drawer and its View-as mutation guard.
- Preserve all existing pages, API routes, schemas, dependencies, and deployment paths.
- Team Dashboard is the landing page for ADMIN, MANAGER, BDC, and REP.
- My Dashboard is visible only to REP, while Team Dashboard remains visible to every role with `board.view`.
- User Management and Audit Log live inside one Manager+ Management menu.
- Reactivation remains an audited manager action through existing account/status controls; no self-request workflow is promised.
- Use test-first changes and run the affected tests after each slice.

---

### Task 1: Role-safe navigation model and shell

**Files:**
- Modify: `apps/web/src/App.test.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/pages/Dashboard.tsx`

**Interfaces:**
- Consumes: `Role`, `Permission`, and `hasPermission` from `@phoneup/contracts`.
- Produces: `navigationForRole(role: Role)` returning ordered primary and management destinations.

- [x] **Step 1: Write failing navigation tests**

  Change the landing expectations so every role resolves to `dashboard`. Add literal role-matrix expectations proving REP receives `dashboard, me`; BDC receives `dashboard`; MANAGER and ADMIN receive `dashboard, staff, import` plus `users, audit` in Management. Assert that only roles holding `lead.assign` receive the Assign action.

- [x] **Step 2: Run the focused test and verify RED**

  Run: `pnpm --filter @phoneup/web exec vitest run src/App.test.ts`

  Expected: failures show REP still lands on `me` and the role-navigation model is absent.

- [x] **Step 3: Implement the minimal navigation model and rendering**

  Derive destinations from the shared permission function. Render the order `Assign lead`, `Team Dashboard`, REP-only `My Dashboard`, `Staff List`, `Import Activity`, then Manager+ `Management`. Put `User Management` and `Audit Log` buttons in the Management panel and remove their standalone top-navigation buttons. Change Dashboard's visible heading to `Team Dashboard`.

- [x] **Step 4: Run the focused test and verify GREEN**

  Run: `pnpm --filter @phoneup/web exec vitest run src/App.test.ts`

  Expected: all App navigation tests pass.

### Task 2: Active state, menu containment, and AA contrast

**Files:**
- Modify: `apps/web/src/styles/ui.css`
- Modify: `apps/web/src/styles/tokens.css`

**Interfaces:**
- Consumes: existing `.ui-btn`, `.ui-nav`, `.ui-profile-menu`, and tonal-ramp tokens.
- Produces: visible active navigation through actual `[aria-current='page']` buttons, viewport-contained menus, and stronger text/action colors.

- [x] **Step 1: Apply the documented shell fixes**

  Style `.ui-nav .ui-btn[aria-current='page']` rather than unused `.ui-nav-tab`; share panel behavior between Management and profile menus; right-align the profile menu after wrapping; cap panel width to the viewport; use accent-700 for enabled primary/ghost/link text and at least 70% text for muted, hint, and table-header copy.

- [x] **Step 2: Verify CSS and build behavior**

  Run: `pnpm --filter @phoneup/web typecheck && pnpm --filter @phoneup/web build && git diff --check`

  Expected: all commands exit zero.

### Task 3: Remove the unused reactivation request promise

**Files:**
- Modify: `packages/contracts/src/permissions.test.ts`
- Modify: `packages/contracts/src/permissions.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: existing manager account/status reactivation paths.
- Produces: a permission and role contract that describes only implemented behavior.

- [x] **Step 1: Write the failing permission expectation**

  Change the REP test to assert board/self-activity access without `reactivation.self`; remove request/review permissions from the exhaustive ADMIN list.

- [x] **Step 2: Run the contract test and verify RED**

  Run: `pnpm --filter @phoneup/contracts test`

  Expected: the REP self-reactivation assertion fails until the obsolete permission is removed.

- [x] **Step 3: Remove the unused permissions and update the role table**

  Remove `reactivation.self` and `reactivation.review` from the permission union/matrix. Update `CLAUDE.md` so MANAGER reviews no request queue and REP contacts a manager for reactivation. Leave `reactivation_request` schema/migrations intact because schema deletion is outside Priority 3 and would create migration risk.

- [x] **Step 4: Run the contract test and verify GREEN**

  Run: `pnpm --filter @phoneup/contracts test`

  Expected: all contract tests pass.

### Task 4: Reconcile existing dirty test infrastructure and artifacts

**Files:**
- Keep and verify: `.github/workflows/ci.yml`
- Keep and verify: `apps/api/src/domain/userManagement.test.ts`
- Remove: `output/playwright/`

**Interfaces:**
- Produces: CI that seeds the fresh Postgres service before suites that require seeded reps, plus a Sunday-safe new-REP assertion.

- [x] **Step 1: Verify the tracked edits match runtime contracts**

  Confirm API tests explicitly require seeded reps and `materializeShifts` converts Sunday to `OFF`; retain the CI seed and assert that today's shift exists without hard-coding `WORK`.

- [x] **Step 2: Run the focused API test**

  Run: `pnpm --filter @phoneup/api exec vitest run src/domain/userManagement.test.ts --no-file-parallelism`

  Expected: all `userManagement` tests pass on Sunday and weekdays.

- [x] **Step 3: Move disposable Playwright output to Trash**

  Move the validated repo-local `output/playwright` directory to a uniquely named folder under `/Users/seandm/.Trash`, then confirm no browser captures remain in `git status`.

### Task 5: Status documentation, verification, and clean handoff

**Files:**
- Modify: `docs/Revised consolidated action list.md`
- Modify: `docs/open-ui-7-31.md`
- Modify: this plan to mark executed steps complete.

**Interfaces:**
- Produces: status-bearing docs that distinguish implemented/local verification from deployment and production verification.

- [x] **Step 1: Update Priority 3 from current evidence**

  Mark each Priority 3 requirement complete, describe the role matrix and Management menu, record the reactivation-contract decision, and retain explicit deployment/browser limitations. Remove fixed navigation/reactivation findings from `open-ui-7-31.md` and list them as resolved.

- [x] **Step 2: Run fresh validation**

  Run focused web/contract/API tests, then `pnpm --filter @phoneup/web test`, `pnpm typecheck`, `pnpm --filter @phoneup/web lint`, `pnpm --filter @phoneup/web build`, and `git diff --check`.

- [x] **Step 3: Inspect final scope and commit**

  Inspect `git diff --stat`, `git diff`, and `git status --short`; commit only the verified Priority 3, CI/test cleanup, plan, and status docs. Do not deploy or push.
