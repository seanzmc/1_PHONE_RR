import { useCallback, useEffect, useState } from 'react'
import { query } from '../lib/api'
import { Card, MetricCard } from '../ui'

type Summary = {
  upsPerRep: Array<{ repId: string | null; repName: string; ups: number }>
  cycleProgress: { served: number; totalReps: number }
  disqualifiedCount: number
  overrideCount: number
}

export function Dashboard({ onOpenRep }: { onOpenRep?: (repId: string) => void }) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loadError, setLoadError] = useState(false)

  const load = useCallback(() => {
    query<Summary>('board.dashboardSummary')
      .then((s) => {
        setSummary(s)
        setLoadError(false)
      })
      // A silent catch leaves the screen on "Loading…" forever — indistinguishable
      // from a slow connection and with no way out.
      .catch(() => setLoadError(true))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (loadError && !summary) {
    return (
      <div className="ui-page">
        <p className="ui-error">
          Couldn't load the dashboard — check your connection.{' '}
          <button type="button" className="ui-linkbtn" onClick={load}>
            Retry
          </button>
        </p>
      </div>
    )
  }
  if (!summary) return <div className="ui-page">Loading…</div>

  return (
    <div className="ui-page">
      <h2>Dashboard</h2>

      <div className="ui-card-grid">
        <MetricCard
          label="Cycle progress"
          value={`${summary.cycleProgress.served} / ${summary.cycleProgress.totalReps}`}
          hint="Reps served this cycle"
        />
        <MetricCard label="Ineligible today" value={summary.disqualifiedCount} />
        <MetricCard label="Overrides today" value={summary.overrideCount} />
      </div>

      <Card title="Ups per rep (this month)" className="ui-stack">
        {summary.upsPerRep.length === 0 ? (
          <p className="ui-muted">No ups assigned yet this month.</p>
        ) : (
          <ul className="ui-list">
            {[...summary.upsPerRep]
              .sort((a, b) => b.ups - a.ups)
              .map((r) => (
                <li key={r.repId ?? r.repName}>
                  {onOpenRep && r.repId ? (
                    <button type="button" className="ui-linkbtn" onClick={() => onOpenRep(r.repId!)}>
                      {r.repName}
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
    </div>
  )
}
