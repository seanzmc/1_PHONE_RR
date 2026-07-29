import { useCallback, useEffect, useRef, useState } from 'react'
import { hasPermission } from '@phoneup/contracts'
import { mutate, query } from '../lib/api'
import { useBoardRealtime } from '../lib/useBoardRealtime'
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
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
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
  const [copyFailed, setCopyFailed] = useState(false)
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

  useBoardRealtime(refreshRoster)

  useEffect(() => {
    function onKeydown(e: KeyboardEvent) {
      if (e.altKey && e.code === 'KeyC' && lastCopiedPhone) {
        navigator.clipboard.writeText(lastCopiedPhone).catch(() => {})
      }
    }
    window.addEventListener('keydown', onKeydown)
    return () => window.removeEventListener('keydown', onKeydown)
  }, [lastCopiedPhone])

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

  useEffect(() => {
    if (voidReasonOpen) {
      voidReasonRef.current?.focus()
    }
  }, [voidReasonOpen])

  async function handleAssign() {
    setError(null)
    setCopyFailed(false)
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
      navigator.clipboard.writeText(digits).catch(() => setCopyFailed(true))
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

  async function handleVoid() {
    if (!lastResult) return
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

  function handleVoidReasonKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      handleVoid()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
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
                {copyFailed && <p style={{ color: 'orange' }}>Auto-copy blocked — press Alt+C or click Copy phone</p>}
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
