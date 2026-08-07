import { useCallback, useEffect, useRef, useState } from 'react'
import { mutate, query } from '../lib/api'
import { mutationErrorMessage } from '../lib/mutationError'
import { canMutateInCurrentView, useAuthStore } from '../state/authStore'
import { digitsOnly } from '../state/clipboardStore'
import { Badge, Button, Card, Field, Input, MetricCard, Select, Table, Textarea } from '../ui'
import { Modal } from '../ui/Modal'
import { useSubmitOnEnter } from '../ui/useSubmitOnEnter'

type LeadRow = {
  id: string
  businessDate: string
  status: string
  note: string | null
  customerName: string
  customerPhoneE164: string
  assignedBy: string
}

type RepSummary = {
  repId: string
  displayName: string
  periodKey: string
  upsMtd: number
  callsMtd: number
  soldMtd: number
  timesDeactivated: number
  daysInactive: number
  inactiveDates: string[]
  today: { businessDate: string; isEligible: boolean; reason: string | null }
  daysOff: number[]
}

type ActivityRow = {
  businessDate: string
  calls: number
  sold: number
  source: 'IMPORT' | 'MANUAL'
}

export type ReassignTarget = { repId: string; displayName: string }

export type CopyFeedback =
  | { status: 'idle' }
  | { status: 'pending' | 'success' | 'failure'; leadId: string }

export type PhoneCopyAuthority = {
  generation: number
  successTimer: ReturnType<typeof setTimeout> | null
}

type StartPhoneCopyInput = {
  authority: PhoneCopyAuthority
  leadId: string
  phone: string
  writeText: (value: string) => Promise<void>
  setFeedback: (feedback: CopyFeedback) => void
}

export function copyButtonPresentation(
  feedback: CopyFeedback,
  leadId: string,
): { label: 'Copy' | 'Copying…' | 'Copied'; disabled: boolean } {
  if (feedback.status === 'pending' && feedback.leadId === leadId) {
    return { label: 'Copying…', disabled: true }
  }
  if (feedback.status === 'success' && feedback.leadId === leadId) {
    return { label: 'Copied', disabled: false }
  }
  return { label: 'Copy', disabled: false }
}

export function PhoneCopyNotice({ feedback }: { feedback: CopyFeedback }) {
  return (
    <>
      <span className="ui-sr-only" role="status" aria-live="polite">
        {feedback.status === 'success' ? 'Phone number copied.' : ''}
      </span>
      {feedback.status === 'failure' && (
        <p className="ui-error" role="alert">
          Couldn't copy the phone number. Select the number and copy it manually.
        </p>
      )}
    </>
  )
}

export async function startPhoneCopy({
  authority,
  leadId,
  phone,
  writeText,
  setFeedback,
}: StartPhoneCopyInput): Promise<void> {
  const generation = ++authority.generation
  if (authority.successTimer !== null) {
    clearTimeout(authority.successTimer)
    authority.successTimer = null
  }
  setFeedback({ status: 'pending', leadId })

  try {
    await writeText(digitsOnly(phone))
    if (authority.generation !== generation) return
    setFeedback({ status: 'success', leadId })
    authority.successTimer = setTimeout(() => {
      if (authority.generation !== generation) return
      authority.successTimer = null
      setFeedback({ status: 'idle' })
    }, 2_000)
  } catch {
    if (authority.generation !== generation) return
    setFeedback({ status: 'failure', leadId })
  }
}

export function cancelPhoneCopyFeedback(authority: PhoneCopyAuthority): void {
  authority.generation += 1
  if (authority.successTimer !== null) {
    clearTimeout(authority.successTimer)
    authority.successTimer = null
  }
}

export function WritableLeadNote({
  value,
  isDirty,
  onChange,
  onSave,
}: {
  value: string
  isDirty: boolean
  onChange: (value: string) => void
  onSave: () => void
}) {
  return (
    <div className="ui-col">
      <Textarea
        value={value}
        placeholder="Note for this lead…"
        onChange={(event) => onChange(event.target.value)}
        rows={2}
      />
      {/* Save appears only when the field is dirty */}
      {isDirty && (
        <Button size="sm" variant="primary" onClick={onSave}>
          Save
        </Button>
      )}
    </div>
  )
}

export function reassignTargets(roster: ReassignTarget[], currentRepId: string): ReassignTarget[] {
  return roster.filter((target) => target.repId !== currentRepId)
}

