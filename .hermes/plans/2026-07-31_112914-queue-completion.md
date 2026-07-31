# July 31 Queue Completion Implementation Plan

> **For Hermes:** Use subagent-driven development to implement this plan task-by-task, with parent review before accepting each child result.

**Goal:** Complete items 4–10 and the carried `board.test.ts` fixture cleanup in `docs/superpowers/specs/7-31-queue.md`, preserving the round-robin ledger, permission, and inactive-account invariants.

**Architecture:** Add server-enforced active-account filtering at every rep-list/drill-down boundary; add query-only ADMIN view-as that resolves an active real account server-side and applies that account's role/user scope to reads; add a permission-gated audit query/page; implement reassign as one advisory-locked ledger/projection transaction; then wire focused UI behavior and navigation changes. Keep account enablement (`app_user.is_active`) distinct from rotation eligibility (`rep_daily_status`).

**Tech Stack:** React 19 + Zustand, Fastify/tRPC v11 + Zod, Drizzle/PostgreSQL, Vitest, pnpm.

---

## Dependency order

1. **Plan and baseline** (complete before delegation).
2. **Parallel server foundations:** inactive-account filtering, audit API/page shell, and reassign domain/API.
3. **Review foundations:** parent reads every diff, runs targeted tests, and fixes/returns any incomplete child work.
4. **Dependent view-as:** only after active-account selection/filtering is correct.
5. **UI integration:** profile menu/nav, origin-aware back, sortable lists, assign keyboard/labels/phone/reassign controls, and terminology.
6. **Spec updates and full verification.**

No dependent task starts before the prerequisite foundation has passed targeted tests.

## Task 1: Baseline and carried fixture cleanup

**Objective:** Establish live Git/test state and stop `board.test.ts` from leaking users/reps.

**Files:**
- Modify: `apps/api/src/routers/board.test.ts`
- Update progress: `docs/superpowers/specs/7-31-queue.md`

**Steps:**
1. Add a failing regression assertion or cleanup verification around the fixture ids.
2. Add `afterAll` cleanup in foreign-key-safe order.
3. Run `pnpm --filter @phoneup/api test -- src/routers/board.test.ts`.
4. Mark the carried debt complete in the queue spec.

## Task 2: Hide disabled accounts outside Users (parallel foundation A)

**Objective:** Ensure `app_user.is_active = false` reps cannot appear in roster, staff, assign, dashboards, activity/lead drill-downs, imports, or assignment ranking, while `rep_daily_status = INELIGIBLE` active accounts remain visible.

**Files likely to change:**
- `apps/api/src/routers/board.ts`
- `apps/api/src/domain/assignLead.ts`
- `apps/api/src/routers/lead.ts`
- `apps/api/src/routers/activity.ts`
- `apps/api/src/jobs/activityImport.ts`
- `apps/api/src/jobs/activityImportDecision.ts`
- relevant API tests, especially `apps/api/src/routers/board.test.ts`, `apps/api/src/domain/assignLead.test.ts`, `apps/api/src/routers/rep.test.ts`, and activity tests

**Steps:**
1. Write tests proving an inactive account-backed rep is absent while an active-but-INELIGIBLE rep remains.
2. Run targeted tests and confirm RED.
3. Implement reusable active-rep selection/join logic where practical without changing the ranking algorithm to read a second eligibility source.
4. Reject direct drill-down requests for disabled-account reps.
5. Ensure assignment snapshots/ranking never include disabled accounts even when stale status rows exist.
6. Run all affected API tests and confirm GREEN.
7. Parent reviews all query paths and terminology.
8. Mark item 10 complete only after UI Users grouping is also complete.

## Task 3: Master audit API and page shell (parallel foundation B)

**Objective:** Provide a dedicated chronological audit log, server-gated by `audit.view`, with actor names and complete before/after details.

**Files:**
- Create: `apps/api/src/routers/audit.ts`
- Create: `apps/api/src/routers/audit.test.ts`
- Modify: `apps/api/src/appRouter.ts`
- Create: `apps/web/src/pages/AuditLog.tsx`
- Create: `apps/web/src/pages/AuditLog.test.ts` for pure formatting/sorting helpers if useful
- Do not modify `apps/web/src/App.tsx` in the delegated work; parent integrates navigation later.

**Steps:**
1. Write API tests for ADMIN/MANAGER access, BDC/REP denial, descending chronology, actor display name, and preserved historic actors including disabled accounts.
2. Confirm RED.
3. Implement a bounded/paginated query (default recent page; deterministic `createdAt,id` order) with no mutation surface.
4. Build a page that renders timestamp, actor, action, entity, and readable before/after JSON with loading/error/empty states.
5. Run targeted API and web tests.
6. Parent reviews permission enforcement and data completeness.
7. Parent wires the page into `App.tsx` after navigation work.

