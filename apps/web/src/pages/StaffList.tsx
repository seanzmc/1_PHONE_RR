import { useCallback, useEffect, useState } from 'react'
import { mutate, query } from '../lib/api'
import { useBoardRealtime } from '../lib/useBoardRealtime'
import { useAuthStore } from '../state/authStore'
import { Badge, Button, Field, Table, Textarea } from '../ui'
import { Modal } from '../ui/Modal'
import { useSubmitOnEnter } from '../ui/useSubmitOnEnter'

type RosterEntry = {
  repId: string
  displayName: string
  isEligible: boolean
  ineligibleReason?: string
  monthlyLoad: number
}

const STATUS_OPTIONS = ['FORCE_ACTIVE', 'FORCE_INACTIVE', 'FOLLOW_SCHEDULE'] as const
type StatusOption = (typeof STATUS_OPTIONS)[number]

const STATUS_LABEL: Record<StatusOption, string> = {
  FORCE_ACTIVE: 'Reactivate',
  FORCE_INACTIVE: 'Deactivate',
  FOLLOW_SCHEDULE: 'Follow schedule',
}

// 0=Sunday..6=Saturday. Sunday is store-closed and has no toggle — it needs no
// rep-level day-off entry and shouldn't consume one.
const WEEKDAYS: Array<{ dow: number; label: string }> = [
  { dow: 1, label: 'Mon' },
  { dow: 2, label: 'Tue' },
  { dow: 3, label: 'Wed' },
  { dow: 4, label: 'Thu' },
  { dow: 5, label: 'Fri' },
  { dow: 6, label: 'Sat' },
]

export function StaffList({ onOpenRep }: { onOpenRep?: (repId: string) => void }) {
  const { hasPermission } = useAuthStore()
  const [roster, setRoster] = useState<RosterEntry[]>([])
  const [daysOffByRep, setDaysOffByRep] = useState<Record<string, number[]>>({})
  const [error, setError] = useState<string | null>(null)

  const [pendingRepId, setPendingRepId] = useState<string | null>(null)
  const [pendingStatus, setPendingStatus] = useState<StatusOption | null>(null)
  const [reasonNote, setReasonNote] = useState('')

  const canManageSchedule = hasPermission('schedule.manage')
  const canOverride = hasPermission('rep.override')

  const refresh = useCallback(() => {
    query<RosterEntry[]>('board.roster')
      .then(async (rows) => {
        setRoster(rows)
        if (!canManageSchedule) return
        const entries = await Promise.all(
          rows.map(async (r) => {
            try {
              const res = await query<{ daysOfWeek: number[] }>(
                `rep.daysOff?input=${encodeURIComponent(JSON.stringify({ repId: r.repId }))}`,
              )
              return [r.repId, res.daysOfWeek] as const
            } catch {
              return [r.repId, []] as const
            }
          }),
        )
        setDaysOffByRep(Object.fromEntries(entries))
      })
      .catch(() => {})
  }, [canManageSchedule])

  useEffect(() => {
    refresh()
  }, [refresh])
  useBoardRealtime(refresh)

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
      closeOverride()
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'override failed')
    }
  }

  function closeOverride() {
    setPendingRepId(null)
    setPendingStatus(null)
    setReasonNote('')
  }

  /** One mutation per change, audit-logged as rep.days_off.set with before/after. */
  async function toggleDayOff(repId: string, dow: number) {
    const current = daysOffByRep[repId] ?? []
    const next = current.includes(dow) ? current.filter((d) => d !== dow) : [...current, dow].sort()
    setDaysOffByRep((prev) => ({ ...prev, [repId]: next })) // optimistic
    setError(null)
    try {
      await mutate('rep.setDaysOff', { repId, daysOfWeek: next })
    } catch (err) {
      setDaysOffByRep((prev) => ({ ...prev, [repId]: current })) // roll back
      setError(err instanceof Error ? err.message : 'saving days off failed')
    }
  }

  const onReasonKeyDown = useSubmitOnEnter(submitOverride, {
    mode: 'multiline',
    disabled: !reasonNote.trim(),
  })

  const pendingRep = roster.find((r) => r.repId === pendingRepId)

  const headers = ['Rep', 'Status', 'Ups MTD', ...(canManageSchedule ? ['Recurring days off'] : []), 'Action']

  return (
    <div className="ui-page">
      <div className="ui-toolbar">
        <h2>Staff List</h2>
        {canManageSchedule && (
          <>
            <span className="ui-toolbar-spacer" />
            <Button
              onClick={async () => {
                setError(null)
                try {
                  await mutate('rep.materializeShifts', { days: 14 })
                  refresh()
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'generating schedule failed')
                }
              }}
            >
              Generate 14 days of shifts
            </Button>
          </>
        )}
      </div>

      {error && <p className="ui-error">{error}</p>}

      <Table headers={headers}>
        {roster.map((r) => (
          <tr key={r.repId}>
            <td>
              {onOpenRep ? (
                <button type="button" className="ui-linkbtn" onClick={() => onOpenRep(r.repId)}>
                  {r.displayName}
                </button>
              ) : (
                r.displayName
              )}
            </td>
            <td>
              {r.isEligible ? (
                <Badge tone="ok">ELIGIBLE</Badge>
              ) : (
                <Badge tone="warn">{r.ineligibleReason ?? 'INELIGIBLE'}</Badge>
              )}
            </td>
            <td>{r.monthlyLoad}</td>
            {canManageSchedule && (
              <td>
                <div className="ui-row">
                  {WEEKDAYS.map(({ dow, label }) => {
                    const on = (daysOffByRep[r.repId] ?? []).includes(dow)
                    return (
                      <Button
                        key={dow}
                        size="sm"
                        variant={on ? 'primary' : 'default'}
                        aria-pressed={on}
                        title={on ? `${label} is a scheduled day off` : `Mark ${label} as a day off`}
                        onClick={() => toggleDayOff(r.repId, dow)}
                      >
                        {label}
                      </Button>
                    )
                  })}
                </div>
              </td>
            )}
            <td>
              <div className="ui-row">
                {canOverride &&
                  STATUS_OPTIONS.map((status) => (
                    <Button
                      key={status}
                      size="sm"
                      variant={status === 'FORCE_INACTIVE' ? 'danger' : 'default'}
                      onClick={() => {
                        setPendingRepId(r.repId)
                        setPendingStatus(status)
                      }}
                    >
                      {STATUS_LABEL[status]}
                    </Button>
                  ))}
              </div>
            </td>
          </tr>
        ))}
      </Table>

      <Modal
        open={!!pendingRepId && !!pendingStatus}
        title={`${pendingStatus ? STATUS_LABEL[pendingStatus] : ''} — ${pendingRep?.displayName ?? ''}`}
        onClose={closeOverride}
        onSubmit={submitOverride}
        submitDisabled={!reasonNote.trim()}
        hint="Ctrl+Enter to confirm, Esc to cancel"
      >
        <Field label="Reason (required)">
          <Textarea value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} onKeyDown={onReasonKeyDown} />
        </Field>
        {pendingStatus === 'FORCE_ACTIVE' && (
          <p className="ui-hint">
            Clears any remaining week suspension. The rep is still subject to the daily call
            qualifier tomorrow morning — reactivation does not exempt anyone.
          </p>
        )}
        {pendingStatus === 'FORCE_INACTIVE' && (
          <p className="ui-hint">Applies through the end of the business week (Saturday).</p>
        )}
      </Modal>
    </div>
  )
}
