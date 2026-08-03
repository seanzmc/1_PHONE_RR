# Priority 4C Management Copy and Accessibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Staff List and User Management purposes, bulk actions, password behavior, sort state, and repeated row targets understandable without changing recent navigation or visual work.

**Architecture:** Extend the shared Table header input with optional semantic metadata while preserving every existing caller. Add exact approved copy and target-name helpers at the page layer, then verify the rendered markup with server-side static rendering and authenticated browser accessibility checks.

**Tech Stack:** TypeScript, React 19, React DOM server rendering, shared UI primitives, Vitest.

## Global Constraints

- Governing spec: `docs/superpowers/specs/2026-08-02-priority-4-staff-user-management-design.md`.
- Use Node 22.x and pnpm 11.17.0 for final validation.
- Preserve role-aware navigation, Management/profile menus, page-heading focus, 1024px/390px containment, AA tokens, dynamic live regions, password Show/Hide controls, and read-only View-as.
- Do not add dependencies, edit password security behavior, merge account-disabled with rep-inactive, or add display-name editing/backfill.
- Plan 4A lands first so its `RecurringDayOffEditor` receives the approved target-specific group name here.

---

### Task 1: Add backward-compatible semantic table headers

**Files:**
- Modify: `apps/web/src/ui/index.tsx:130-147`
- Modify: `apps/web/src/ui/index.test.ts`

**Interfaces:**
- Produces: `TableHeader` `{ content: ReactNode; ariaSort?: 'ascending' | 'descending' }` accepted alongside existing `ReactNode` headers.
- Consumers: Staff List and User Management sort-header builders.

- [ ] **Step 1: Write a failing static-markup test**

```ts
import { Table } from './index'

const html = renderToStaticMarkup(createElement(Table, {
  headers: [{
    content: createElement('button', { 'aria-label': 'Sort by Name' }, 'Name ↑'),
    ariaSort: 'ascending',
  }, 'Actions'],
}, createElement('tr', null, createElement('td', null, 'Taylor'))))

expect(html).toContain('<th aria-sort="ascending">')
expect(html).toContain('aria-label="Sort by Name"')
expect(html).toContain('<th>Actions</th>')
```

- [ ] **Step 2: Run and verify the object-render failure**

Run: `pnpm --filter @phoneup/web test -- src/ui/index.test.ts`

Expected: FAIL because `Table` treats the metadata object as a React child.

- [ ] **Step 3: Implement the union and discriminator**

```ts
export type TableHeader = {
  content: ReactNode
  ariaSort?: 'ascending' | 'descending'
}

function isTableHeader(header: ReactNode | TableHeader): header is TableHeader {
  return !!header && typeof header === 'object' && 'content' in header
}

export function Table({ headers, children }: {
  headers: Array<ReactNode | TableHeader>
  children: ReactNode
}) {
  // For metadata headers render <th aria-sort={header.ariaSort}>{header.content}</th>.
  // Render all existing ReactNode headers exactly as before.
}
```

- [ ] **Step 4: Run the shared UI test**

Run: `pnpm --filter @phoneup/web test -- src/ui/index.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the shared primitive**

```bash
git add apps/web/src/ui/index.tsx apps/web/src/ui/index.test.ts
git commit -m "feat(web): expose semantic table sort state"
```

### Task 2: Add Staff List purpose, bulk guidance, and target names

**Files:**
- Modify: `apps/web/src/pages/StaffList.tsx`
- Modify: `apps/web/src/pages/StaffList.test.ts`

**Interfaces:**
- Consumes: `TableHeader`; Plan 4A `RecurringDayOffEditor`.
- Produces: `staffTargetName`, `StaffStatusActions`, semantic sort headers, approved purpose/guidance copy.

- [ ] **Step 1: Add failing rendered-markup and helper cases**

```ts
expect(staffTargetName({ displayName: 'Taylor Reed', repId: 'id' })).toBe('Taylor Reed')

