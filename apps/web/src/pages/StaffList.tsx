import { useEffect, useState } from 'react'
import { mutate, query } from '../lib/api'

type RosterEntry = {
  repId: string
  displayName: string
  isEligible: boolean
  ineligibleReason?: string
}

const STATUS_OPTIONS = ['FORCE_ACTIVE', 'FORCE_INACTIVE', 'FOLLOW_SCHEDULE'] as const

export function StaffList() {
  const [roster, setRoster] = useState<RosterEntry[]>([])
  const [pendingRepId, setPendingRepId] = useState<string | null>(null)
  const [pendingStatus, setPendingStatus] = useState<(typeof STATUS_OPTIONS)[number] | null>(null)
  const [reasonNote, setReasonNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  function refresh() {
    query<RosterEntry[]>('board.roster').then(setRoster).catch(() => {})
  }

  useEffect(refresh, [])

  async function submitOverride() {
    if (!pendingRepId || !pendingStatus || !reasonNote.trim()) return
    setError(null)
    try {
      await mutate('rep.overrideStatus', {
        repId: pendingRepId,
        status: pendingStatus,
        reasonCode: pendingStatus,
        reasonNote,
      })
      setPendingRepId(null)
      setPendingStatus(null)
      setReasonNote('')
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'override failed')
    }
  }

  return (
    <div style={{ padding: 24 }}>
      <h2>Staff List</h2>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Rep</th>
            <th style={{ textAlign: 'left' }}>Status</th>
            <th style={{ textAlign: 'left' }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {roster.map((r) => (
            <tr key={r.repId}>
              <td>{r.displayName}</td>
              <td>{r.isEligible ? 'ELIGIBLE' : `INELIGIBLE (${r.ineligibleReason ?? 'n/a'})`}</td>
              <td>
                {STATUS_OPTIONS.map((status) => (
                  <button
                    key={status}
                    onClick={() => {
                      setPendingRepId(r.repId)
                      setPendingStatus(status)
                    }}
                    style={{ marginRight: 4 }}
                  >
                    {status}
                  </button>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {pendingRepId && pendingStatus && (
        <div style={{ marginTop: 16, border: '1px solid #ccc', padding: 12, maxWidth: 400 }}>
          <p>
            Set <strong>{roster.find((r) => r.repId === pendingRepId)?.displayName}</strong> to{' '}
            <strong>{pendingStatus}</strong>. Reason is required.
          </p>
          <textarea
            value={reasonNote}
            onChange={(e) => setReasonNote(e.target.value)}
            style={{ width: '100%' }}
            placeholder="Reason (required)"
          />
          <div style={{ marginTop: 8 }}>
            <button onClick={submitOverride} disabled={!reasonNote.trim()}>
              Confirm
            </button>
            <button onClick={() => setPendingRepId(null)} style={{ marginLeft: 8 }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
