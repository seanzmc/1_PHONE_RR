import { useCallback, useEffect, useState } from 'react'
import { mutate, query } from '../lib/api'
import { useAuthStore } from '../state/authStore'
import { digitsOnly } from '../state/clipboardStore'
import { Badge, Button, Field, Input, MetricCard, Table, Textarea } from '../ui'
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
}

type ActivityRow = {
  businessDate: string
  calls: number
  sold: number
  source: 'IMPORT' | 'MANUAL'
}

function formatPhone(e164: string): string {
  const d = digitsOnly(e164)
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164
}

/**
 * One component behind both the manager drill-down (§D) and the rep's own dashboard (§K).
 * `repId` defaults to self: a REP hitting /me sees only their own data; MANAGER/ADMIN reach
 * the same view for any rep by passing repId.
 */
export function RepDetail({ repId, onBack }: { repId?: string; onBack?: () => void }) {
  const { hasPermission } = useAuthStore()
  const [leads, setLeads] = useState<LeadRow[]>([])
  const [summary, setSummary] = useState<RepSummary | null>(null)
  const [activity, setActivity] = useState<ActivityRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)

  // note drafts, keyed by lead — the Save button only appears when the field is dirty
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [copiedLeadId, setCopiedLeadId] = useState<string | null>(null)

  // §J: inline metric edit, with E's Modal for the required reason
  const [metricTarget, setMetricTarget] = useState<ActivityRow | null>(null)
  const [metricCalls, setMetricCalls] = useState('')
  const [metricSold, setMetricSold] = useState('')
  const [metricReason, setMetricReason] = useState('')

  const canWriteNotes = hasPermission('lead.note')
  const canEditMetrics = hasPermission('activity.edit')

  const load = useCallback(() => {
    const input = repId ? { repId } : {}
    setLoadError(false)
    // Each setter hangs off its own query, so the sections that CAN load still render;
    // Promise.all only decides whether the failure banner shows. Silent catches here
    // used to leave a partial page looking complete.
    Promise.all([
      query<LeadRow[]>(`lead.byRep?input=${encodeURIComponent(JSON.stringify(input))}`).then(setLeads),
      query<RepSummary>(`activity.repSummary?input=${encodeURIComponent(JSON.stringify(input))}`).then(setSummary),
      query<ActivityRow[]>(`activity.byRep?input=${encodeURIComponent(JSON.stringify(input))}`).then(setActivity),
    ]).catch(() => setLoadError(true))
  }, [repId])

  useEffect(load, [load])

  function draftFor(lead: LeadRow): string {
    return drafts[lead.id] ?? lead.note ?? ''
  }

  function isDirty(lead: LeadRow): boolean {
    return lead.id in drafts && drafts[lead.id] !== (lead.note ?? '')
  }

  async function saveNote(lead: LeadRow) {
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
      setError(err instanceof Error ? err.message : 'saving the note failed')
    }
  }

  function copyPhone(lead: LeadRow) {
    // digits-only, matching the existing clipboard convention on AssignScreen
    navigator.clipboard.writeText(digitsOnly(lead.customerPhoneE164)).catch(() => {})
    setCopiedLeadId(lead.id)
  }

  function openMetricEdit(row: ActivityRow) {
    setMetricTarget(row)
    setMetricCalls(String(row.calls))
    setMetricSold(String(row.sold))
    setMetricReason('')
  }

  async function submitMetric() {
    if (!metricTarget || !metricReason.trim() || !summary) return
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
      setError(err instanceof Error ? err.message : 'metric edit failed')
    }
  }

  const onMetricKeyDown = useSubmitOnEnter(submitMetric, { disabled: !metricReason.trim() })

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

      {error && <p className="ui-error">{error}</p>}
      {loadError && (
        <p className="ui-error">
          Couldn't load this page — check your connection.{' '}
          <button type="button" className="ui-linkbtn" onClick={load}>
            Retry
          </button>
        </p>
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
      {leads.length === 0 ? (
        <p className="ui-muted">No leads assigned through the app this month.</p>
      ) : (
        <Table headers={['Date', 'Customer', 'Phone', 'Assigned by', 'Status', 'Notes']}>
          {leads.map((lead) => (
            <tr key={lead.id}>
              <td>{lead.businessDate}</td>
              <td>{lead.customerName}</td>
              <td>
                <div className="ui-row">
                  <a href={`tel:${lead.customerPhoneE164}`}>{formatPhone(lead.customerPhoneE164)}</a>
                  <Button size="sm" onClick={() => copyPhone(lead)}>
                    {copiedLeadId === lead.id ? 'Copied' : 'Copy'}
                  </Button>
                </div>
              </td>
              <td>{lead.assignedBy}</td>
              <td>
                <Badge tone={lead.status === 'VOID' ? 'danger' : 'ok'}>{lead.status}</Badge>
              </td>
              <td>
                {canWriteNotes ? (
                  <div className="ui-col">
                    <Textarea
                      value={draftFor(lead)}
                      onChange={(e) => setDrafts((d) => ({ ...d, [lead.id]: e.target.value }))}
                      rows={2}
                    />
                    {/* Save appears only when the field is dirty */}
                    {isDirty(lead) && (
                      <Button size="sm" variant="primary" onClick={() => saveNote(lead)}>
                        Save
                      </Button>
                    )}
                  </div>
                ) : (
                  <span className={lead.note ? '' : 'ui-muted'}>{lead.note ?? '—'}</span>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}

      <h3 style={{ marginTop: 'var(--space-6)' }}>Daily activity this month</h3>
      {activity.length === 0 ? (
        <p className="ui-muted">No activity imported for this month yet.</p>
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