const html = renderToStaticMarkup(createElement(StaffStatusActions, {
  entry: entry({ repId: 'a', displayName: 'Taylor Reed' }),
  canOverride: true,
  onChoose: () => {},
}))
expect(html).toContain('aria-label="Deactivate Taylor Reed"')
expect(html).toContain('aria-label="Reactivate Taylor Reed"')
```

Update the Plan 4A radio test to require `aria-label="Recurring day off for Taylor Reed"`. Add static rendering for a sort header and assert `aria-sort="ascending"` plus `aria-label="Sort by Rep"`.

- [ ] **Step 2: Run and verify missing semantics/copy**

Run: `pnpm --filter @phoneup/web test -- src/pages/StaffList.test.ts`

Expected: FAIL because `StaffStatusActions`, sort metadata, and target labels are absent.

- [ ] **Step 3: Add the approved Staff List copy**

Render directly below the heading:

```tsx
<p className="ui-muted">Manage rotation status, availability overrides, and one recurring day off for each rep.</p>
```

When `canOverride && selected.length === 0`, render:

```tsx
<p className="ui-hint">Select reps with the checkboxes to reactivate or deactivate several at once.</p>
```

Keep the selected-count bulk toolbar unchanged once selection is non-empty. Keep the Plan 4A day-off guidance: “Choose None or one recurring day off, Monday through Saturday. Changes are saved together.”

- [ ] **Step 4: Add semantic sort/row labels**

Return table-header metadata from `sortHeader`:

```tsx
return {
  content: <button type="button" className="ui-sortbtn" aria-label={`Sort by ${label}`} onClick={() => changeSort(key)}>
    {label} {active ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}
  </button>,
  ariaSort: active ? (sortDirection === 'asc' ? 'ascending' : 'descending') : undefined,
} satisfies TableHeader
```

Give per-row status buttons `aria-label={`${STATUS_LABEL[status]} ${r.displayName}`}` and the radio container `role="radiogroup" aria-label={`Recurring day off for ${r.displayName}`}`. Preserve visible button text and no-op titles.

- [ ] **Step 5: Run focused Staff List tests and commit**

```bash
pnpm --filter @phoneup/web test -- src/pages/StaffList.test.ts src/ui/index.test.ts
git add apps/web/src/pages/StaffList.tsx apps/web/src/pages/StaffList.test.ts
git commit -m "fix(staff): clarify bulk actions and control targets"
```

### Task 3: Clarify User Management and password actions

**Files:**
- Modify: `apps/web/src/pages/UserManagement.tsx`
- Modify: `apps/web/src/pages/UserManagement.test.ts`

**Interfaces:**
- Consumes: `TableHeader`.
- Produces: `accountTargetName`, `UserAccountRow`, approved labels/copy, semantic sort state.

- [ ] **Step 1: Add failing copy and rendered-row tests**

```ts
expect(accountTargetName(account({ id: 'x', displayName: null, email: 'x@example.test' }))).toBe('x@example.test')

