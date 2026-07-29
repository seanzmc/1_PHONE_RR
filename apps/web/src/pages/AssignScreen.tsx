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
