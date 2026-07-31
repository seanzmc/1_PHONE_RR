import { useCallback, useEffect, useState } from 'react'
import { isOverrideNoOp, noOpReason, type CurrentRepStatus, type OverrideTarget } from '@phoneup/core'
import { mutate, query } from '../lib/api'
import { useBoardRealtime } from '../lib/useBoardRealtime'
import { useAuthStore } from '../state/authStore'
import { Badge, Button, Field, Select, Table, Textarea } from '../ui'
import { Modal } from '../ui/Modal'
import { useSubmitOnEnter } from '../ui/useSubmitOnEnter'

export type RosterEntry = {
  repId: string
  displayName: string
  isEligible: boolean
  ineligibleReason?: string
  monthlyLoad: number
  /** Who decided today's status; null when the rep has no row for today. */
  decidedBy: 'SYSTEM' | 'MANAGER_OVERRIDE' | null
}

const STATUS_OPTIONS: OverrideTarget[] = ['FORCE_ACTIVE', 'FORCE_INACTIVE', 'FOLLOW_SCHEDULE']

const STATUS_LABEL: Record<OverrideTarget, string> = {
  FORCE_ACTIVE: 'Reactivate',
  FORCE_INACTIVE: 'Deactivate',
  FOLLOW_SCHEDULE: 'Follow schedule',
}

/**
 * One list per action, shared by the per-row and bulk modals so the two cannot drift.
 * OTHER is always last and is the only option that requires typing.
 */
const OTHER = { code: 'OTHER', label: 'Other' }

const REASON_PRESETS: Record<OverrideTarget, Array<{ code: string; label: string }>> = {
  FORCE_INACTIVE: [
    { code: 'BELOW_CALL_MINIMUM', label: 'Below call minimum' },
    { code: 'ABSENT', label: 'Called out / absent' },
    { code: 'PTO', label: 'PTO' },
    { code: 'TRAINING', label: 'Training' },
    { code: 'DISCIPLINARY', label: 'Disciplinary' },
    OTHER,
  ],
  FORCE_ACTIVE: [
    { code: 'SUSPENSION_LIFTED', label: 'Suspension lifted early' },
    { code: 'ABSENCE_RESOLVED', label: 'Absence resolved' },
    { code: 'DEACTIVATED_IN_ERROR', label: 'Deactivated in error' },
    OTHER,
  ],
  FOLLOW_SCHEDULE: [{ code: 'OVERRIDE_NOT_NEEDED', label: 'Override no longer needed' }, OTHER],
}

