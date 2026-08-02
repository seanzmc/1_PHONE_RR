import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { mutate, query } from '../../lib/api'
import { mutationErrorMessage } from '../../lib/mutationError'
import { useBoardRealtime } from '../../lib/useBoardRealtime'
import { canMutateInCurrentView, isReadOnlyViewAs, useAuthStore } from '../../state/authStore'
import { Button, Card, Field, Input, Textarea } from '../../ui'
import { Drawer } from '../../ui/Drawer'
import { Modal } from '../../ui/Modal'
import { useSubmitOnEnter } from '../../ui/useSubmitOnEnter'
import { DiscardChangesDialog } from './DiscardChangesDialog'
import {
  assignFormErrors,
  canSubmitWithRoster,
  formatAssignmentTime,
  formatPhone,
  resultGuidance,
  shouldConfirmDrawerClose,
  type AssignResult,
  type RosterEntry,
  type SkipPreset,
} from './model'
import { RosterPanel } from './RosterPanel'
import { SkipReasonEditor } from './SkipReasonEditor'

export type AssignmentDrawerProps = {
  open: boolean
  onClose: () => void
  onOpenRep?: (repId: string) => void
}

export type AssignmentResultProps = {
  result: AssignResult
  repName: string | null
  phoneE164: string
  canSkip: boolean
  canVoid: boolean
  busy: boolean
  skipEditorOpen: boolean
  onSkip: () => void
  onVoid: () => void
  children?: ReactNode
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

export function isAssignmentBusy(assigning: boolean, skipping: boolean, voiding: boolean): boolean {
  return assigning || skipping || voiding
}

export function AssignmentResult({
  result,
  repName,
  phoneE164,
  canSkip,
  canVoid,
  busy,
  skipEditorOpen,
  onSkip,
  onVoid,
  children,
}: AssignmentResultProps) {
  const assignedName = repName ?? result.assignedRepId

  return (
    <Card title="Assignment saved" className="ui-stack">
      <div role="status" aria-live="polite">
        {result.assignedRepId ? (
          <p>
            <strong>{assignedName}</strong> will follow up with <strong>{result.customerName}</strong> at{' '}
            <strong>{formatPhone(phoneE164)}</strong>.
          </p>
        ) : (
          <p><strong>{result.customerName}</strong> was saved unassigned at {formatAssignmentTime(result.assignedAt)}.</p>
        )}
        {resultGuidance(result).map((message) => (
          <p key={message} className={result.duplicatePhone ? 'ui-warn' : 'ui-muted'}>{message}</p>
        ))}
      </div>
      {result.assignedRepId && (
        <div className="ui-row">
          {canSkip && !skipEditorOpen && (
            <Button onClick={onSkip} disabled={busy}>Skip rep</Button>
          )}
          {canVoid && (
            <Button variant="danger" onClick={onVoid} disabled={busy}>Void (Alt+V)</Button>
          )}
        </div>
      )}
      {children}
    </Card>
  )
}

export function AssignmentDrawer({ open, onClose, onOpenRep }: AssignmentDrawerProps) {
  const { hasPermission, viewAsUserId } = useAuthStore()
  const [roster, setRoster] = useState<RosterEntry[]>([])
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [notes, setNotes] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [lastResult, setLastResult] = useState<AssignResult | null>(null)
  const [resultPhoneE164, setResultPhoneE164] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [hasLoadedRoster, setHasLoadedRoster] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const [skipping, setSkipping] = useState(false)
  const [voiding, setVoiding] = useState(false)
  const [voidReasonOpen, setVoidReasonOpen] = useState(false)
  const [voidReason, setVoidReason] = useState('')
  const [voidError, setVoidError] = useState<string | null>(null)
  const [skipEditorOpen, setSkipEditorOpen] = useState(false)
  const [skipPreset, setSkipPreset] = useState<SkipPreset | null>(null)
  const [skipOtherDetail, setSkipOtherDetail] = useState('')
  const [skipError, setSkipError] = useState<string | null>(null)
  const [skipKey, setSkipKey] = useState('')
  const [discardChangesOpen, setDiscardChangesOpen] = useState(false)
  const [touched, setTouched] = useState({ name: false, phone: false })
  const nameRef = useRef<HTMLInputElement>(null)
  const phoneRef = useRef<HTMLInputElement>(null)
  const notesRef = useRef<HTMLTextAreaElement>(null)

  const readOnly = isReadOnlyViewAs(viewAsUserId)
  const canVoid = canMutateInCurrentView(hasPermission('lead.void'), viewAsUserId)
  const canSkip = canMutateInCurrentView(hasPermission('lead.skip'), viewAsUserId)
  const formErrors = assignFormErrors(name, phone)
  const formValid = !formErrors.name && !formErrors.phone
  const busy = isAssignmentBusy(assigning, skipping, voiding)
  const dirty = shouldConfirmDrawerClose({
    formActive: lastResult === null,
    name,
    phone,
    notes,
    skipOpen: skipEditorOpen,
    skipPreset,
    skipOtherDetail,
  })
  const nameById = new Map(roster.map((entry) => [entry.repId, entry.displayName]))

  const refreshRoster = useCallback(() => {
    setLoadError(false)
    loadRoster()
      .then((rows) => {
        setRoster(rows)
        setHasLoadedRoster(true)
        setLoadError(false)
      })
      .catch(() => setLoadError(true))
  }, [])

  useEffect(() => {
    if (open) refreshRoster()
  }, [open, refreshRoster])

  useBoardRealtime(refreshRoster)

  useEffect(() => {
    function onKeydown(event: KeyboardEvent) {
      if (event.altKey && event.code === 'KeyV' && lastResult?.assignedRepId && canVoid && !busy && !voidReasonOpen) {
        event.preventDefault()
        setVoidReasonOpen(true)
      }
    }
    window.addEventListener('keydown', onKeydown)
    return () => window.removeEventListener('keydown', onKeydown)
  }, [lastResult, canVoid, busy, voidReasonOpen])

  useEffect(() => {
    if (lastResult?.assignedRepId) nameRef.current?.focus()
  }, [lastResult])

  function requestClose() {
    if (busy) return
    if (dirty) {
      setDiscardChangesOpen(true)
      return
    }
    onClose()
  }

  function cancelSkip() {
    if (skipping) return
    setSkipEditorOpen(false)
    setSkipPreset(null)
    setSkipOtherDetail('')
    setSkipError(null)
    setSkipKey('')
  }

  function openSkip() {
    if (!lastResult?.assignedRepId || !canSkip || busy) return
    setSkipEditorOpen(true)
    setSkipPreset(null)
    setSkipOtherDetail('')
    setSkipError(null)
    setSkipKey(crypto.randomUUID())
  }

  async function handleAssign() {
    setTouched({ name: true, phone: true })
    if (!canSubmitWithRoster(formValid, hasLoadedRoster, assigning, readOnly)) return
    setAssigning(true)
    setError(null)
    const phoneE164 = toE164(phone)
    try {
      const result = await mutate<AssignResult>('assignment.assign', {
        idempotencyKey,
        customerName: name,
        customerPhoneE164: phoneE164,
        notes: notes || undefined,
      })
      setLastResult(result)
      setResultPhoneE164(phoneE164)
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

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.ctrlKey && event.key === 'Enter') {
      event.preventDefault()
      handleAssign()
    }
  }

  function handleNameKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && !event.ctrlKey) {
      event.preventDefault()
      phoneRef.current?.focus()
    }
  }

  function handlePhoneKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && !event.ctrlKey) {
      event.preventDefault()
      notesRef.current?.focus()
    }
  }

  function handleNotesKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      handleAssign()
    }
  }

  async function handleSkip(reasonNote: string) {
    if (!lastResult?.assignedRepId || !skipKey || !canSkip || skipping || readOnly) return
    setSkipping(true)
    setSkipError(null)
    try {
      const result = await mutate<AssignResult>('assignment.skip', {
        leadId: lastResult.leadId,
        expectedRepId: lastResult.assignedRepId,
        reasonNote,
        idempotencyKey: skipKey,
      })
      setLastResult(result)
      setSkipEditorOpen(false)
      setSkipPreset(null)
      setSkipOtherDetail('')
      setSkipError(null)
      setSkipKey('')
      refreshRoster()
    } catch (err) {
      setSkipError(mutationErrorMessage(err, 'This rep could not be skipped. Try again.'))
    } finally {
      setSkipping(false)
    }
  }

  function closeVoid() {
    if (voiding) return
    setVoidReasonOpen(false)
    setVoidReason('')
    setVoidError(null)
  }

  async function handleVoid() {
    if (!lastResult || !canVoid || voiding) return
    setVoidError(null)
    if (!voidReason.trim()) {
      setVoidError('Reason is required')
      return
    }
    setVoiding(true)
    try {
      await mutate('assignment.void', { leadId: lastResult.leadId, reasonNote: voidReason })
      setLastResult(null)
      setResultPhoneE164('')
      setVoidReasonOpen(false)
      setVoidReason('')
      setVoidError(null)
      refreshRoster()
      nameRef.current?.focus()
    } catch (err) {
      setVoidError(mutationErrorMessage(err, 'This assignment could not be voided. Try again.'))
    } finally {
      setVoiding(false)
    }
  }

  const onVoidKeyDown = useSubmitOnEnter(handleVoid, { disabled: !voidReason.trim() || voiding })

  return (
    <Drawer
      open={open}
      title="Assign Lead"
      busy={busy}
      inactive={discardChangesOpen || voidReasonOpen}
      onClose={requestClose}
    >
      <div className="ui-assignment-workspace" onKeyDown={handleKeyDown}>
        <div className="ui-assignment-work">
          {lastResult ? (
            <AssignmentResult
              result={lastResult}
              repName={lastResult.assignedRepId ? nameById.get(lastResult.assignedRepId) ?? null : null}
              phoneE164={resultPhoneE164}
              canSkip={canSkip}
              canVoid={canVoid}
              busy={busy}
              skipEditorOpen={skipEditorOpen}
              onSkip={openSkip}
              onVoid={() => setVoidReasonOpen(true)}
            >
              {skipEditorOpen && (
                <SkipReasonEditor
                  repName={lastResult.assignedRepId ? nameById.get(lastResult.assignedRepId) ?? lastResult.assignedRepId : 'this rep'}
                  preset={skipPreset}
                  otherDetail={skipOtherDetail}
                  skipping={skipping}
                  error={skipError}
                  readOnly={readOnly}
                  onPresetChange={setSkipPreset}
                  onOtherDetailChange={setSkipOtherDetail}
                  onCancel={cancelSkip}
                  onConfirm={handleSkip}
                />
              )}
            </AssignmentResult>
          ) : (
            <div className="ui-stack">
              <p className="ui-hint">Enter the customer, then assign when you are ready. Opening this drawer does not lock the rotation.</p>
              <Field label="Name *" error={touched.name ? formErrors.name : null}>
                <Input
                  ref={nameRef}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={handleNameKeyDown}
                  onBlur={() => setTouched((current) => ({ ...current, name: true }))}
                  placeholder="Customer name"
                  autoFocus
                  disabled={assigning || readOnly}
                  required
                />
              </Field>
              <Field label="Phone *" hint="10 digits, or +1XXXXXXXXXX" error={touched.phone ? formErrors.phone : null}>
                <Input
                  ref={phoneRef}
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  onKeyDown={handlePhoneKeyDown}
                  onBlur={() => setTouched((current) => ({ ...current, phone: true }))}
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
                  onChange={(event) => setNotes(event.target.value)}
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
          )}
        </div>
        <div className="ui-assignment-roster">
          <h3>Roster</h3>
          <RosterPanel
            roster={roster}
            hasLoadedRoster={hasLoadedRoster}
            loadError={loadError}
            onRetry={refreshRoster}
            onOpenRep={onOpenRep}
          />
        </div>
      </div>

      <DiscardChangesDialog
        open={discardChangesOpen}
        onKeepEditing={() => setDiscardChangesOpen(false)}
        onDiscard={() => {
          setDiscardChangesOpen(false)
          onClose()
        }}
      />

      <Modal
        open={voidReasonOpen}
        title="Void this assignment"
        onClose={closeVoid}
        onSubmit={handleVoid}
        submitDisabled={!voidReason.trim() || voiding}
        submitLabel={voiding ? 'Voiding…' : 'Void'}
        submitTone="danger"
      >
        <Field label="Void reason" error={voidError}>
          <Input value={voidReason} onChange={(event) => setVoidReason(event.target.value)} onKeyDown={onVoidKeyDown} disabled={voiding} />
        </Field>
        <p className="ui-hint">The up goes straight back to this rep — they become Next Up again.</p>
      </Modal>
    </Drawer>
  )
}