function formatPhone(e164: string): string {
  const d = digitsOnly(e164)
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** rep_daily_status reasons are stored compact: "WEEK_DQ: …", or a lowercased shift kind. */
const SHIFT_REASON_LABEL: Record<string, string> = {
  off: 'Scheduled day off',
  pto: 'PTO day',
  sick: 'Sick day',
  training: 'Training day',
  suspended: 'Suspended',
}

/** Make a stored status reason readable — translate the WEEK_DQ prefix, keep the numbers. */
export function formatStatusReason(reason: string): string {
  const bare = SHIFT_REASON_LABEL[reason]
  if (bare) return bare
  const text = reason.replace(/WEEK_DQ: /g, 'below the call minimum: ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * The guidance line under the today badge. `isSelf` picks the pointer: reps get sent to
 * their manager, managers get sent to the Staff List — the one audited status path.
 */
export function todayStatusMessage(
  today: { isEligible: boolean; reason: string | null },
  isSelf: boolean,
): string {
  if (today.isEligible) {
    return isSelf
      ? "You're in today's rotation — ups go to the next unserved rep in line."
      : "In today's rotation — ups go to the next unserved rep in line."
  }
  const reason = formatStatusReason(today.reason ?? 'Not evaluated for today yet')
  if ((today.reason ?? '').startsWith('WEEK_DQ')) {
    const pointer = isSelf ? 'Think this is wrong? Talk to your manager.' : 'Lift it early from the Staff List.'
    return `${reason} — suspended through Saturday. ${pointer}`
  }
  return `${reason}.`
}

/**
 * One component behind both the manager drill-down (§D) and the rep's own dashboard (§K).
 * `repId` defaults to self: a REP hitting /me sees only their own data; MANAGER/ADMIN reach
 * the same view for any rep by passing repId.
 */
export function RepDetail({ repId, onBack }: { repId?: string; onBack?: () => void }) {
  const { hasPermission, viewAsUserId } = useAuthStore()
  const [leads, setLeads] = useState<LeadRow[]>([])
  const [summary, setSummary] = useState<RepSummary | null>(null)
  const [activity, setActivity] = useState<ActivityRow[]>([])
  const [roster, setRoster] = useState<ReassignTarget[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)

  // note drafts, keyed by lead — the Save button only appears when the field is dirty
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>({ status: 'idle' })
  const copyAuthority = useRef<PhoneCopyAuthority>({ generation: 0, successTimer: null })

  // §J: inline metric edit, with E's Modal for the required reason
  const [metricTarget, setMetricTarget] = useState<ActivityRow | null>(null)
  const [metricCalls, setMetricCalls] = useState('')
  const [metricSold, setMetricSold] = useState('')
  const [metricReason, setMetricReason] = useState('')

  const [reassignLead, setReassignLead] = useState<LeadRow | null>(null)
  const [reassignTargetId, setReassignTargetId] = useState('')
  const [reassignReason, setReassignReason] = useState('')
  const [reassignKey, setReassignKey] = useState('')

  const canWriteNotes = canMutateInCurrentView(hasPermission('lead.note'), viewAsUserId)
  const canEditMetrics = canMutateInCurrentView(hasPermission('activity.edit'), viewAsUserId)
  const canReassign = canMutateInCurrentView(hasPermission('lead.assign.override'), viewAsUserId)

  const load = useCallback(() => {
    const input = repId ? { repId } : {}
    setLoadError(false)
    // Each setter hangs off its own query, so the sections that CAN load still render;
    // Promise.all only decides whether the failure banner shows. Silent catches here
    // used to leave a partial page looking complete.
    const requests: Array<Promise<unknown>> = [
      query<LeadRow[]>(`lead.byRep?input=${encodeURIComponent(JSON.stringify(input))}`).then(setLeads),
      query<RepSummary>(`activity.repSummary?input=${encodeURIComponent(JSON.stringify(input))}`).then(setSummary),
      query<ActivityRow[]>(`activity.byRep?input=${encodeURIComponent(JSON.stringify(input))}`).then(setActivity),
    ]
    if (canReassign) requests.push(query<ReassignTarget[]>('board.roster').then(setRoster))
    Promise.all(requests).catch(() => setLoadError(true))
  }, [repId, canReassign])

  useEffect(load, [load])
  useEffect(() => () => cancelPhoneCopyFeedback(copyAuthority.current), [])

  function draftFor(lead: LeadRow): string {
    return drafts[lead.id] ?? lead.note ?? ''
  }

  function isDirty(lead: LeadRow): boolean {
    return lead.id in drafts && drafts[lead.id] !== (lead.note ?? '')
  }

  async function saveNote(lead: LeadRow) {
    if (!canWriteNotes) return
    setError(null)
    try {
      await mutate('lead.setNote', { leadId: lead.id, note: draftFor(lead) })
      setDrafts((d) => {
        const next = { ...d }
        delete next[lead.id]
        return next
      })
      load()
    } catch (err) {
      setError(mutationErrorMessage(err, 'The note could not be saved. Try again.'))
    }
  }

  function copyPhone(lead: LeadRow) {
    // Keep phone copies digits-only for dialer-friendly paste behavior.
    void startPhoneCopy({
      authority: copyAuthority.current,
      leadId: lead.id,
      phone: lead.customerPhoneE164,
      writeText: (value) => navigator.clipboard.writeText(value),
      setFeedback: setCopyFeedback,
    })
  }

  function openMetricEdit(row: ActivityRow) {
    setMetricTarget(row)
    setMetricCalls(String(row.calls))
    setMetricSold(String(row.sold))
    setMetricReason('')
  }

  async function submitMetric() {
    if (!metricTarget || !metricReason.trim() || !summary || !canEditMetrics) return
    setError(null)
    try {
      await mutate('activity.setMetric', {
        repId: summary.repId,
        businessDate: metricTarget.businessDate,
        calls: Number(metricCalls),
        sold: Number(metricSold),
        reasonNote: metricReason,
      })
      setMetricTarget(null)
      load()
    } catch (err) {
      setError(mutationErrorMessage(err, 'The activity correction could not be saved. Try again.'))
    }
  }

  function openReassign(lead: LeadRow) {
    setReassignLead(lead)
    setReassignTargetId('')
    setReassignReason('')
    setReassignKey(crypto.randomUUID())
    setError(null)
  }

  function closeReassign() {
    setReassignLead(null)
    setReassignTargetId('')
    setReassignReason('')
    setReassignKey('')
    setError(null)
  }

  async function submitReassign() {
    if (!reassignLead || !reassignTargetId || !reassignReason.trim() || !reassignKey || !canReassign) return
    setError(null)
    try {
      await mutate('assignment.reassign', {
        leadId: reassignLead.id,
        targetRepId: reassignTargetId,
        reasonNote: reassignReason,
        idempotencyKey: reassignKey,
      })
      closeReassign()
      load()
    } catch (err) {
      setError(mutationErrorMessage(err, 'The lead could not be reassigned. Try again.'))
    }
  }

  const onMetricKeyDown = useSubmitOnEnter(submitMetric, { disabled: !metricReason.trim() })
  const onReassignKeyDown = useSubmitOnEnter(submitReassign, {
    mode: 'multiline',
    disabled: !reassignTargetId || !reassignReason.trim(),
  })
  const availableTargets = summary ? reassignTargets(roster, summary.repId) : []

  return (
    <div className="ui-page">
      <div className="ui-toolbar">
        {onBack && (
          <Button variant="ghost" onClick={onBack}>
            ← Back
          </Button>
        )}
        <h2>{summary ? summary.displayName : 'Rep'}</h2>
        {summary && <Badge tone="accent">{summary.periodKey}</Badge>}
      </div>

      {error && <p className="ui-error" role="alert">{error}</p>}
      {loadError && (
        <p className="ui-error" role="alert">
          Couldn't load this page — check your connection.{' '}
          <button type="button" className="ui-linkbtn" onClick={load}>
            Retry
          </button>
        </p>
      )}

      {summary && (
        <Card className="ui-stack" kicker={`Today — ${summary.today.businessDate}`}>
          <div className="ui-row">
            {summary.today.isEligible ? (
              <Badge tone="ok">IN ROTATION</Badge>
            ) : (
              <Badge tone="warn">NOT IN ROTATION</Badge>
            )}
            {summary.daysOff.length > 0 && (
              <span className="ui-hint">
                Recurring day off: {summary.daysOff.map((d) => WEEKDAY_NAMES[d]).join(', ')}
              </span>
            )}
          </div>
          <p className="ui-muted">{todayStatusMessage(summary.today, !repId)}</p>
        </Card>
      )}

      {summary && (
        <div className="ui-card-grid">
          <MetricCard label="Ups this month" value={summary.upsMtd} />
          <MetricCard label="Calls this month" value={summary.callsMtd} />
          <MetricCard label="Sales this month" value={summary.soldMtd} hint="From the CRM export" />
          <MetricCard
            label="Times deactivated"
            value={summary.timesDeactivated}
            hint="Suspensions, not days"
          />
          <MetricCard
            label="Days inactive"
            value={summary.daysInactive}
            hint="Scheduled days off excluded"
          />
        </div>
      )}

      <h3 style={{ marginTop: 'var(--space-6)' }}>Leads this month</h3>
      <PhoneCopyNotice feedback={copyFeedback} />
      {leads.length === 0 ? (
        <p className="ui-muted">No ups yet this month — new phone-ups appear here as they're assigned.</p>
      ) : (
        <Table headers={['Date', 'Customer', 'Phone', 'Assigned by', 'Status', 'Notes', ...(canReassign ? ['Actions'] : [])]}>
          {leads.map((lead) => (
            <tr key={lead.id}>
              <td>{lead.businessDate}</td>
              <td>{lead.customerName}</td>
              <td>
                <div className="ui-row">
                  <span>{formatPhone(lead.customerPhoneE164)}</span>
                  <Button
                    size="sm"
                    disabled={copyButtonPresentation(copyFeedback, lead.id).disabled}
                    onClick={() => copyPhone(lead)}
                  >
                    {copyButtonPresentation(copyFeedback, lead.id).label}
                  </Button>
                </div>
              </td>
              <td>{lead.assignedBy}</td>
              <td>
                <Badge tone={lead.status === 'VOID' ? 'danger' : 'ok'}>{lead.status}</Badge>
              </td>
              <td>
                {canWriteNotes ? (
                  <WritableLeadNote
                    value={draftFor(lead)}
                    isDirty={isDirty(lead)}
                    onChange={(value) => setDrafts((d) => ({ ...d, [lead.id]: value }))}
                    onSave={() => saveNote(lead)}
                  />
                ) : (
                  <span className={lead.note ? '' : 'ui-muted'}>{lead.note ?? '—'}</span>
                )}
              </td>
              {canReassign && (
                <td>
                  {lead.status === 'ASSIGNED' && (
                    <Button size="sm" onClick={() => openReassign(lead)}>
                      Reassign
                    </Button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </Table>
      )}

      <h3 style={{ marginTop: 'var(--space-6)' }}>Daily activity this month</h3>
      {activity.length === 0 ? (
        <p className="ui-muted">Call numbers appear here after the daily CRM import.</p>
      ) : (
        <Table headers={['Date', 'Calls', 'Sold', 'Source', ...(canEditMetrics ? ['Edit'] : [])]}>
          {activity.map((row) => (
            <tr key={row.businessDate}>
              <td>{row.businessDate}</td>
              <td>{row.calls}</td>
              <td>{row.sold}</td>
              <td>
                <Badge tone={row.source === 'MANUAL' ? 'warn' : 'neutral'}>{row.source}</Badge>
              </td>
              {canEditMetrics && (
                <td>
                  <Button size="sm" onClick={() => openMetricEdit(row)}>
                    Correct
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </Table>
      )}

      <Modal
        open={!!reassignLead}
        title={`Reassign — ${reassignLead?.customerName ?? ''}`}
        onClose={closeReassign}
        onSubmit={submitReassign}
        submitDisabled={!reassignTargetId || !reassignReason.trim()}
        submitLabel="Reassign lead"
        hint="Ctrl+Enter to confirm, Esc to cancel"
      >
        {error && <p className="ui-error">{error}</p>}
        <Field label="New rep (required)">
          <Select value={reassignTargetId} onChange={(event) => setReassignTargetId(event.target.value)}>
            <option value="">Choose a rep…</option>
            {availableTargets.map((target) => (
              <option key={target.repId} value={target.repId}>
                {target.displayName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reason (required)">
          <Textarea
            value={reassignReason}
            onChange={(event) => setReassignReason(event.target.value)}
            onKeyDown={onReassignKeyDown}
          />
        </Field>
        <p className="ui-hint">Managers can reassign an older lead; the original ledger history remains intact.</p>
      </Modal>

      <Modal
        open={!!metricTarget}
        title={`Correct metrics — ${metricTarget?.businessDate ?? ''}`}
        onClose={() => setMetricTarget(null)}
        onSubmit={submitMetric}
        submitDisabled={!metricReason.trim()}
        submitLabel="Save correction"
        hint="Ctrl+Enter to save, Esc to cancel"
      >
        <div className="ui-row">
          <Field label="Calls">
            <Input
              className="ui-input-inline"
              type="number"
              min={0}
              value={metricCalls}
              onChange={(e) => setMetricCalls(e.target.value)}
            />
          </Field>
          <Field label="Sold">
            <Input
              className="ui-input-inline"
              type="number"
              min={0}
              value={metricSold}
              onChange={(e) => setMetricSold(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Reason (required)">
          <Textarea value={metricReason} onChange={(e) => setMetricReason(e.target.value)} onKeyDown={onMetricKeyDown} />
        </Field>
        {/* §J: say this in the UI, next to the field */}
        <p className="ui-hint">
          Editing a past day's calls does not retroactively un-deactivate anyone. To change a rep's
          status, use Reactivate on the staff list — that is the one audited path for status.
        </p>
      </Modal>
    </div>
  )
}
