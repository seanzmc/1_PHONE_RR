import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isOverrideNoOp,
  noOpReason,
  type CurrentRepStatus,
  type OverrideTarget,
} from '@phoneup/core/override-no-op'
import { mutate, query } from '../lib/api'
import { useBoardRealtime } from '../lib/useBoardRealtime'
import { canMutateInCurrentView, useAuthStore } from '../state/authStore'
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

export type RosterSortKey = 'name' | 'status' | 'ups'
export type SortDirection = 'asc' | 'desc'

export function sortRoster(
  roster: RosterEntry[],
  key: RosterSortKey,
  direction: SortDirection,
): RosterEntry[] {
  const multiplier = direction === 'asc' ? 1 : -1
  return [...roster].sort((a, b) => {
    let compared = 0
    if (key === 'name') {
      compared = a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
    } else if (key === 'status') {
      compared = Number(b.isEligible) - Number(a.isEligible)
    } else {
      compared = a.monthlyLoad - b.monthlyLoad
    }
    return multiplier * compared || a.displayName.localeCompare(b.displayName)
  })
}

const STATUS_OPTIONS: OverrideTarget[] = ['FORCE_ACTIVE', 'FORCE_INACTIVE']

const STATUS_LABEL: Record<OverrideTarget, string> = {
  FORCE_ACTIVE: 'Activate',
  FORCE_INACTIVE: 'Deactivate',
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
}

export function presetsFor(target: OverrideTarget) {
  return REASON_PRESETS[target]
}

/**
 * The reason text sent with an override, shared by the per-row and bulk modals.
 * `target` must be whichever modal is actually open — the per-row modal drives
 * `pendingStatus`, the bulk modal drives `bulkStatus`, and passing the wrong one (or null
 * while a modal is open) silently resolves every non-OTHER preset to an empty string.
 */
