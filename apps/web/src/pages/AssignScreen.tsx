import { useCallback, useEffect, useRef, useState } from 'react'
import { mutate, query } from '../lib/api'
import { useBoardRealtime } from '../lib/useBoardRealtime'
import { digitsOnly, useClipboardStore } from '../state/clipboardStore'
import { canMutateInCurrentView, isReadOnlyViewAs, useAuthStore } from '../state/authStore'
import { Badge, Button, Card, Field, Input, Textarea } from '../ui'
import { Modal } from '../ui/Modal'
import { useSubmitOnEnter } from '../ui/useSubmitOnEnter'

type RosterEntry = {
  repId: string
  displayName: string
  isEligible: boolean
  ineligibleReason?: string
  servedThisCycle: boolean
  monthlyLoad: number
}

export function RosterRepName({
  entry,
  onOpenRep,
}: {
  entry: RosterEntry
  onOpenRep?: (repId: string) => void
}) {
  if (!onOpenRep) return <>{entry.displayName}</>
  return (
    <button type="button" className="ui-linkbtn" onClick={() => onOpenRep(entry.repId)}>
      {entry.displayName}
    </button>
  )
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
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  return phone.startsWith('+') ? phone : `+1${phone}`
}

/**
 * Client-side mirror of the name/phone rules in assignLeadInputSchema. Without this, an
 * invalid submit reaches tRPC and the stringified Zod issues array renders as the error —
 * unreadable for a BDC agent mid-call. `toE164` accepts exactly these two digit shapes.
 */
export function assignFormErrors(name: string, phone: string): { name?: string; phone?: string } {
  const errors: { name?: string; phone?: string } = {}
  if (!name.trim()) errors.name = "Enter the customer's name."
  const digits = phone.replace(/\D/g, '')
  if (!(digits.length === 10 || (digits.length === 11 && digits.startsWith('1')))) {
    errors.phone = 'Enter the 10-digit phone number — we add the +1 for you.'
  }
  return errors
}

export function assignEnterAction(field: 'name' | 'phone' | 'notes'): 'phone' | 'notes' | 'assign' {
  if (field === 'name') return 'phone'
  if (field === 'phone') return 'notes'
  return 'assign'
}

export function canSubmitWithRoster(
  formValid: boolean,
  hasLoadedRoster: boolean,
  assigning = false,
  readOnly = false,
): boolean {
  return formValid && hasLoadedRoster && !assigning && !readOnly
}

export function copyOutcomeMessage(succeeded: boolean): string {
  return succeeded
    ? 'Phone number copied — Alt+C copies it again.'
    : 'Auto-copy blocked — press Alt+C or click Copy phone.'
}

/**
 * Four buckets, non-leaky — every rep appears in exactly one (design pass §B):
 *   nextUp   : the single rep the next lead goes to
 *   onDeck   : eligible AND unserved this cycle, numbered from 2
 *   served   : eligible but already served this cycle (with their ups count)
 *   unavailable: not eligible (with reason)
 * Pure display partition — the ranking itself is untouched.
 */
export function bucketRoster(roster: RosterEntry[]) {
  const eligible = roster.filter((r) => r.isEligible)
  const unserved = eligible.filter((r) => !r.servedThisCycle)
  const [nextUp, ...onDeck] = unserved
  return {
    nextUp: nextUp ?? null,
    onDeck,
    served: eligible.filter((r) => r.servedThisCycle),
    unavailable: roster.filter((r) => !r.isEligible),
  }
}

