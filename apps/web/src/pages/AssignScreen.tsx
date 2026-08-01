import { useCallback, useEffect, useRef, useState } from 'react'
import { mutate, query } from '../lib/api'
import { mutationErrorMessage } from '../lib/mutationError'
import { useBoardRealtime } from '../lib/useBoardRealtime'
import { digitsOnly, useClipboardStore } from '../state/clipboardStore'
import { canMutateInCurrentView, isReadOnlyViewAs, useAuthStore } from '../state/authStore'
import { Badge, Button, Card, Field, Input, Textarea } from '../ui'
import { Modal } from '../ui/Modal'
import { useSubmitOnEnter } from '../ui/useSubmitOnEnter'
import {
  assignFormErrors,
  bucketRoster,
  canSubmitSkip,
  canSubmitWithRoster,
  formatAssignmentTime,
  resultGuidance,
  type AssignResult,
  type RosterEntry,
} from './assignment/model'

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

function loadRoster(): Promise<RosterEntry[]> {
  return query<RosterEntry[]>('board.roster')
}

function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  return phone.startsWith('+') ? phone : `+1${phone}`
}

export function copyOutcomeMessage(succeeded: boolean): string {
  return succeeded
    ? 'Phone number copied — Alt+C copies it again.'
    : 'Auto-copy blocked — press Alt+C or click Copy phone.'
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
  const [skipReasonOpen, setSkipReasonOpen] = useState(false)
  const [skipReason, setSkipReason] = useState('')
  const [skipError, setSkipError] = useState<string | null>(null)
  const [skipKey, setSkipKey] = useState('')
  const [skipping, setSkipping] = useState(false)
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
  const canSkip = canMutateInCurrentView(hasPermission('lead.skip'), viewAsUserId)
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
    setSkipReasonOpen(false)
    setSkipReason('')
    setSkipError(null)
    setSkipKey('')
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
      setError(mutationErrorMessage(err, 'The assignment could not be completed. Try again.'))
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
      setVoidError(mutationErrorMessage(err, 'This assignment could not be voided. Try again.'))
    }
  }

  function openSkip() {
    if (!lastResult?.assignedRepId || !canSkip) return
    setSkipReason('')
    setSkipError(null)
    setSkipKey(crypto.randomUUID())
    setSkipReasonOpen(true)
  }

  function closeSkip() {
    if (skipping) return
    setSkipReasonOpen(false)
    setSkipReason('')
    setSkipError(null)
    setSkipKey('')
  }

  async function handleSkip() {
    if (!lastResult?.assignedRepId || !skipKey || !canSkip) return
    if (!canSubmitSkip(skipReason, skipping, readOnly)) return
    setSkipping(true)
    setSkipError(null)
    try {
      const result = await mutate<AssignResult>('assignment.skip', {
        leadId: lastResult.leadId,
        expectedRepId: lastResult.assignedRepId,
        reasonNote: skipReason,
        idempotencyKey: skipKey,
      })
      setLastResult(result)
      refreshRoster()
    } catch (err) {
      setSkipError(mutationErrorMessage(err, 'This rep could not be skipped. Try again.'))
    } finally {
      setSkipping(false)
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
        <div className="ui-assign-header">
          <div>
            <h2>Assign Lead</h2>
            <p className="ui-hint">Enter the customer, then assign when you are ready. Opening this page does not lock the rotation.</p>
          </div>
          <Button
            className="ui-assign-action"
            variant="primary"
            onClick={handleAssign}
            disabled={!canSubmitWithRoster(formValid, hasLoadedRoster, assigning, readOnly)}
          >
            {assigning ? 'Assigning…' : 'Assign (Ctrl+Enter)'}
          </Button>
        </div>
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
        </div>

        {lastResult && (
          <Card title="Just Assigned" className="ui-stack">
            <div role="status" aria-live="polite">
              {lastResult.assignedRepId ? (
                <p><strong>{lastResult.customerName}</strong> assigned to{' '}
                  <strong>{nameById.get(lastResult.assignedRepId) ?? lastResult.assignedRepId}</strong>{' '}
                  at {formatAssignmentTime(lastResult.assignedAt)}.
                </p>
              ) : (
                <p><strong>{lastResult.customerName}</strong> was not assigned at {formatAssignmentTime(lastResult.assignedAt)}.</p>
              )}
              {resultGuidance(lastResult).map((message) => (
                <p key={message} className={lastResult.duplicatePhone ? 'ui-warn' : 'ui-muted'}>{message}</p>
              ))}
            </div>
            {lastResult.assignedRepId && (
              <>
                <div className="ui-row">
                  <Button onClick={handleCopyClick}>Copy phone (digits only)</Button>
                  {canSkip && (
                    <Button onClick={openSkip} disabled={skipping}>
                      {skipping ? 'Skipping…' : 'Skip rep'}
                    </Button>
                  )}
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
                <p className="ui-muted">No eligible unserved rep. Ask a Manager to confirm availability before assigning; otherwise the lead will be saved unassigned.</p>
              )}
            </div>

            <div className="ui-bucket">
              <div className="ui-bucket-head">
                <h5>On Deck</h5>
                <span className="ui-muted">{onDeck.length}</span>
              </div>
              {onDeck.length === 0 ? (
                <p className="ui-muted">{nextUp ? 'Next Up is the final unserved rep; the rotation starts a new cycle after them.' : 'No additional unserved reps are available. Ask a Manager to check roster status.'}</p>
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
        open={skipReasonOpen}
        title={`Skip ${lastResult?.assignedRepId ? nameById.get(lastResult.assignedRepId) ?? 'this rep' : 'this rep'}?`}
        onClose={closeSkip}
        onSubmit={handleSkip}
        submitDisabled={!canSubmitSkip(skipReason, skipping, readOnly)}
        submitLabel={skipping ? 'Skipping…' : 'Skip rep and pass lead'}
        hint="Review the rep and reason, then click Skip rep and pass lead. Esc cancels."
      >
        <p>The same lead will pass to the next available rep. This rep stays served for the current cycle.</p>
        <Field label="Skip reason" error={skipError}>
          <Input value={skipReason} onChange={(event) => setSkipReason(event.target.value)} disabled={skipping} />
        </Field>
      </Modal>

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
