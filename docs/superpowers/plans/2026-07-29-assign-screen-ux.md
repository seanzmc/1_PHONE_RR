# Assign-Screen UX Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make lead entry on `AssignScreen` keyboard-first and zero-mouse for BDC agents: field-to-field Enter flow, auto `+1` phone formatting, auto-copy-to-clipboard on assign, auto-refocus for the next lead, and a new `Alt+V` void action reusing the existing (already-tested) `assignment.void` backend procedure.

**Architecture:** Single-file, in-place patch to `apps/web/src/pages/AssignScreen.tsx`. No new components, no backend changes — this is UI-only polish on top of an unchanged core assignment/void flow. Two tasks: (1) fast-entry flow (keyboard field advance, phone transform, auto-copy, auto-refocus), (2) the new void action (permission-gated, reuses `assignment.void`).

**Tech Stack:** Vite/React 19, hand-rolled fetch-based tRPC client (`apps/web/src/lib/api.ts`), zustand for local UI state (`useClipboardStore`, `useAuthStore`), plain inline styles (no CSS framework). No frontend test runner exists in this repo — verification is `tsc -b` (via the workspace's `build` script) plus manual/browser click-through, same as every other screen in `apps/web`.

## Global Constraints

- **Single file, no new components.** Everything in this plan modifies `apps/web/src/pages/AssignScreen.tsx` only. No new files, no backend changes.
- **API phone format is unchanged:** `customerPhoneE164` must match `^\+1\d{10}$` (`packages/contracts/src/schemas.ts`). The `+1` prepend is a client-side transform applied right before calling `mutate`, never sent to the server as a separate field.
- **Void input shape is fixed by the existing schema:** `voidLeadInputSchema = { leadId: string (uuid), reasonNote: string (min 1) }`. Void is never a bare one-keystroke action — it always requires a non-empty reason typed into an inline input.
- **Void shortcut is `Alt+V`, never bare `V`.** After a successful assign, focus auto-returns to the Name field — a bare `V` keystroke would land in the next lead's name.
- **Void UI only renders/wires when `lastResult?.assignedRepId` is present**, matching the approved spec (`docs/superpowers/specs/2026-07-29-assign-screen-ux-design.md`) — unassigned leads are out of scope for this void UI.
- **Permission gate:** void action only shows for roles where `hasPermission(role, 'lead.void')` is true (`packages/contracts/src/permissions.ts`: `ADMIN`, `MANAGER`, `BDC` — not `REP`). Role comes from `useAuthStore().session.role`.
- **No backend/domain/ranking changes of any kind.** `assignmentRouter.void` (`apps/api/src/routers/assignment.ts:21-65`) is reused exactly as-is.
- **Roster panel (On Deck/Unavailable lists) stays untouched** — explicit scope decision, do not restyle or restructure it.

---

### Task 1: Fast-entry flow — Enter-to-advance, phone auto-format, auto-copy, auto-refocus

**Files:**
- Modify: `apps/web/src/pages/AssignScreen.tsx` (entire file — full replacement given below)

**Interfaces:**
- Consumes: `mutate`/`query` from `../lib/api` (unchanged signatures: `mutate<T>(path: string, input?: unknown): Promise<T>`, `query<T>(path: string): Promise<T>`), `digitsOnly`/`useClipboardStore` from `../state/clipboardStore` (unchanged: `digitsOnly(phoneE164: string): string`, `useClipboardStore(): { lastCopiedPhone: string | null; setLastCopiedPhone: (digits: string) => void }`).
- Produces (for Task 2, which edits this same file next): the file's end-state after this task is the exact starting point Task 2 modifies. Key names Task 2 must reuse verbatim: component `AssignScreen`, state setter `setLastResult`, type `AssignResult` (fields `leadId: string`, `assignedRepId: string | null`, `queueSnapshot: RosterEntry[]`, `duplicatePhone: boolean`), function `refreshRoster()` (no args, refetches roster), function `handleAssign()` (no args), the single `useEffect(() => { ... }, [lastResult])` that currently only focuses `nameRef` — Task 2 extends this same effect rather than adding a second one.

- [ ] **Step 1: Replace the full contents of `apps/web/src/pages/AssignScreen.tsx`**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { mutate, query } from '../lib/api'
import { digitsOnly, useClipboardStore } from '../state/clipboardStore'

type RosterEntry = {
  repId: string
  displayName: string
  isEligible: boolean
  ineligibleReason?: string
  servedThisCycle: boolean
  monthlyLoad: number
}

type AssignResult = {
  leadId: string
  assignedRepId: string | null
  queueSnapshot: RosterEntry[]
  duplicatePhone: boolean
}

function loadRoster(): Promise<RosterEntry[]> {
  return query<RosterEntry[]>('board.roster')
}

function toE164(phone: string): string {
  return phone.startsWith('+') ? phone : `+1${phone}`
}

export function AssignScreen() {
  const [roster, setRoster] = useState<RosterEntry[]>([])
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [notes, setNotes] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [lastResult, setLastResult] = useState<AssignResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const phoneRef = useRef<HTMLInputElement>(null)
  const { lastCopiedPhone, setLastCopiedPhone } = useClipboardStore()

  const refreshRoster = useCallback(() => {
    loadRoster().then(setRoster).catch(() => {})
  }, [])

  useEffect(() => {
    refreshRoster()
  }, [refreshRoster])

  useEffect(() => {
    function onKeydown(e: KeyboardEvent) {
      if (e.altKey && e.key.toLowerCase() === 'c' && lastCopiedPhone) {
        navigator.clipboard.writeText(lastCopiedPhone).catch(() => {})
      }
    }
    window.addEventListener('keydown', onKeydown)
    return () => window.removeEventListener('keydown', onKeydown)
  }, [lastCopiedPhone])

  useEffect(() => {
    if (lastResult?.assignedRepId) {
      nameRef.current?.focus()
    }
  }, [lastResult])

  async function handleAssign() {
    setError(null)
    const phoneE164 = toE164(phone)
    try {
      const result = await mutate<AssignResult>('assignment.assign', {
        idempotencyKey,
        customerName: name,
        customerPhoneE164: phoneE164,
        notes: notes || undefined,
      })
      const digits = digitsOnly(phoneE164)
      setLastCopiedPhone(digits)
      navigator.clipboard.writeText(digits).catch(() => {})
      setLastResult(result)
      setName('')
      setPhone('')
      setNotes('')
      setIdempotencyKey(crypto.randomUUID())
      refreshRoster()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'assign failed')
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault()
      handleAssign()
    }
  }

  function handleNameKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.ctrlKey) {
      e.preventDefault()
      phoneRef.current?.focus()
    }
  }

  function handlePhoneKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.ctrlKey) {
      e.preventDefault()
      handleAssign()
    }
  }

  function handleCopyClick() {
    if (lastCopiedPhone) {
      navigator.clipboard.writeText(lastCopiedPhone).catch(() => {})
    }
  }

  const nameById = new Map(roster.map((r) => [r.repId, r.displayName]))
  const nextUp = roster.find((r) => r.isEligible && !r.servedThisCycle)
  const onDeck = roster.filter((r) => r.isEligible && r.repId !== nextUp?.repId)
  const unavailable = roster.filter((r) => !r.isEligible)

  return (
    <div style={{ display: 'flex', gap: 24, padding: 24 }} onKeyDown={handleKeyDown}>
      <div style={{ flex: 1 }}>
        <h2>Assign Lead</h2>
        <div style={{ marginBottom: 8 }}>
          <label>
            Name
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleNameKeyDown}
              style={{ display: 'block', width: '100%' }}
              autoFocus
            />
          </label>
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>
            Phone (10 digits, or +1XXXXXXXXXX)
            <input
              ref={phoneRef}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onKeyDown={handlePhoneKeyDown}
              style={{ display: 'block', width: '100%' }}
            />
          </label>
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>
            Notes (optional)
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ display: 'block', width: '100%' }} />
          </label>
        </div>
        {error && <p style={{ color: 'red' }}>{error}</p>}
        <button onClick={handleAssign}>Assign (Ctrl+Enter)</button>

        {lastResult && (
          <div style={{ marginTop: 24, border: '1px solid #ccc', padding: 12 }}>
            <h3>Just Assigned</h3>
            {lastResult.assignedRepId ? (
              <>
                <p>Assigned to: {nameById.get(lastResult.assignedRepId) ?? lastResult.assignedRepId}</p>
                <button onClick={handleCopyClick}>Copy phone (digits only)</button>
              </>
            ) : (
              <p>No eligible rep — lead queued as unassigned.</p>
            )}
            {lastResult.duplicatePhone && <p style={{ color: 'orange' }}>Warning: this phone number already exists.</p>}
          </div>
        )}
      </div>

      <div style={{ flex: 1 }}>
        <h2>Roster</h2>
        {nextUp && (
          <div style={{ fontWeight: 'bold', marginBottom: 8 }}>
            Next Up: {nextUp.displayName}
          </div>
        )}
        <h4>On Deck</h4>
        <ul>
          {onDeck.map((r) => (
            <li key={r.repId}>
              {r.displayName} — {r.monthlyLoad} ups this month
            </li>
          ))}
        </ul>
        <h4>Unavailable</h4>
        <ul>
          {unavailable.map((r) => (
            <li key={r.repId}>
              {r.displayName} — {r.ineligibleReason ?? 'ineligible'}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
```

Note what changed vs. the prior version: `copyButtonRef`/its focus-stealing effect are gone (name field refocuses instead); `toE164` transform added and applied before both the mutate call and the auto-copy; auto-copy now actually calls `navigator.clipboard.writeText` (the prior "Copy phone" button only updated the zustand store, it never wrote to the OS clipboard — this fixes that alongside adding auto-copy); `handleCopyClick` is a real fallback that re-writes the last-known digits.

- [ ] **Step 2: Typecheck and build**

Run: `pnpm --filter @phoneup/web build`
Expected: exits 0, no TypeScript errors (this runs `tsc -b && vite build`).

- [ ] **Step 3: Manual verification with the dev server**

Run: `pnpm --filter @phoneup/web dev` (and the API server per the existing dev workflow), log in as any BDC/MANAGER/ADMIN account, then on the Assign Lead screen:
1. Type a name, press `Enter` — focus moves to the Phone field (no page reload, no form submit).
2. Type 10 digits (e.g. `2135551234`, no `+1`), press `Enter` — the lead is assigned (confirm a "Just Assigned" card appears); no validation error about phone format.
3. Immediately paste (`Cmd+V`/`Ctrl+V`) into any other app's text field — the digits-only phone number (`2135551234`) should already be there, with no click required.
4. Confirm focus is back in the Name field immediately after step 2 (start typing a second lead's name without clicking anything).
5. Click "Copy phone (digits only)" on the result card — confirm it doesn't error (manual re-copy fallback path).

If Playwright MCP browser automation is available in this session, script the above instead of (or in addition to) manual eyeballing. If it fails the same way it did in the prior sub-project (socket-path-too-long under this sandbox's `TMPDIR`), document that as a known limitation exactly as before — do not report this step as passed without having actually driven a browser or gotten equivalent evidence.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/AssignScreen.tsx
git commit -m "feat(web): keyboard field flow, phone auto-format, real auto-copy on assign"
```

---

### Task 2: Void action (`Alt+V`)

**Files:**
- Modify: `apps/web/src/pages/AssignScreen.tsx` (entire file — full replacement given below, builds on Task 1's version)

**Interfaces:**
- Consumes: `useAuthStore` from `../state/authStore` (`useAuthStore(): { session: { role: Role; email: string } | null; ... }`), `hasPermission` from `@phoneup/contracts` (`hasPermission(role: Role, perm: Permission): boolean`), the exact Task-1 file shape described above (`AssignResult`, `lastResult`, `setLastResult`, `refreshRoster`, the single `useEffect(() => {...}, [lastResult])`).
- Produces: nothing consumed by a later task — this is the final task in this plan.

- [ ] **Step 1: Replace the full contents of `apps/web/src/pages/AssignScreen.tsx`**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { hasPermission } from '@phoneup/contracts'
import { mutate, query } from '../lib/api'
import { digitsOnly, useClipboardStore } from '../state/clipboardStore'
import { useAuthStore } from '../state/authStore'

type RosterEntry = {
  repId: string
  displayName: string
  isEligible: boolean
  ineligibleReason?: string
  servedThisCycle: boolean
  monthlyLoad: number
}

type AssignResult = {
  leadId: string
  assignedRepId: string | null
  queueSnapshot: RosterEntry[]
  duplicatePhone: boolean
}

function loadRoster(): Promise<RosterEntry[]> {
  return query<RosterEntry[]>('board.roster')
}

function toE164(phone: string): string {
  return phone.startsWith('+') ? phone : `+1${phone}`
}

export function AssignScreen() {
  const { session } = useAuthStore()
  const [roster, setRoster] = useState<RosterEntry[]>([])
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [notes, setNotes] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [lastResult, setLastResult] = useState<AssignResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [voidReasonOpen, setVoidReasonOpen] = useState(false)
  const [voidReason, setVoidReason] = useState('')
  const [voidError, setVoidError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const phoneRef = useRef<HTMLInputElement>(null)
  const voidReasonRef = useRef<HTMLInputElement>(null)
  const { lastCopiedPhone, setLastCopiedPhone } = useClipboardStore()

  const canVoid = session ? hasPermission(session.role, 'lead.void') : false

  const refreshRoster = useCallback(() => {
    loadRoster().then(setRoster).catch(() => {})
  }, [])

  useEffect(() => {
    refreshRoster()
  }, [refreshRoster])

  useEffect(() => {
    function onKeydown(e: KeyboardEvent) {
      if (e.altKey && e.key.toLowerCase() === 'c' && lastCopiedPhone) {
        navigator.clipboard.writeText(lastCopiedPhone).catch(() => {})
      }
    }
    window.addEventListener('keydown', onKeydown)
    return () => window.removeEventListener('keydown', onKeydown)
  }, [lastCopiedPhone])

  useEffect(() => {
    function onKeydown(e: KeyboardEvent) {
      if (e.altKey && e.key.toLowerCase() === 'v' && lastResult?.assignedRepId && canVoid) {
        e.preventDefault()
        setVoidReasonOpen(true)
      }
    }
    window.addEventListener('keydown', onKeydown)
    return () => window.removeEventListener('keydown', onKeydown)
  }, [lastResult, canVoid])

  useEffect(() => {
    if (lastResult?.assignedRepId) {
      nameRef.current?.focus()
    }
    setVoidReasonOpen(false)
    setVoidReason('')
    setVoidError(null)
  }, [lastResult])

  useEffect(() => {
    if (voidReasonOpen) {
      voidReasonRef.current?.focus()
    }
  }, [voidReasonOpen])

  async function handleAssign() {
    setError(null)
    const phoneE164 = toE164(phone)
    try {
      const result = await mutate<AssignResult>('assignment.assign', {
        idempotencyKey,
        customerName: name,
        customerPhoneE164: phoneE164,
        notes: notes || undefined,
      })
      const digits = digitsOnly(phoneE164)
      setLastCopiedPhone(digits)
      navigator.clipboard.writeText(digits).catch(() => {})
      setLastResult(result)
      setName('')
      setPhone('')
      setNotes('')
      setIdempotencyKey(crypto.randomUUID())
      refreshRoster()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'assign failed')
    }
  }

  async function handleVoid() {
    if (!lastResult) return
    setVoidError(null)
    try {
      await mutate('assignment.void', { leadId: lastResult.leadId, reasonNote: voidReason })
      setLastResult(null)
      refreshRoster()
    } catch (err) {
      setVoidError(err instanceof Error ? err.message : 'void failed')
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault()
      handleAssign()
    }
  }

  function handleNameKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.ctrlKey) {
      e.preventDefault()
      phoneRef.current?.focus()
    }
  }

  function handlePhoneKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.ctrlKey) {
      e.preventDefault()
      handleAssign()
    }
  }

  function handleCopyClick() {
    if (lastCopiedPhone) {
      navigator.clipboard.writeText(lastCopiedPhone).catch(() => {})
    }
  }

  function handleVoidReasonKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleVoid()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setVoidReasonOpen(false)
      setVoidReason('')
      setVoidError(null)
    }
  }

  const nameById = new Map(roster.map((r) => [r.repId, r.displayName]))
  const nextUp = roster.find((r) => r.isEligible && !r.servedThisCycle)
  const onDeck = roster.filter((r) => r.isEligible && r.repId !== nextUp?.repId)
  const unavailable = roster.filter((r) => !r.isEligible)

  return (
    <div style={{ display: 'flex', gap: 24, padding: 24 }} onKeyDown={handleKeyDown}>
      <div style={{ flex: 1 }}>
        <h2>Assign Lead</h2>
        <div style={{ marginBottom: 8 }}>
          <label>
            Name
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleNameKeyDown}
              style={{ display: 'block', width: '100%' }}
              autoFocus
            />
          </label>
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>
            Phone (10 digits, or +1XXXXXXXXXX)
            <input
              ref={phoneRef}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onKeyDown={handlePhoneKeyDown}
              style={{ display: 'block', width: '100%' }}
            />
          </label>
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>
            Notes (optional)
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} style={{ display: 'block', width: '100%' }} />
          </label>
        </div>
        {error && <p style={{ color: 'red' }}>{error}</p>}
        <button onClick={handleAssign}>Assign (Ctrl+Enter)</button>

        {lastResult && (
          <div style={{ marginTop: 24, border: '1px solid #ccc', padding: 12 }}>
            <h3>Just Assigned</h3>
            {lastResult.assignedRepId ? (
              <>
                <p>Assigned to: {nameById.get(lastResult.assignedRepId) ?? lastResult.assignedRepId}</p>
                <button onClick={handleCopyClick}>Copy phone (digits only)</button>
                {canVoid && (
                  <div style={{ marginTop: 8 }}>
                    {voidReasonOpen ? (
                      <div>
                        <label>
                          Void reason
                          <input
                            ref={voidReasonRef}
                            value={voidReason}
                            onChange={(e) => setVoidReason(e.target.value)}
                            onKeyDown={handleVoidReasonKeyDown}
                            style={{ display: 'block', width: '100%' }}
                          />
                        </label>
                        <p style={{ fontSize: 12, color: '#666' }}>Enter to confirm void, Esc to cancel</p>
                        {voidError && <p style={{ color: 'red' }}>{voidError}</p>}
                      </div>
                    ) : (
                      <p style={{ fontSize: 12, color: '#666' }}>Alt+V to void this assignment</p>
                    )}
                  </div>
                )}
              </>
            ) : (
              <p>No eligible rep — lead queued as unassigned.</p>
            )}
            {lastResult.duplicatePhone && <p style={{ color: 'orange' }}>Warning: this phone number already exists.</p>}
          </div>
        )}
      </div>

      <div style={{ flex: 1 }}>
        <h2>Roster</h2>
        {nextUp && (
          <div style={{ fontWeight: 'bold', marginBottom: 8 }}>
            Next Up: {nextUp.displayName}
          </div>
        )}
        <h4>On Deck</h4>
        <ul>
          {onDeck.map((r) => (
            <li key={r.repId}>
              {r.displayName} — {r.monthlyLoad} ups this month
            </li>
          ))}
        </ul>
        <h4>Unavailable</h4>
        <ul>
          {unavailable.map((r) => (
            <li key={r.repId}>
              {r.displayName} — {r.ineligibleReason ?? 'ineligible'}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck and build**

Run: `pnpm --filter @phoneup/web build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 3: Manual verification with the dev server**

Using a **BDC or MANAGER** account (role must have `lead.void` — not a REP account, which can't reach this screen anyway):
1. Assign a lead. On the result card, confirm the hint text "Alt+V to void this assignment" appears.
2. Press `Alt+V` — an inline "Void reason" input appears and is focused.
3. Type a reason (e.g. `test void`), press `Enter` — the result card disappears (lead voided), and the roster's monthly-load numbers refresh.
4. Repeat steps 1-2, then press `Escape` instead — confirm the reason input closes with nothing sent (no network request, result card stays as-is).
5. Repeat steps 1-2, press `Enter` with the reason field left empty — confirm the backend's validation error surfaces inline (the `reasonNote` schema requires min length 1) rather than silently failing.

Then log in with an **ADMIN** account and confirm the same flow works (ADMIN also has `lead.void`).

If Playwright MCP browser automation is available this session, script the above; if it hits the same sandbox limitation as the prior sub-project (Playwright socket-path-too-long), document that gap explicitly rather than silently skipping verification — same standard as Task 1's Step 3 and as the prior sub-project's final review.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/AssignScreen.tsx
git commit -m "feat(web): add Alt+V void action to assign screen"
```
