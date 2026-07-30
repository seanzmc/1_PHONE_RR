import { useRef, useState } from 'react'
import { mutate } from '../lib/api'
import { Badge, Button, Card, Field, Input, Table } from '../ui'

type ImportSummary = {
  businessDate: string
  rowsParsed: number
  repsMatched: number
  repsMissingFromFile: string[]
  unmatchedNames: string[]
  manualRowsPreserved: string[]
}

/** Yesterday, store-local — the report is the prior day's activity, imported this morning. */
function priorBusinessDay(): string {
  const now = new Date()
  const local = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  local.setDate(local.getDate() - 1)
  return local.toISOString().slice(0, 10)
}

/** Read the report date out of `Standard-Daily Activity 2026-07-29.csv`. */
function dateFromFilename(filename: string): string | null {
  const m = filename.match(/(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

export function ActivityImport() {
  const [csv, setCsv] = useState('')
  const [filename, setFilename] = useState('')
  const [businessDate, setBusinessDate] = useState(priorBusinessDay())
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function onPickFile(file: File) {
    setError(null)
    setSummary(null)
    setFilename(file.name)
    setCsv(await file.text())
    // default the date from the filename, but leave it editable — the importer is never
    // allowed to infer the business date itself
    const parsed = dateFromFilename(file.name)
    if (parsed) setBusinessDate(parsed)
  }

  async function runImport() {
    if (!csv || !businessDate) return
    setBusy(true)
    setError(null)
    try {
      setSummary(await mutate<ImportSummary>('activity.import', { csv, businessDate }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'import failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ui-page">
      <h2>Import Daily Activity</h2>
      <p className="ui-muted">
        Upload the CRM “Standard-Daily Activity” export. Re-importing the same day overwrites it
        rather than adding to it, and never overwrites a manual correction.
      </p>

      <Card className="ui-stack">
        <Field label="Export file (.csv)">
          <Input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) onPickFile(file)
            }}
          />
        </Field>
        {filename && <p className="ui-hint">Loaded {filename}</p>}

        <Field label="Business date covered by this report" hint="Normally yesterday.">
          <Input type="date" value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} />
        </Field>

        {error && <p className="ui-error">{error}</p>}

        <Button variant="primary" disabled={!csv || !businessDate || busy} onClick={runImport}>
          {busy ? 'Importing…' : 'Import'}
        </Button>
      </Card>

      {summary && (
        <div className="ui-stack" style={{ marginTop: 'var(--space-6)' }}>
          <h3>Import summary — {summary.businessDate}</h3>
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
              <td>Not in the file</td>
              <td>{summary.repsMissingFromFile.length}</td>
              <td>
                {summary.repsMissingFromFile.length === 0 ? (
                  <span className="ui-muted">—</span>
                ) : (
                  <>
                    <Badge tone="neutral">registers 0 calls</Badge>{' '}
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