export function reasonNoteFor(target: OverrideTarget | null, reasonCode: string, otherNote: string): string {
  if (reasonCode === 'OTHER') return otherNote
  if (!target) return ''
  return presetsFor(target).find((p) => p.code === reasonCode)?.label ?? ''
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

export type DayOffMap = Record<string, number[]>

/** A saved recurring-day-off value formatted for the roster table. */
export function dayOffDisplay(days: number[]): string {
  if (days.length === 0) return 'None'
  const display = days.map((dow) => WEEKDAYS.find((weekday) => weekday.dow === dow)?.label ?? String(dow)).join(', ')
  return days.length === 1 ? display : `${display} — needs correction`
}

/** The active draft rows whose saved value would change if submitted. */
export function changedDayOffRows(baseline: DayOffMap, draft: DayOffMap, activeIds: string[]) {
  return activeIds.flatMap((repId) => {
    const before = baseline[repId] ?? []
    const after = draft[repId] ?? []
    return before.length === after.length && before.every((day, i) => day === after[i])
      ? [] : [{ repId, daysOfWeek: after }]
  })
}

/** Retain edits for active reps and initialize newcomers from the latest saved values. */
export function reconcileDayOffDraft(draft: DayOffMap, saved: DayOffMap, activeIds: string[]): DayOffMap {
  return Object.fromEntries(activeIds.map((repId) => [repId, draft[repId] ?? saved[repId] ?? []]))
}

export type ResponseGeneration = { current: number }

/** Start a response generation and return whether it is still the newest invocation. */
export function beginLatestResponse(generation: ResponseGeneration): () => boolean {
  const requestGeneration = ++generation.current
  return () => requestGeneration === generation.current
}

/** Retire every response that began before an authoritative local result was applied. */
export function invalidatePendingResponses(generation: ResponseGeneration): void {
  generation.current += 1
}

/** Apply a successful Save before refreshing through the callback for the current authority. */
export async function commitStaffListDaysOffSave<T>({
  execute,
  responseGeneration,
  currentRefresh,
  applyResult,
}: {
  execute: () => Promise<T>
  responseGeneration: ResponseGeneration
  currentRefresh: { current: () => void }
  applyResult: (result: T) => void
}): Promise<T> {
  const result = await execute()
  invalidatePendingResponses(responseGeneration)
  applyResult(result)
  currentRefresh.current()
  return result
}

/**
 * Which radio is selected for a rep. A rep gets one recurring day off or none, so more
 * than one stored day is data this UI cannot represent — surface it rather than picking
 * whichever sorted first, which would show a schedule the database does not hold and let
 * a stray click silently discard the other day.
 */
export function selectedDayOff(days: number[]): number | null | 'AMBIGUOUS' {
  if (days.length === 0) return null
  if (days.length === 1) return days[0]
  return 'AMBIGUOUS'
}

/** The `daysOfWeek` a radio selection sends. `null` is the None option. */
export function dayOffPayload(dow: number | null): number[] {
  return dow === null ? [] : [dow]
}

export function RecurringDayOffEditor({
  repId,
  displayName,
  days,
  editing,
  disabled = false,
  onChange,
}: {
  repId: string
  displayName: string
  days: number[]
  editing: boolean
  disabled?: boolean
  onChange: (dow: number | null) => void
}) {
  if (!editing) return <span>{dayOffDisplay(days)}</span>

  const selected = selectedDayOff(days)
  const ambiguous = selected === 'AMBIGUOUS'
  return (
    <div role="radiogroup" aria-label={`Recurring day off for ${displayName}`}>
      <div className="ui-row">
        <label className="ui-radio">
          <input
            type="radio"
            name={`day-off-${repId}`}
            checked={selected === null}
            disabled={disabled}
            onChange={() => onChange(null)}
          />
          None
        </label>
        {WEEKDAYS.map(({ dow, label }) => (
          <label key={dow} className="ui-radio">
            <input
              type="radio"
              name={`day-off-${repId}`}
              checked={selected === dow}
              disabled={disabled}
              onChange={() => onChange(dow)}
            />
            {label}
          </label>
        ))}
      </div>
      {ambiguous && <span className="ui-hint">{dayOffDisplay(days)} — pick one</span>}
    </div>
  )
}

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
  const { hasPermission, viewAsUserId } = useAuthStore()
  const [roster, setRoster] = useState<RosterEntry[]>([])
  const [daysOffByRep, setDaysOffByRep] = useState<DayOffMap>({})
  // `{}` is indistinguishable from "every rep has no day off" — this flag is what lets the
  // days-off cell tell "not loaded yet" apart from that, so it never renders None-checked
  // before the real values are known.
  const [daysOffLoaded, setDaysOffLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [sortKey, setSortKey] = useState<RosterSortKey>('name')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')

  const [pendingRepId, setPendingRepId] = useState<string | null>(null)
  const [pendingStatus, setPendingStatus] = useState<OverrideTarget | null>(null)
  const [reasonCode, setReasonCode] = useState<string>('')
  const [otherNote, setOtherNote] = useState('')

  const [selected, setSelected] = useState<string[]>([])
  // Separate from `error`: "2 were already in that state" is an outcome, not a failure.
  const [notice, setNotice] = useState<string | null>(null)
  const [bulkStatus, setBulkStatus] = useState<OverrideTarget | null>(null)

  const [editingDaysOff, setEditingDaysOff] = useState(false)
  const [dayOffDraft, setDayOffDraft] = useState<DayOffMap>({})
  const [savingDaysOff, setSavingDaysOff] = useState(false)
  const refreshGeneration = useRef(0)

  const canViewSchedule = hasPermission('schedule.manage')
  const canManageSchedule = canMutateInCurrentView(canViewSchedule, viewAsUserId)
  const canOverride = canMutateInCurrentView(hasPermission('rep.override'), viewAsUserId)

  const refresh = useCallback(() => {
    const isLatest = beginLatestResponse(refreshGeneration)
    query<RosterEntry[]>('board.roster')
      .then(async (rows) => {
        if (!isLatest()) return
        setRoster(rows)
        setLoadError(false)
        setSelected((prev) => reconcileSelection(prev, rows))
        const activeIds = rows.map((r) => r.repId)
        // Drop departed reps as soon as the live roster arrives. New reps are initialized
        // below from the days-off response, never from status fields on the roster row.
        setDayOffDraft((current) =>
          Object.fromEntries(
            activeIds.flatMap((repId) =>
              current[repId] === undefined ? [] : [[repId, current[repId]]],
            ),
          ),
        )
        if (!canViewSchedule) return
        // One query for the whole column. This runs on every board realtime event, so the
        // per-rep loop it replaces was ~30 requests per assign, void and status change.
        // Its own try/catch: a failure here must not be swallowed by the outer .catch, and
        // must flip daysOffLoaded back to false rather than leaving stale/empty data marked
        // as loaded.
        try {
          const saved = await query<DayOffMap>('rep.allDaysOff')
          if (!isLatest()) return
          setDaysOffByRep(saved)
          setDayOffDraft((current) => reconcileDayOffDraft(current, saved, activeIds))
          setDaysOffLoaded(true)
        } catch (err) {
          if (!isLatest()) return
          setDaysOffLoaded(false)
          setError(err instanceof Error ? err.message : 'loading days off failed')
        }
      })
      // A silent failure leaves a stale (or empty) list looking authoritative.
      .catch(() => {
        if (isLatest()) setLoadError(true)
      })
  }, [canViewSchedule])
  const currentRefresh = useRef(refresh)
  currentRefresh.current = refresh

  useEffect(() => {
    refresh()
  }, [refresh])
  useBoardRealtime(refresh)

  useEffect(() => {
    if (canManageSchedule) return
    setEditingDaysOff(false)
    setDayOffDraft({})
  }, [canManageSchedule])

  // OTHER is the only preset that requires typing; every other one submits with no input.
  const isOther = reasonCode === 'OTHER'
  // Whichever modal is actually open drives the preset lookup — bulk takes priority since
  // the two are not opened simultaneously in normal use, and it must never fall back to
  // pendingStatus's stale null while the bulk modal is the one on screen.
  const reasonNote = reasonNoteFor(bulkStatus ?? pendingStatus, reasonCode, otherNote)
  const reasonReady = reasonCode !== '' && (!isOther || otherNote.trim() !== '')

  async function submitOverride() {
    if (!pendingRepId || !pendingStatus || !reasonReady || !canOverride) return
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
    // A stale failure must not re-render at the top of the next modal that opens.
    setError(null)
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
    if (!bulkStatus || !bulkSplit || bulkSplit.applied.length === 0 || !reasonReady || !canOverride) return
    setError(null)
    setNotice(null)
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
    // A stale failure must not re-render at the top of the next modal that opens.
    setError(null)
  }

  function editDaysOff() {
    if (!canManageSchedule || !daysOffLoaded || savingDaysOff) return
    setDayOffDraft(reconcileDayOffDraft({}, daysOffByRep, roster.map((r) => r.repId)))
    setEditingDaysOff(true)
    setError(null)
    setNotice(null)
  }

  function cancelDaysOff() {
    if (savingDaysOff) return
    setEditingDaysOff(false)
    setDayOffDraft({})
    setError(null)
  }

  async function saveDaysOff() {
    const changes = changedDayOffRows(daysOffByRep, dayOffDraft, roster.map((r) => r.repId))
    if (!canManageSchedule || changes.length === 0 || savingDaysOff) return
    setSavingDaysOff(true)
    setError(null)
    setNotice(null)
    try {
      await commitStaffListDaysOffSave({
        execute: () => mutate<{ changedRepIds: string[]; daysOffByRep: DayOffMap }>(
          'rep.bulkSetDaysOff',
          { changes },
        ),
        responseGeneration: refreshGeneration,
        currentRefresh,
        applyResult: (result) => {
          setDaysOffByRep((current) => ({ ...current, ...result.daysOffByRep }))
          setEditingDaysOff(false)
          setDayOffDraft({})
          setNotice(`Recurring days off saved for ${result.changedRepIds.length} reps.`)
        },
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'saving recurring days off failed')
    } finally {
      setSavingDaysOff(false)
    }
  }

  const onReasonKeyDown = useSubmitOnEnter(bulkStatus ? submitBulk : submitOverride, {
    mode: 'multiline',
    disabled: !reasonReady,
  })

  const pendingRep = roster.find((r) => r.repId === pendingRepId)

  function changeSort(nextKey: RosterSortKey) {
    if (nextKey === sortKey) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortKey(nextKey)
    setSortDirection('asc')
  }

  function sortHeader(label: string, key: RosterSortKey) {
    const active = key === sortKey
    return (
      <button type="button" className="ui-sortbtn" onClick={() => changeSort(key)}>
        {label} {active ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}
      </button>
    )
  }

  const displayedRoster = sortRoster(roster, sortKey, sortDirection)
  const dayOffChanges = changedDayOffRows(daysOffByRep, dayOffDraft, roster.map((r) => r.repId))
  const daysOffEditActive = editingDaysOff && canManageSchedule

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
    sortHeader('Rep', 'name'),
    sortHeader('Status', 'status'),
    sortHeader('Ups MTD', 'ups'),
    ...(canViewSchedule ? ['Recurring day off'] : []),
    'Action',
  ]

  return (
    <div className="ui-page">
      <div className="ui-toolbar ui-staff-toolbar">
        <h2>Staff List</h2>
        <span className="ui-toolbar-spacer" />
        {canOverride && selected.length > 0 && (
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
        )}
        {canManageSchedule && (
          <div className="ui-bulkbar">
            {daysOffEditActive ? (
              <>
                <span className="ui-muted">
                  {dayOffChanges.length} unsaved {dayOffChanges.length === 1 ? 'change' : 'changes'}
                </span>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={dayOffChanges.length === 0 || savingDaysOff}
                  onClick={saveDaysOff}
                >
                  {savingDaysOff ? 'Saving…' : 'Save days off'}
                </Button>
                <Button size="sm" disabled={savingDaysOff} onClick={cancelDaysOff}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                disabled={!daysOffLoaded}
                title={!daysOffLoaded ? 'Recurring days off are still loading' : undefined}
                onClick={editDaysOff}
              >
                Edit days off
              </Button>
            )}
          </div>
        )}
      </div>

      {loadError && (
        <p className="ui-error" role="alert">
          Couldn't load the staff list — check your connection.{' '}
          <button type="button" className="ui-linkbtn" onClick={refresh}>
            Retry
          </button>
        </p>
      )}
      {error && <p className="ui-error" role="alert">{error}</p>}
      {notice && <p className="ui-hint" role="status">{notice}</p>}

      <Table headers={headers}>
        {displayedRoster.map((r) => (
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
            {canViewSchedule && (
              <td>
                {!daysOffLoaded ? (
                  // Not loaded yet (or the load failed) — an empty map here is indistinguishable
                  // from "no day off", so nothing renders as checked and nothing is clickable
                  // until the real values are in.
                  <span className="ui-muted">—</span>
                ) : (
                  <RecurringDayOffEditor
                    repId={r.repId}
                    displayName={r.displayName}
                    days={daysOffEditActive ? dayOffDraft[r.repId] ?? [] : daysOffByRep[r.repId] ?? []}
                    editing={daysOffEditActive}
                    disabled={savingDaysOff}
                    onChange={(dow) => setDayOffDraft((current) => ({
                      ...current,
                      [r.repId]: dayOffPayload(dow),
                    }))}
                  />
                )}
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
        {/* The modal backdrop sits above the page (z-index 50), so a failed override must
            render its error here too — the outer error line below the table is invisible
            while this modal is open. The modal stays open on failure so the manager can
            retry without re-opening it. */}
        {error && <p className="ui-error">{error}</p>}
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
        {/* The modal backdrop sits above the page (z-index 50), so a failed bulk mutation
            must render its error here too — the outer error line below the table is
            invisible while this modal is open. The modal stays open on failure so the
            selection survives for a retry; this is what makes that failure visible. */}
        {error && <p className="ui-error">{error}</p>}
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