const html = renderToStaticMarkup(createElement(UserAccountRow, {
  account: account({ id: 'x', displayName: 'Taylor Reed', mustChangePassword: true }),
  sessionUserId: 'someone-else',
  canManageUsers: true,
  onRole: () => {}, onToggleActive: () => {}, onGenerateTemporary: () => {}, onSetTemporary: () => {},
}))
expect(html).toContain('PASSWORD CHANGE REQUIRED')
expect(html).toContain('aria-label="Role for Taylor Reed"')
expect(html).toContain('aria-label="Disable Taylor Reed"')
expect(html).toContain('aria-label="Generate temporary password for Taylor Reed"')
expect(html).toContain('aria-label="Set temporary password for Taylor Reed"')
```

- [ ] **Step 2: Run and verify current label/name failures**

Run: `pnpm --filter @phoneup/web test -- src/pages/UserManagement.test.ts`

Expected: FAIL because the pure row and approved labels do not exist.

- [ ] **Step 3: Extract the account row and add target-specific names**

```ts
export function accountTargetName(account: Account): string {
  return account.displayName ?? account.email
}
```

Extract current row markup to `UserAccountRow` without moving mutation state. Pass handlers from `UserManagement`. Keep self-role disabling and its title. Add target-specific `aria-label` to role, Enable/Disable, Generate temporary password, and Set temporary password controls.

- [ ] **Step 4: Apply exact visible copy and forced-change explanations**

Use:

```tsx
<h2>User Management</h2>
<p className="ui-muted">Manage accounts, roles, temporary passwords, and sign-in access.</p>
```

Change visible labels to **Generate temporary password**, **Set temporary password…**, **PASSWORD CHANGE REQUIRED**, and **(no display name)**. Change the manual modal title to `Set temporary password — [target]`. Use this hint for both initial and manual administrator-issued fields:

```text
Minimum 8 characters. This password is temporary; the user must replace it at next sign-in.
```

Retain `PasswordInput`, field-specific Show/Hide labels, `autocomplete="new-password"`, and the generated result modal's shown-once/security explanation.

- [ ] **Step 5: Add User Management sort metadata**

Use the same `TableHeader` structure as Staff List with `aria-label="Sort by Name"`, Email, Role, and Account status. Both enabled and inactive tables consume the same header array and therefore expose identical sort state.

- [ ] **Step 6: Run focused tests and commit**

```bash
pnpm --filter @phoneup/web test -- src/pages/UserManagement.test.ts src/ui/index.test.ts
git add apps/web/src/pages/UserManagement.tsx apps/web/src/pages/UserManagement.test.ts
git commit -m "fix(users): clarify password actions and accessibility"
```

### Task 4: Run complete Priority 4 verification and update status evidence

**Files:**
- Modify after every check passes: `docs/Revised consolidated action list.md:36-50`
- Verify: all files changed by Plans 4A–4C.

**Interfaces:**
- Consumes: completed Plans 4A, 4B, and 4C.
- Produces: evidence-backed Priority 4 completion record; no deployment claim.

- [ ] **Step 1: Run focused tests from all three plans**

```bash
pnpm --filter @phoneup/contracts test -- src/daysOffSchemas.test.ts
pnpm --filter @phoneup/api test -- src/domain/daysOff.test.ts src/routers/rep.test.ts src/domain/statusAuthority.test.ts src/jobs/activityImportDecision.test.ts src/jobs/eligibility.test.ts src/domain/overrideStatus.test.ts src/domain/bulkOverrideStatus.test.ts src/realtime/server.test.ts
pnpm --filter @phoneup/web test -- src/pages/StaffList.test.ts src/pages/UserManagement.test.ts src/ui/index.test.ts
```

- [ ] **Step 2: Run full serial and static gates**

```bash
pnpm test
pnpm typecheck
pnpm --filter @phoneup/web lint
pnpm build
git diff --check
```

Expected: all pass. Attribute any broad-suite failure by rerunning the exact case at HEAD and its parent before calling it pre-existing.

- [ ] **Step 3: Run authenticated browser verification**

At 1024x768 and 390x844 verify Manager and Admin compact/edit days-off flow, Save/Cancel/failure, bulk hint transition, exact User Management labels, missing-name copy, password Show/Hide controls, sort state in the accessibility tree, target-specific control names, read-only View-as, Management/profile menu containment, active navigation, and page-heading focus. Use two connected clients for manual status and saved-day-off refresh.

- [ ] **Step 4: Update the consolidated action list with exact evidence**

Mark only the implemented Priority 4 bullets complete. Record commit(s), focused/full test counts, typecheck/lint/build/diff results, browser viewports, two-client realtime proof, Node version, and that deployment/production verification remain outstanding. Do not copy planned claims as completed evidence.

- [ ] **Step 5: Commit the completion receipt**

```bash
git add 'docs/Revised consolidated action list.md'
git commit -m "docs: record priority 4 completion"
```
