import { useEffect, useState } from 'react'
import { query } from '../lib/api'

type Summary = {
  upsPerRep: Array<{ repName: string; ups: number }>
  cycleProgress: { served: number; totalReps: number }
  disqualifiedCount: number
  overrideCount: number
}

export function Dashboard() {
  const [summary, setSummary] = useState<Summary | null>(null)

  useEffect(() => {
    query<Summary>('board.dashboardSummary').then(setSummary).catch(() => {})
  }, [])

  if (!summary) return <div style={{ padding: 24 }}>Loading…</div>

  return (
    <div style={{ padding: 24 }}>
      <h2>Dashboard</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16, maxWidth: 700 }}>
        <div style={{ border: '1px solid #ccc', padding: 12 }}>
          <h4>Ups Per Rep (this month)</h4>
          <ul>
            {summary.upsPerRep.map((r) => (
              <li key={r.repName}>
                {r.repName}: {r.ups}
              </li>
            ))}
          </ul>
        </div>
        <div style={{ border: '1px solid #ccc', padding: 12 }}>
          <h4>Current Cycle Progress</h4>
          <p>
            {summary.cycleProgress.served} / {summary.cycleProgress.totalReps} reps served
          </p>
        </div>
        <div style={{ border: '1px solid #ccc', padding: 12 }}>
          <h4>Disqualification Count</h4>
          <p>{summary.disqualifiedCount}</p>
        </div>
        <div style={{ border: '1px solid #ccc', padding: 12 }}>
          <h4>Override Count</h4>
          <p>{summary.overrideCount}</p>
        </div>
      </div>
    </div>
  )
}