## Task 4: Manager reassign transaction and API (parallel foundation C)

**Objective:** Let ADMIN/MANAGER reassign an existing assigned lead at any age without abusing the BDC Alt+V window, preserving ledger/counter/cycle invariants.

**Files:**
- Modify: `packages/contracts/src/schemas.ts`
- Create: `apps/api/src/domain/reassignLead.ts`
- Create: `apps/api/src/domain/reassignLead.test.ts`
- Modify: `apps/api/src/routers/assignment.ts`
- Modify reconciliation tests only if needed to prove `REASSIGN_OUT/-1` + `REASSIGN_IN/+1` net accounting.

**Steps:**
1. Write failing tests for permission, same-rep/no-op rejection, disabled target rejection, ledger pair, counter decrement/increment, lead update, audit row, one shared advisory lock, and idempotent retry.
2. Confirm RED.
3. Implement one transaction using the assignment advisory lock and append-only `REASSIGN_OUT`/`REASSIGN_IN` events.
4. Preserve the original assignment's cycle accounting correctly; do not route through void + fresh lead creation.
5. Update current rep counters and `lastAssignedAt` consistently and keep reconciliation true.
6. Publish realtime only after commit.
7. Expose `assignment.reassign` behind `lead.assign.override`.
8. Run targeted domain/router/reconciliation tests.
9. Parent reviews the full invariant path before UI work starts.

## Task 5: Real-profile ADMIN view-as (depends on Task 2)

**Objective:** Replace client-only role preview with selection of an active real account and show that account's actual read permissions and self-scoped data.

**Files likely to change:**
- `apps/api/src/trpc/context.ts`
- `apps/api/src/trpc/requirePerm.ts`
- `apps/api/src/trpc/requirePerm.test.ts`
- `apps/api/src/routers/auth.ts` or a focused view-as query
- `apps/web/src/lib/api.ts`
- `apps/web/src/state/authStore.ts`
- `apps/web/src/App.tsx`

**Design constraint:** View-as is query-only. Requests carry a selected target id; the server verifies the real session belongs to an ADMIN, resolves an active real target, applies target role/user scope to reads, and rejects mutations while view-as is active. Audit attribution must never pretend the target performed an ADMIN action.

**Steps:**
1. Write failing middleware/context tests for non-admin spoofing, inactive targets, target permission enforcement, self-data scoping, and mutation rejection.
2. Confirm RED.
3. Add an ADMIN-only list of active selectable profiles.
4. Send an explicit view-as header on query requests; resolve it server-side rather than trusting a client role.
5. Store/display selected target identity in Zustand and clear it on refresh/logout.
6. Replace role select with real-profile select and a clear banner stating query-only view-as.
7. Verify REP lands on own screen and BDC/MANAGER navigation/reads reflect real permissions.

## Task 6: Profile hub menu and navigation origin

**Objective:** Move Change password/Log out behind a profile menu and make rep-detail Back return to the page that opened it.

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify/create focused pure helper tests if navigation state is extracted.

**Steps:**
1. Add a profile button/menu with identity, Change password, and Log out; preserve keyboard/button accessibility.
2. Track `repOriginPage` when `openRep` is called from Assign, Staff List, or Dashboard.
3. Return to that captured page, falling back safely only if permission changes make it unavailable.
4. Verify the selected nav state and view-as transitions do not strand the user.

## Task 7: Sortable Users and Staff tables plus terminology/grouping

**Objective:** Make both lists sortable and distinguish account enablement from rotation activation.

**Files:**
- Modify: `apps/web/src/pages/UserManagement.tsx`
- Create/modify: `apps/web/src/pages/UserManagement.test.ts`
- Modify: `apps/web/src/pages/StaffList.tsx`
- Modify: `apps/web/src/pages/StaffList.test.ts`
- Modify shared table/CSS only if needed: `apps/web/src/ui/index.tsx`, `apps/web/src/styles.css`

**Steps:**
1. Write failing pure tests for stable ascending/descending sorting and active/inactive partitioning.
2. Confirm RED.
3. Add sortable Name/Email/Role/Status columns on Users and Rep/Status/Ups columns on Staff.
4. Render Users in an active account table followed by a separate `Inactive accounts` bucket.
5. Rename Users controls/status to `Enable`/`Disable` and `ENABLED`/`DISABLED`.
6. Keep Staff List rotation actions as `Activate`/`Deactivate`; update preset copy such as `Activated in error` as needed.
7. Ensure active-but-INELIGIBLE reps remain in Staff List's unavailable status.
8. Run web tests.