export function presetsFor(target: OverrideTarget) {
  return REASON_PRESETS[target]
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

/** Roster entry to the shape the shared no-op rule expects. */
export function currentStatusOf(entry: RosterEntry): CurrentRepStatus {
  return { isEligible: entry.isEligible, decidedBy: entry.decidedBy }
}

/**
 * Drop selected ids that are no longer on the roster. The list refreshes on every board
 * realtime event, and a stale id left in the selection would silently widen a later batch.
 */
export function reconcileSelection(selected: string[], roster: RosterEntry[]): string[] {
  const live = new Set(roster.map((r) => r.repId))
  return selected.filter((repId) => live.has(repId))
}

/**
 * Which of these reps a given action would actually change. Used to enable or disable the
 * bulk buttons and to show the split in the confirm modal — the server re-checks the same
 * rule inside the transaction, so this is a preview, not the decision.
 */
export function splitByNoOp(
  target: OverrideTarget,
  entries: RosterEntry[],
): { applied: RosterEntry[]; skipped: RosterEntry[] } {
  const applied: RosterEntry[] = []
  const skipped: RosterEntry[] = []
  for (const entry of entries) {
    if (isOverrideNoOp(target, currentStatusOf(entry))) skipped.push(entry)
    else applied.push(entry)
  }
  return { applied, skipped }
}

export function StaffList({ onOpenRep }: { onOpenRep?: (repId: string) => void }) {
  const { hasPermission } = useAuthStore()
  const [roster, setRoster] = useState<RosterEntry[]>([])
  const [daysOffByRep, setDaysOffByRep] = useState<Record<string, number[]>>({})
  const [error, setError] = useState<string | null>(null)

  const [pendingRepId, setPendingRepId] = useState<string | null>(null)
  const [pendingStatus, setPendingStatus] = useState<OverrideTarget | null>(null)
  const [reasonCode, setReasonCode] = useState<string>('')
  const [otherNote, setOtherNote] = useState('')

  const [selected, setSelected] = useState<string[]>([])
  // Separate from `error`: "2 were already in that state" is an outcome, not a failure.
  const [notice, setNotice] = useState<string | null>(null)
  const [bulkStatus, setBulkStatus] = useState<OverrideTarget | null>(null)

  const canManageSchedule = hasPermission('schedule.manage')
  const canOverride = hasPermission('rep.override')

  const refresh = useCallback(() => {
    query<RosterEntry[]>('board.roster')
      .then(async (rows) => {
        setRoster(rows)
        setSelected((prev) => reconcileSelection(prev, rows))
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

  // OTHER is the only preset that requires typing; every other one submits with no input.
  const isOther = reasonCode === 'OTHER'
  const reasonNote = isOther
    ? otherNote
    : (pendingStatus ? presetsFor(pendingStatus).find((p) => p.code === reasonCode)?.label ?? '' : '')
  const reasonReady = reasonCode !== '' && (!isOther || otherNote.trim() !== '')

  async function submitOverride() {
    if (!pendingRepId || !pendingStatus || !reasonReady) return
    setError(null)
    setNotice(null)
    try {
      await mutate('rep.overrideStatus', {
        repId: pendingRepId,
        status: pendingStatus,
        reasonCode,
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
    setReasonCode('')
    setOtherNote('')
  }

  const selectedSet = new Set(selected)
  const selectedEntries = roster.filter((r) => selectedSet.has(r.repId))
  const allSelected = roster.length > 0 && selected.length === roster.length

  function toggleRep(repId: string) {
    setSelected((prev) => (prev.includes(repId) ? prev.filter((id) => id !== repId) : [...prev, repId]))
  }

  function toggleAll() {
    setSelected((prev) => (prev.length === roster.length ? [] : roster.map((r) => r.repId)))
  }

  const bulkSplit = bulkStatus ? splitByNoOp(bulkStatus, selectedEntries) : null

  async function submitBulk() {
    if (!bulkStatus || !bulkSplit || bulkSplit.applied.length === 0 || !reasonReady) return
    setError(null)
    try {
      const result = await mutate<{ applied: string[]; skipped: string[] }>('rep.bulkOverrideStatus', {
        repIds: bulkSplit.applied.map((r) => r.repId),
        status: bulkStatus,
        reasonCode,
        reasonNote,
      })
      closeBulk()
      // Report what the server actually did: its re-check inside the transaction can
      // disagree with this preview if the roster moved underneath. This is information,
      // not a failure, so it does not go through setError's red styling.
      if (result.skipped.length > 0) {
        setNotice(`${result.applied.length} applied, ${result.skipped.length} already in that state.`)
      }
      setSelected([])
      refresh()
    } catch (err) {
      // Selection is preserved so the manager can retry without re-picking.
      setError(err instanceof Error ? err.message : 'bulk update failed')
    }
  }

  function closeBulk() {
    setBulkStatus(null)
    setReasonCode('')
    setOtherNote('')
  }

  /** One mutation per change, audit-logged as rep.days_off.set with before/after. */
  async function toggleDayOff(repId: string, dow: number) {
    const current = daysOffByRep[repId] ?? []
    const next = current.includes(dow) ? current.filter((d) => d !== dow) : [...current, dow].sort()
    setDaysOffByRep((prev) => ({ ...prev, [repId]: next })) // optimistic
    setError(null)
    setNotice(null)
    try {
      await mutate('rep.setDaysOff', { repId, daysOfWeek: next })
    } catch (err) {
      setDaysOffByRep((prev) => ({ ...prev, [repId]: current })) // roll back
      setError(err instanceof Error ? err.message : 'saving days off failed')
    }
  }

  const onReasonKeyDown = useSubmitOnEnter(bulkStatus ? submitBulk : submitOverride, {
    mode: 'multiline',
    disabled: !reasonReady,
  })

  const pendingRep = roster.find((r) => r.repId === pendingRepId)

  const headers = [
    // Spread, not a ternary yielding '': the row below omits the cell entirely when
    // canOverride is false, so an empty header string would leave the columns misaligned.
    ...(canOverride
      ? [
          <input
            key="select-all"
            type="checkbox"
            aria-label="Select all reps"
            checked={allSelected}
            ref={(el) => {
              // Partial selection reads as indeterminate, not as unchecked.
              if (el) el.indeterminate = selected.length > 0 && !allSelected
            }}
            onChange={toggleAll}
          />,
        ]
      : []),
    'Rep',
    'Status',
    'Ups MTD',
    ...(canManageSchedule ? ['Recurring days off'] : []),
    'Action',
  ]

  return (
    <div className="ui-page">
      <div className="ui-toolbar">
        <h2>Staff List</h2>
        {canOverride && selected.length > 0 && (
          <>
            <span className="ui-toolbar-spacer" />
            <div className="ui-bulkbar">
              <span className="ui-muted">{selected.length} selected</span>
              {STATUS_OPTIONS.map((status) => {
                const { applied } = splitByNoOp(status, selectedEntries)
                return (
                  <Button
                    key={status}
                    size="sm"
                    variant={status === 'FORCE_INACTIVE' ? 'danger' : 'default'}
                    disabled={applied.length === 0}
                    title={applied.length === 0 ? `No selected rep would change` : undefined}
                    onClick={() => {
                      setBulkStatus(status)
                      setReasonCode('')
                      setOtherNote('')
                    }}
                  >
                    {STATUS_LABEL[status]}
                  </Button>
                )
              })}
              <Button size="sm" onClick={() => setSelected([])}>
                Clear
              </Button>
            </div>
          </>
        )}
      </div>

      {error && <p className="ui-error">{error}</p>}
      {notice && <p className="ui-hint">{notice}</p>}

      <Table headers={headers}>
        {roster.map((r) => (
          <tr key={r.repId}>
            {canOverride && (
              <td>
                <input
                  type="checkbox"
                  aria-label={`Select ${r.displayName}`}
                  checked={selectedSet.has(r.repId)}
                  onChange={() => toggleRep(r.repId)}
                />
              </td>
            )}
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
                  STATUS_OPTIONS.map((status) => {
                    const noOp = isOverrideNoOp(status, currentStatusOf(r))
                    return (
                      <Button
                        key={status}
                        size="sm"
                        variant={status === 'FORCE_INACTIVE' ? 'danger' : 'default'}
                        disabled={noOp}
                        // A dead button should say why rather than just not responding.
                        title={noOp ? noOpReason(status) : undefined}
                        onClick={() => {
                          setPendingRepId(r.repId)
                          setPendingStatus(status)
                          setReasonCode('')
                          setOtherNote('')
                        }}
                      >
                        {STATUS_LABEL[status]}
                      </Button>
                    )
                  })}
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
        submitDisabled={!reasonReady}
        hint={isOther ? 'Ctrl+Enter to confirm, Esc to cancel' : 'Esc to cancel'}
      >
        <Field label="Reason (required)">
          <Select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
            <option value="">Choose a reason…</option>
            {pendingStatus &&
              presetsFor(pendingStatus).map((preset) => (
                <option key={preset.code} value={preset.code}>
                  {preset.label}
                </option>
              ))}
          </Select>
        </Field>
        {isOther && (
          <Field label="Details (required)">
            <Textarea value={otherNote} onChange={(e) => setOtherNote(e.target.value)} onKeyDown={onReasonKeyDown} />
          </Field>
        )}
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

      <Modal
        open={!!bulkStatus}
        title={
          bulkStatus && bulkSplit
            ? `${STATUS_LABEL[bulkStatus]} ${bulkSplit.applied.length} of ${selected.length} selected`
            : ''
        }
        onClose={closeBulk}
        onSubmit={submitBulk}
        submitDisabled={!reasonReady || !bulkSplit || bulkSplit.applied.length === 0}
        submitLabel={bulkSplit ? `${bulkStatus ? STATUS_LABEL[bulkStatus] : ''} ${bulkSplit.applied.length}` : 'Confirm'}
        hint={isOther ? 'Ctrl+Enter to confirm, Esc to cancel' : 'Esc to cancel'}
      >
        {bulkSplit && (
          <>
            <p className="ui-muted">{bulkSplit.applied.map((r) => r.displayName).join(' · ')}</p>
            {bulkSplit.skipped.length > 0 && (
              // Named rather than silently dropped: a manager who selected them should see
              // that they were left alone.
              <p className="ui-hint">
                Unchanged, already in that state: {bulkSplit.skipped.map((r) => r.displayName).join(' · ')}
              </p>
            )}
          </>
        )}
        <Field label="Reason (required)">
          <Select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
            <option value="">Choose a reason…</option>
            {bulkStatus &&
              presetsFor(bulkStatus).map((preset) => (
                <option key={preset.code} value={preset.code}>
                  {preset.label}
                </option>
              ))}
          </Select>
        </Field>
        {isOther && (
          <Field label="Details (required)">
            <Textarea value={otherNote} onChange={(e) => setOtherNote(e.target.value)} onKeyDown={onReasonKeyDown} />
          </Field>
        )}
        {bulkStatus === 'FORCE_INACTIVE' && (
          <p className="ui-hint">Applies through the end of the business week (Saturday).</p>
        )}
      </Modal>
    </div>
  )
}