export function AssignScreen({ onOpenRep }: { onOpenRep?: (repId: string) => void }) {
  const { hasPermission, viewAsUserId } = useAuthStore()
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
  const [copyFailed, setCopyFailed] = useState(false)
  const [copyNotice, setCopyNotice] = useState<string | null>(null)
  const [hasLoadedRoster, setHasLoadedRoster] = useState(false)
  const [assigning, setAssigning] = useState(false)
  // Errors only render for fields the user has touched (or after a submit attempt) —
  // a pristine form stays quiet instead of shouting about fields nobody reached yet.
  const [touched, setTouched] = useState({ name: false, phone: false })
  const nameRef = useRef<HTMLInputElement>(null)
  const phoneRef = useRef<HTMLInputElement>(null)
  const notesRef = useRef<HTMLTextAreaElement>(null)
  const { lastCopiedPhone, setLastCopiedPhone } = useClipboardStore()

  const readOnly = isReadOnlyViewAs(viewAsUserId)
  const canVoid = canMutateInCurrentView(hasPermission('lead.void'), viewAsUserId)
  const formErrors = assignFormErrors(name, phone)
  const formValid = !formErrors.name && !formErrors.phone

  const [loadError, setLoadError] = useState(false)

  const refreshRoster = useCallback(() => {
    setLoadError(false)
    loadRoster()
      .then((rows) => {
        setRoster(rows)
        setHasLoadedRoster(true)
        setLoadError(false)
      })
      // Never swallow this: an empty roster renders as "no eligible unserved rep" and
      // "Everyone is available", so a failed load would masquerade as the truth.
      .catch(() => setLoadError(true))
  }, [])

  useEffect(() => {
    refreshRoster()
  }, [refreshRoster])

  useBoardRealtime(refreshRoster)

  // Alt+C — re-copy the last assigned phone (existing shortcut, unchanged)
  useEffect(() => {
    function onKeydown(e: KeyboardEvent) {
      if (e.altKey && e.code === 'KeyC' && lastCopiedPhone) {
        navigator.clipboard.writeText(lastCopiedPhone)
          .then(() => {
            setCopyFailed(false)
            setCopyNotice(copyOutcomeMessage(true))
          })
          .catch(() => {
            setCopyFailed(true)
            setCopyNotice(copyOutcomeMessage(false))
          })
      }
    }
    window.addEventListener('keydown', onKeydown)
    return () => window.removeEventListener('keydown', onKeydown)
  }, [lastCopiedPhone])

  // Alt+V — open the void prompt (existing shortcut, unchanged)
  useEffect(() => {
    function onKeydown(e: KeyboardEvent) {
      if (e.altKey && e.code === 'KeyV' && lastResult?.assignedRepId && canVoid) {
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

  async function handleAssign() {
    // Invalid input must never reach the server — tRPC would return the raw Zod
    // issues array and that JSON blob would render as the on-screen error.
    setTouched({ name: true, phone: true })
    if (!canSubmitWithRoster(formValid, hasLoadedRoster, assigning, readOnly)) return
    setAssigning(true)
    setError(null)
    setCopyFailed(false)
    setCopyNotice(null)
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
      setLastResult(result)
      navigator.clipboard.writeText(digits)
        .then(() => setCopyNotice(copyOutcomeMessage(true)))
        .catch(() => {
          setCopyFailed(true)
          setCopyNotice(copyOutcomeMessage(false))
        })
      setName('')
      setPhone('')
      setNotes('')
      setIdempotencyKey(crypto.randomUUID())
      setTouched({ name: false, phone: false })
      refreshRoster()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'assign failed')
    } finally {
      setAssigning(false)
    }
  }

  // Ctrl+Enter anywhere in the form submits (existing behaviour, unchanged)
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
      notesRef.current?.focus()
    }
  }

  function handleNotesKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      handleAssign()
    }
  }

  function handleCopyClick() {
    if (lastCopiedPhone) {
      navigator.clipboard.writeText(lastCopiedPhone)
        .then(() => {
          setCopyFailed(false)
          setCopyNotice(copyOutcomeMessage(true))
        })
        .catch(() => {
          setCopyFailed(true)
          setCopyNotice(copyOutcomeMessage(false))
        })
    }
  }

  async function handleVoid() {
    if (!lastResult || !canVoid) return
    setVoidError(null)
    if (!voidReason.trim()) {
      setVoidError('Reason is required')
      return
    }
    try {
      await mutate('assignment.void', { leadId: lastResult.leadId, reasonNote: voidReason })
      setLastResult(null)
      refreshRoster()
      nameRef.current?.focus()
    } catch (err) {
      setVoidError(err instanceof Error ? err.message : 'void failed')
    }
  }

  const onVoidKeyDown = useSubmitOnEnter(handleVoid, { disabled: !voidReason.trim() })

  const nameById = new Map(roster.map((r) => [r.repId, r.displayName]))
  const { nextUp, onDeck, served, unavailable } = bucketRoster(roster)

  function repName(entry: RosterEntry) {
    return <RosterRepName entry={entry} onOpenRep={onOpenRep} />
  }

  return (
    <div className="ui-page ui-split" onKeyDown={handleKeyDown}>
      <div>
        <h2>Assign Lead</h2>
        <div className="ui-stack">
          <Field label="Name *" error={touched.name ? formErrors.name : null}>
            <Input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleNameKeyDown}
              onBlur={() => setTouched((t) => ({ ...t, name: true }))}
              placeholder="Customer name"
              autoFocus
              disabled={assigning || readOnly}
              required
            />
          </Field>
          <Field
            label="Phone *"
            hint="10 digits, or +1XXXXXXXXXX"
            error={touched.phone ? formErrors.phone : null}
          >
            <Input
              ref={phoneRef}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onKeyDown={handlePhoneKeyDown}
              onBlur={() => setTouched((t) => ({ ...t, phone: true }))}
              placeholder="(555) 123-4567"
              inputMode="tel"
              disabled={assigning || readOnly}
              required
            />
          </Field>
          <Field label="Notes (optional)">
            <Textarea
              ref={notesRef}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onKeyDown={handleNotesKeyDown}
              placeholder="Anything the rep should know before calling"
              disabled={assigning || readOnly}
            />
          </Field>
          {error && <p className="ui-error" role="alert">{error}</p>}
          <Button
            variant="primary"
            onClick={handleAssign}
            disabled={!canSubmitWithRoster(formValid, hasLoadedRoster, assigning, readOnly)}
          >
            {assigning ? 'Assigning…' : 'Assign (Ctrl+Enter)'}
          </Button>
        </div>

        {lastResult && (
          <Card title="Just Assigned" className="ui-stack">
            <div role="status" aria-live="polite">
              {lastResult.assignedRepId ? (
                <p>
                  Assigned to <strong>{nameById.get(lastResult.assignedRepId) ?? lastResult.assignedRepId}</strong>
                </p>
              ) : (
                <p>No eligible rep — lead queued as unassigned.</p>
              )}
              {lastResult.duplicatePhone && <p className="ui-warn">Warning: this phone number already exists.</p>}
            </div>
            {lastResult.assignedRepId && (
              <>
                <div className="ui-row">
                  <Button onClick={handleCopyClick}>Copy phone (digits only)</Button>
                  {canVoid && (
                    <Button variant="danger" onClick={() => setVoidReasonOpen(true)}>
                      Void (Alt+V)
                    </Button>
                  )}
                </div>
              </>
            )}
          </Card>
        )}
        {copyNotice && (
          <p className={copyFailed ? 'ui-warn' : 'ui-hint'} role="status" aria-live="polite">
            {copyNotice}
          </p>
        )}
      </div>

      <div>
        <h2>Roster</h2>

        {loadError && roster.length > 0 && (
          <p className="ui-warn" role="status">
            Couldn't refresh — showing the last good roster.{' '}
            <button type="button" className="ui-linkbtn" onClick={refreshRoster}>
              Retry
            </button>
          </p>
        )}
        {!hasLoadedRoster && !loadError ? (
          <p className="ui-muted">Loading roster…</p>
        ) : loadError && roster.length === 0 ? (
          <p className="ui-error" role="alert">
            Couldn't load the roster — check your connection.{' '}
            <button type="button" className="ui-linkbtn" onClick={refreshRoster}>
              Retry
            </button>
          </p>
        ) : (
          <>
            <div className="ui-bucket">
              <div className="ui-bucket-head">
                <h5>Next Up</h5>
              </div>
              {nextUp ? (
                <div className="ui-nextup">{repName(nextUp)}</div>
              ) : (
                <p className="ui-muted">No eligible unserved rep — the next lead queues as unassigned.</p>
              )}
            </div>

            <div className="ui-bucket">
              <div className="ui-bucket-head">
                <h5>On Deck</h5>
                <span className="ui-muted">{onDeck.length}</span>
              </div>
              {onDeck.length === 0 ? (
                <p className="ui-muted">Nobody else is unserved this cycle.</p>
              ) : (
                <ul className="ui-list">
                  {onDeck.map((r, i) => (
                    <li key={r.repId}>
                      {/* numbered from 2 — Next Up is 1 */}
                      <span className="ui-list-rank">{i + 2}</span>
                      {repName(r)}
                      <span className="ui-muted">{r.monthlyLoad} ups MTD</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="ui-bucket">
              <div className="ui-bucket-head">
                <h5>Served This Cycle</h5>
                <span className="ui-muted">{served.length}</span>
              </div>
              {served.length === 0 ? (
                <p className="ui-muted">Nobody served yet this cycle.</p>
              ) : (
                <ul className="ui-list">
                  {served.map((r) => (
                    <li key={r.repId}>
                      {repName(r)}
                      <Badge tone="accent">{r.monthlyLoad} ups MTD</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="ui-bucket">
              <div className="ui-bucket-head">
                <h5>Unavailable</h5>
                <span className="ui-muted">{unavailable.length}</span>
              </div>
              {unavailable.length === 0 ? (
                <p className="ui-muted">Everyone is available.</p>
              ) : (
                <ul className="ui-list">
                  {unavailable.map((r) => (
                    <li key={r.repId}>
                      {repName(r)}
                      <Badge tone="warn">{r.ineligibleReason ?? 'ineligible'}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>

      <Modal
        open={voidReasonOpen}
        title="Void this assignment"
        onClose={() => {
          setVoidReasonOpen(false)
          setVoidReason('')
          setVoidError(null)
        }}
        onSubmit={handleVoid}
        submitDisabled={!voidReason.trim()}
        submitLabel="Void"
      >
        <Field label="Void reason" error={voidError}>
          <Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} onKeyDown={onVoidKeyDown} />
        </Field>
        <p className="ui-hint">The up goes straight back to this rep — they become Next Up again.</p>
      </Modal>
    </div>
  )
}