## Task 8: Assign-screen keyboard, required markers, plain phone, and reassign UI (depends on Tasks 2 and 4)

**Objective:** Complete the assign workflow and expose manager reassignment beyond the Alt+V void period.

**Files:**
- Modify: `apps/web/src/pages/AssignScreen.tsx`
- Modify: `apps/web/src/pages/AssignScreen.test.ts`
- Modify: `apps/web/src/pages/RepDetail.tsx`
- Modify: `apps/web/src/pages/RepDetail.test.ts`

**Steps:**
1. Write failing helper tests for keyboard-step intent and reassign target filtering.
2. Confirm RED.
3. Add `notesRef`; Enter on Phone focuses Notes; Enter on single-line Notes intent assigns; preserve Shift+Enter/newline behavior if Notes remains a textarea and preserve Ctrl+Enter global submit.
4. Add visible `required` markers and semantic `required`/`aria-required` to Name and Phone.
5. Remove the `tel:` anchor and render formatted phone as text beside Copy.
6. For `lead.assign.override`, add a Reassign action on assigned lead rows, target select of active reps, required reason, and `assignment.reassign` mutation.
7. Keep Alt+V as the recent own-assignment undo flow; do not make it the manager reassign mechanism.
8. Refresh affected rep/board data after reassign and surface errors in the modal.
9. Run targeted web and API tests.

## Task 9: Progress documentation and final review

**Objective:** Keep the queue spec truthful after each accepted task and perform a requirement-by-requirement review.

**Files:**
- Modify after each accepted item: `docs/superpowers/specs/7-31-queue.md`
- Update `docs/RUNBOOK.md` only if operation/deploy/env behavior changes (not expected).

**Steps:**
1. Move each completed queue item under Done with a short implementation/verification note.
2. Remove stale `Working top-down. Next up is item 3.` text.
3. Record remaining manual-browser gaps honestly; do not mark unexercised UI as browser-verified.
4. Review child outputs using required schema: status, findings, actions, files, verification, risks.
5. Inspect `git diff`, trace every changed permission/data path, and check no unrelated scope entered.

## Task 10: Final validation

**Objective:** Prove the integrated result works.

**Commands:**
1. Targeted RED/GREEN commands during each task.
2. `pnpm run test`
3. `pnpm run typecheck`
4. `pnpm run build`
5. Run browser verification against a local server if the database/browser prerequisites are available: profile menu, each real-role view-as, back origin from Staff and Dashboard, table sorting, inactive bucket, assign Enter flow, plain phone text, and manager reassign.
6. `git status --short --branch` and `git diff --check`.

**Success checklist:**
- ADMIN selects a real active profile; reads/UI reflect that account's actual permissions and self data; view-as cannot mutate.
- Dedicated audit page exists and `audit.view` is enforced server-side.
- Logout/change-password live behind one profile menu.
- Rep-detail Back returns to the opening page.
- Users and Staff are sortable.
- Assign Enter sequence is Name → Phone → Notes → assign; Name/Phone visibly and semantically required.
- Phone display has no `tel:` link.
- Managers/Admins can reassign old leads through the ledger-safe reassign path.
- Disabled accounts appear only in Users' inactive account bucket; active-but-INELIGIBLE reps remain visible.
- Users says Enable/Disable; Staff says Activate/Deactivate.
- Full test/typecheck/build pass.

## Risks and tradeoffs

- **Reassign is correctness-critical:** cycle membership and `lastAssignedAt` restoration can drift even when counters look right. Parent review and reconciliation tests are mandatory.
- **View-as must not become unaudited impersonation:** query-only enforcement is intentional. A full mutation-capable impersonation mode would need explicit actor/subject audit fields and is outside this queue.
- **Historic audit visibility:** disabled actors may appear by name in audit history; that is historical evidence, not an account list leak.
- **Node-only web tests:** pure helper tests cannot prove rendered focus/menu behavior. Browser verification is required when the local profile/server is usable, and any gap stays documented.
- **Spec wording says admin-only audit while the existing permission matrix grants `audit.view` to ADMIN and MANAGER.** The user explicitly says "admin roles only" and success criteria says "admin roles" plural; this plan preserves the established ADMIN/MANAGER `audit.view` matrix unless the user later narrows it to literal ADMIN only.
