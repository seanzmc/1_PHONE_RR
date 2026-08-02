import { Badge } from '../../ui'
import { RosterRepName } from '../AssignScreen'
import { bucketRoster, type RosterEntry } from './model'

export type RosterPanelProps = {
  roster: RosterEntry[]
  hasLoadedRoster: boolean
  loadError: boolean
  onRetry: () => void
  onOpenRep?: (repId: string) => void
}

export function RosterPanel({ roster, hasLoadedRoster, loadError, onRetry, onOpenRep }: RosterPanelProps) {
  const { nextUp, onDeck, served, unavailable } = bucketRoster(roster)

  function repName(entry: RosterEntry) {
    return <RosterRepName entry={entry} onOpenRep={onOpenRep} />
  }

  return (
    <section aria-label="Roster">
      {loadError && roster.length > 0 && (
        <p className="ui-warn" role="status">
          Couldn't refresh — showing the last good roster.{' '}
          <button type="button" className="ui-linkbtn" onClick={onRetry}>
            Retry
          </button>
        </p>
      )}
      {!hasLoadedRoster && !loadError ? (
        <p className="ui-muted">Loading roster…</p>
      ) : loadError && roster.length === 0 ? (
        <p className="ui-error" role="alert">
          Couldn't load the roster — check your connection.{' '}
          <button type="button" className="ui-linkbtn" onClick={onRetry}>
            Retry
          </button>
        </p>
      ) : (
        <>
          <div className="ui-bucket">
            <div className="ui-bucket-head">
              <h5>Next Up</h5>
            </div>
            {nextUp ? (
              <div className="ui-nextup">{repName(nextUp)}</div>
            ) : (
              <p className="ui-muted">No eligible unserved rep. Ask a Manager to confirm availability before assigning; otherwise the lead will be saved unassigned.</p>
            )}
          </div>

          <div className="ui-bucket">
            <div className="ui-bucket-head">
              <h5>On Deck</h5>
              <span className="ui-muted">{onDeck.length}</span>
            </div>
            {onDeck.length === 0 ? (
              <p className="ui-muted">{nextUp ? 'Next Up is the final unserved rep; the rotation starts a new cycle after them.' : 'No additional unserved reps are available. Ask a Manager to check roster status.'}</p>
            ) : (
              <ul className="ui-list">
                {onDeck.map((entry, index) => (
                  <li key={entry.repId}>
                    <span className="ui-list-rank">{index + 2}</span>
                    {repName(entry)}
                    <span className="ui-muted">{entry.monthlyLoad} ups MTD</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="ui-bucket">
            <div className="ui-bucket-head">
              <h5>Served This Round</h5>
              <span className="ui-muted">{served.length}</span>
            </div>
            {served.length === 0 ? (
              <p className="ui-muted">Nobody served yet this round.</p>
            ) : (
              <ul className="ui-list">
                {served.map((entry) => (
                  <li key={entry.repId} className="ui-roster-row">
                    <RosterRepName entry={entry} onOpenRep={onOpenRep} />
                    {entry.skippedThisCycle && <Badge tone="warn">Skipped</Badge>}
                    <span className="ui-muted">{entry.monthlyLoad} ups MTD</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="ui-bucket">
            <div className="ui-bucket-head">
              <h5>Unavailable</h5>
              <span className="ui-muted">{unavailable.length}</span>
            </div>
            {unavailable.length === 0 ? (
              <p className="ui-muted">Everyone is available.</p>
            ) : (
              <ul className="ui-list">
                {unavailable.map((entry) => (
                  <li key={entry.repId}>
                    {repName(entry)}
                    <Badge tone="warn">{entry.ineligibleReason ?? 'ineligible'}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  )
}
