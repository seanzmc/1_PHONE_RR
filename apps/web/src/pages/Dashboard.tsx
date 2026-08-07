import { useCallback, useEffect, useRef, useState } from 'react'
import { query } from '../lib/api'
import { useBoardRealtime } from '../lib/useBoardRealtime'
import { Card, MetricCard } from '../ui'

type Summary = {
  periodKey: string
  totals: {
    assignmentsMtd: number
    reassignmentsMtd: number
    deactivationsMtd: number
    salesMtd: number
  }
  upsPerRep: Array<{ repId: string | null; repName: string; ups: number }>
  cycleProgress: { served: number; totalReps: number }
  disqualifiedCount: number
  overrideCount: number
}

export async function loadLatestDashboard<T>({
  generation,
  request,
  onSuccess,
  onFailure,
}: {
  generation: { current: number }
  request: () => Promise<T>
  onSuccess: (value: T) => void
  onFailure: () => void
}): Promise<void> {
  const requestGeneration = ++generation.current
  try {
    const value = await request()
    if (requestGeneration === generation.current) onSuccess(value)
  } catch {
    if (requestGeneration === generation.current) onFailure()
  }
}

export function DashboardLoadAlert({ onRetry }: { onRetry: () => void }) {
  return (
    <p className="ui-error" role="alert">
      Couldn't refresh the dashboard. Showing the last dashboard update.{' '}
      <button type="button" className="ui-linkbtn" onClick={onRetry}>
        Retry
      </button>
    </p>
  )
}

export function DashboardSummary({
  summary,
  onOpenRep,
}: {
  summary: Summary
  onOpenRep?: (repId: string) => void
}) {
  return (
    <>
      <h3>Team totals — {summary.periodKey}</h3>
      <div className="ui-card-grid ui-section-gap-sm">
        <MetricCard
          label="Phone-ups assigned"
          value={summary.totals.assignmentsMtd}
          hint="Phone-ups currently credited this month; voided assignments are removed."
        />
        <MetricCard
          label="CRM sales"
          value={summary.totals.salesMtd}
          hint="Sum of the CRM Sold values imported for active reps this month."
        />
        <MetricCard
          label="Reassignments"
          value={summary.totals.reassignmentsMtd}
          hint="Lead reassignments completed this month."
        />
        <MetricCard
          label="Call-rule deactivations"
          value={summary.totals.deactivationsMtd}
          hint="One per weekly call-rule suspension, not one per inactive day."
        />
      </div>

      <h3 className="ui-section-gap">Today and current cycle</h3>
      <div className="ui-card-grid">
        <MetricCard
          label="Cycle progress"
          value={`${summary.cycleProgress.served} / ${summary.cycleProgress.totalReps}`}
          hint="Active reps served in the current rotation cycle; the cycle restarts after everyone is served."
        />
        <MetricCard
          label="Ineligible today"
          value={summary.disqualifiedCount}
          hint="Active reps out of rotation today, for any reason."
        />
        <MetricCard
          label="Overrides today"
          value={summary.overrideCount}
          hint="Manager status changes recorded for today."
        />
      </div>

      <Card title="Ups per rep (this month)" className="ui-stack">
        {onOpenRep && (
          <p className="ui-muted">Select a rep name to view their leads, activity, and status for the month.</p>
        )}
        {summary.upsPerRep.length === 0 ? (
          <p className="ui-muted">No ups assigned yet this month.</p>
        ) : (
          <ul className="ui-list">
            {[...summary.upsPerRep]
              .sort((a, b) => b.ups - a.ups)
              .map((r) => (
                <li key={r.repId ?? r.repName}>
                  {onOpenRep && r.repId ? (
                    <button
                      type="button"
                      className="ui-linkbtn"
                      aria-label={`View ${r.repName}'s rep details`}
                      onClick={() => onOpenRep(r.repId!)}
                    >
                      {r.repName} <span aria-hidden="true">→</span>
                    </button>
                  ) : (
                    r.repName
                  )}
                  <span className="ui-toolbar-spacer" />
                  <strong>{r.ups}</strong>
                </li>
              ))}
          </ul>
        )}
      </Card>
    </>
  )
}

export function Dashboard({ onOpenRep }: { onOpenRep?: (repId: string) => void }) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loadError, setLoadError] = useState(false)
  const loadGeneration = useRef(0)

  const load = useCallback(() => {
    void loadLatestDashboard({
      generation: loadGeneration,
      request: () => query<Summary>('board.dashboardSummary'),
      onSuccess: (s) => {
        setSummary(s)
        setLoadError(false)
      },
      onFailure: () => setLoadError(true),
    })
  }, [])

  useBoardRealtime(load)

  useEffect(() => {
    load()
  }, [load])

  if (loadError && !summary) {
    return (
      <div className="ui-page">
        <h2>Team Dashboard</h2>
        <p className="ui-error" role="alert">
          Couldn't load the dashboard — check your connection.{' '}
          <button type="button" className="ui-linkbtn" onClick={load}>
            Retry
          </button>
        </p>
      </div>
    )
  }
  if (!summary) return <div className="ui-page"><h2>Team Dashboard</h2><p>Loading…</p></div>

  return (
    <div className="ui-page">
      <h2>Team Dashboard</h2>
      {loadError && <DashboardLoadAlert onRetry={load} />}
      <DashboardSummary summary={summary} onOpenRep={onOpenRep} />
    </div>
  )
}
