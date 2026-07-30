import { useRef, useState } from 'react'
import { mutate } from '../lib/api'
import { Badge, Button, Card, Field, Input, Table } from '../ui'
import {
  activityImportFileSizeAllowed,
  decisionActions,
  priorEasternBusinessDate,
  progressForPhase,
  type ImportPhase,
  type SaveDecision,
} from './activityImportFlow'

type ImportSummary = {
  businessDate: string
  rowsParsed: number
  repsMatched: number
  repsMissingFromFile: string[]
  unmatchedNames: string[]
  manualRowsPreserved: string[]
}

type EligibilityRep = {
  repId: string
  displayName: string
  evaluatedPriorWorkday: string
  callsFound: number
  minCallsRequired: number
  wouldBeStatus: 'ELIGIBLE' | 'INELIGIBLE'
  reason: string | null
}

type ImportPreview = ImportSummary & {
  statusDate: string
  minCallsRequired: number
  eligibleRepsCount: number
  eligibleReps: EligibilityRep[]
  ineligibleReps: EligibilityRep[]
  notEvaluatedReps: Array<{ repId: string; displayName: string; reason: string }>
  previewToken: string
}

type ImportResult = ImportPreview & {
  decision: SaveDecision
  deactivatedCount: number
}

/** Read the report date out of `Standard-Daily Activity 2026-07-29.csv`. */
function dateFromFilename(filename: string): string | null {
  const m = filename.match(/(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

export function ActivityImport() {
  const [csv, setCsv] = useState('')
  const [filename, setFilename] = useState('')
  const [businessDate, setBusinessDate] = useState(() => priorEasternBusinessDate())
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<ImportPhase>('idle')
  const [saveDecision, setSaveDecision] = useState<SaveDecision | undefined>()
  const fileRef = useRef<HTMLInputElement>(null)
  const busy = phase === 'reading' || phase === 'previewing' || phase === 'committing'
  const progress = progressForPhase(phase, saveDecision)
  const summary = result ?? preview

  async function onPickFile(file: File) {
    setError(null)
    setPreview(null)
    setResult(null)
    setFilename(file.name)
    if (!activityImportFileSizeAllowed(file.size)) {
      setCsv('')
      setError('Report is too large. Choose a CSV file up to 5 MB.')
      setPhase('idle')
      return
    }
    setPhase('reading')
    try {
      setCsv(await file.text())
      // Default from the filename, but leave it editable. The server never guesses the
      // report date from its clock.
      const parsed = dateFromFilename(file.name)
      if (parsed) setBusinessDate(parsed)
      setPhase('idle')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not read the file')
      setPhase('idle')
    }
  }

  async function processReport() {
    if (!csv || !businessDate) return
    setPhase('previewing')
    setError(null)
    setPreview(null)
    setResult(null)
    try {
      const next = await mutate<ImportPreview>('activity.preview', { csv, businessDate })
      setPreview(next)
      setPhase('decision')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not process the report')
      setPhase('idle')
    }
  }

  async function commit(decision: SaveDecision) {
    if (!preview) return
    setSaveDecision(decision)
    setPhase('committing')
    setError(null)
    try {
      const committed = await mutate<ImportResult>('activity.commit', {
        csv,
        businessDate,
        statusDate: preview.statusDate,
        previewToken: preview.previewToken,
        decision,
      })
      setResult(committed)
      setPreview(null)
      setPhase('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not save the import')
      // A stale preview must be processed again; retain the loaded file for that retry.
      setPreview(null)
      setPhase('idle')
    }
  }

  function cancelEntireImport() {
    // Preview is side-effect-free. Clearing local state here truly saves nothing.
    setCsv('')
    setFilename('')
    setPreview(null)
    setResult(null)
    setSaveDecision(undefined)
    setError(null)
    setPhase('idle')
    if (fileRef.current) fileRef.current.value = ''
  }

  function changeBusinessDate(value: string) {
    setBusinessDate(value)
    setPreview(null)
    setResult(null)
    setPhase('idle')
  }

  return (
    <div className="ui-page">
      <h2>Import Daily Activity</h2>
      <p className="ui-muted">
        Upload the CRM “Standard-Daily Activity” export. The app checks every rep and shows the
        eligibility result before saving anything.
      </p>

      <Card className="ui-stack">
        <Field label="Export file (.csv)">
          <Input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            disabled={busy || phase === 'decision'}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) onPickFile(file)
            }}
          />
        </Field>
        {filename && <p className="ui-hint">Loaded {filename}</p>}

        <Field label="Business date covered by this report" hint="Normally yesterday.">
          <Input
            type="date"
            value={businessDate}
            disabled={busy || phase === 'decision'}
            onChange={(e) => changeBusinessDate(e.target.value)}
          />
        </Field>

        {error && <p className="ui-error">{error}</p>}

        <Button
          variant="primary"
          disabled={!csv || !businessDate || busy || phase === 'decision'}
          onClick={processReport}
        >
          Process report
        </Button>

        <p className="ui-hint">
          Process is a preview. Numbers are not logged and nobody is deactivated until you choose
          an action below.
        </p>
      </Card>

      {phase !== 'idle' && (
        <Card className="ui-import-progress" aria-live="polite">
          <div className="ui-row">
            <strong>{progress.label}</strong>
            {progress.value !== undefined && <span className="ui-hint">{progress.value}%</span>}
          </div>
          <progress
            className="ui-progress"
            max={100}
            {...(progress.value === undefined ? {} : { value: progress.value })}
            aria-label={progress.label}
          />
        </Card>
      )}

      {preview && phase === 'decision' && (
        <Card className="ui-import-decision">
          <span className="ui-card-kicker">Eligibility for {preview.statusDate}</span>
          <h3>
            {preview.ineligibleReps.length === 0
              ? 'All evaluated reps are eligible'
              : `${preview.ineligibleReps.length} rep${preview.ineligibleReps.length === 1 ? '' : 's'} ineligible. Deactivate?`}
          </h3>
          <p className="ui-muted">
            Minimum: {preview.minCallsRequired} calls.{' '}
            {preview.ineligibleReps.length === 0
              ? 'Log the CRM totals or cancel without saving.'
              : 'A “Yes” applies the weekly suspension through Saturday. “Log numbers only” saves the CRM totals without changing anyone’s status.'}
          </p>

          {preview.notEvaluatedReps.length > 0 && (
            <p className="ui-hint">
              <Badge tone="warn">{preview.notEvaluatedReps.length} not evaluated</Badge>{' '}
              Review the skipped reps and reasons in the report summary before deciding.
            </p>
          )}

          <div className="ui-import-actions">
            {preview.ineligibleReps.length === 0 ? (
              <Button variant="primary" onClick={() => commit('LOG_ONLY')}>
                Log numbers
              </Button>
            ) : (
              decisionActions(preview.ineligibleReps.length)
                .filter((action) => action.id !== 'CANCEL')
                .map((action) => (
                  <Button
                    key={action.id}
                    variant={action.id === 'LOG_AND_DEACTIVATE' ? 'danger' : 'primary'}
                    onClick={() => commit(action.id as SaveDecision)}
                  >
                    {action.label}
                  </Button>
                ))
            )}
            <Button variant="ghost" onClick={cancelEntireImport}>
              Cancel entire import
            </Button>
          </div>

          {preview.ineligibleReps.length > 0 && (
            <div className="ui-import-rep-list">
              <Table headers={['Rep', 'Calls', 'Evaluated day']}>
                {preview.ineligibleReps.map((rep) => (
                  <tr key={rep.repId}>
                    <td>{rep.displayName}</td>
                    <td>
                      <Badge tone="danger">
                        {rep.callsFound} / {rep.minCallsRequired}
                      </Badge>
                    </td>
                    <td>{rep.evaluatedPriorWorkday}</td>
                  </tr>
                ))}
              </Table>
            </div>
          )}
        </Card>
      )}

      {result && phase === 'done' && (
        <Card className="ui-import-complete">
          <Badge tone="ok">Saved</Badge>
          <h3>
            {result.decision === 'LOG_AND_DEACTIVATE'
              ? `${result.deactivatedCount} rep${result.deactivatedCount === 1 ? '' : 's'} deactivated`
              : 'Activity numbers logged'}
          </h3>
          <p className="ui-muted">
            {result.repsMatched} matched rep{result.repsMatched === 1 ? '' : 's'} for{' '}
            {result.businessDate}.
          </p>
          <Button onClick={cancelEntireImport}>Process another report</Button>
        </Card>
      )}

      {summary && (
        <div className="ui-stack ui-section-gap">
          <h3>{result ? 'Import summary' : 'Report summary'} — {summary.businessDate}</h3>
          <Table headers={['Result', 'Count', 'Detail']}>
            <tr>
              <td>Rows parsed</td>
              <td>{summary.rowsParsed}</td>
              <td className="ui-muted">Data rows after the two header rows</td>
            </tr>
            <tr>
              <td>Reps matched</td>
              <td>{summary.repsMatched}</td>
              <td className="ui-muted">Matched on display name</td>
            </tr>
            <tr>
              <td>Would be ineligible</td>
              <td>{summary.ineligibleReps.length}</td>
              <td className="ui-muted">Calculated for {summary.statusDate}</td>
            </tr>
            <tr>
              <td>Not in the file</td>
              <td>{summary.repsMissingFromFile.length}</td>
              <td>
                {summary.repsMissingFromFile.length === 0 ? (
                  <span className="ui-muted">—</span>
                ) : (
                  <>
                    <Badge tone="neutral">0 unless manually corrected</Badge>{' '}
                    {summary.repsMissingFromFile.join(', ')}
                  </>
                )}
              </td>
            </tr>
            <tr>
              <td>Unmatched names</td>
              <td>{summary.unmatchedNames.length}</td>
              <td>
                {summary.unmatchedNames.length === 0 ? (
                  <span className="ui-muted">—</span>
                ) : (
                  <>
                    <Badge tone="warn">not imported</Badge> {summary.unmatchedNames.join(', ')}
                  </>
                )}
              </td>
            </tr>
            <tr>
              <td>Not evaluated</td>
              <td>{summary.notEvaluatedReps.length}</td>
              <td>
                {summary.notEvaluatedReps.length === 0 ? (
                  <span className="ui-muted">—</span>
                ) : (
                  summary.notEvaluatedReps.map((rep) => (
                    <div key={rep.repId}>
                      <Badge tone="warn">skipped</Badge> {rep.displayName}: {rep.reason}
                    </div>
                  ))
                )}
              </td>
            </tr>
            <tr>
              <td>Manual rows preserved</td>
              <td>{summary.manualRowsPreserved.length}</td>
              <td>
                {summary.manualRowsPreserved.length === 0 ? (
                  <span className="ui-muted">—</span>
                ) : (
                  summary.manualRowsPreserved.join(', ')
                )}
              </td>
            </tr>
          </Table>
        </div>
      )}
    </div>
  )
}
