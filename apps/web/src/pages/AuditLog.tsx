import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { query } from '../lib/api'
import { Button, Field, Input, Select } from '../ui'

type AuditValueSide = 'before' | 'after'

export function formatAuditValue(
  value: unknown,
  oppositeValue?: unknown,
  side?: AuditValueSide,
): string {
  if (value == null) {
    if (isRecord(oppositeValue)) {
      return side === 'before' ? 'Record did not exist' : 'Record no longer exists'
    }
    return 'No state recorded'
  }
  return JSON.stringify(value, null, 2)
}

const ACTION_LABELS: Record<string, string> = {
  'activity.import': 'Imported daily activity',
  'activity.metric.edit': 'Corrected activity metrics',
  'lead.assign': 'Assigned lead',
  'lead.note.set': 'Updated lead note',
  'lead.queue': 'Queued unassigned lead',
  'lead.reassign': 'Reassigned lead',
  'lead.skip': 'Skipped rep and passed lead',
  'lead.void': 'Voided lead',
  'policy.set': 'Updated activity policy',
  'rep.days_off.set': 'Changed recurring day off',
  'rep.override': 'Changed rep status',
  'user.changeOwnPassword': 'Changed own password',
  'user.create': 'Created account',
  'user.protectedWriteDenied': 'Denied change to protected account',
  'user.resetPassword': 'Reset account password',
  'user.setActive': 'Changed account access',
  'user.setRole': 'Changed account role',
}

export function formatAuditAction(action: string): string {
  return ACTION_LABELS[action] ?? action
    .replace(/\./g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (letter) => letter.toUpperCase())
}

function labelForField(field: string): string {
  const referenceFieldLabels: Record<string, string> = {
    assignedRepId: 'Assigned rep',
    skippedRepId: 'Skipped rep',
    repId: 'Rep',
  }
  if (referenceFieldLabels[field]) return referenceFieldLabels[field]
  return field
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (letter) => letter.toUpperCase())
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function displayAuditValue(value: unknown, referenceLabels: Record<string, string>): string {
  if (value == null || value === '') return 'Not set'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'string' && UUID_PATTERN.test(value)) {
    return referenceLabels[value] ?? 'Record unavailable'
  }
  if (typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value)) {
    return value.toLowerCase().replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase())
  }
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`
  if (typeof value === 'object') return 'Updated details'
  return String(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function summarizeAuditChanges(
  before: unknown,
  after: unknown,
  referenceLabels: Record<string, string> = {},
): string[] {
  if (before == null && isRecord(after)) {
    const fields = Object.keys(after)
    return [`Created with ${fields.length} recorded field${fields.length === 1 ? '' : 's'}`]
  }
  if (isRecord(before) && after == null) return ['Record removed']
  if (!isRecord(before) || !isRecord(after)) return ['Technical details changed']

  const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .map(
      (field) =>
        `${labelForField(field)}: ${displayAuditValue(before[field], referenceLabels)} → ${displayAuditValue(after[field], referenceLabels)}`,
    )
  if (changes.length <= 3) return changes.length ? changes : ['No field-level change recorded']
  return [...changes.slice(0, 3), `+${changes.length - 3} more changes`]
}

export type AuditItem = {
  id: string; createdAt: string; actor: { displayName: string | null; email: string } | null
  action: string; entityType: string; entityId: string; before: unknown; after: unknown
  entityDisplay: { kind: string; label: string }; referenceLabels: Record<string, string>
}
type AuditResponse = { items: AuditItem[]; hasMore: boolean }
type FilterOption = { id: string; label: string }
type FilterOptions = {
  actions: Array<{ value: string; label: string }>
  actors: FilterOption[]
  users: FilterOption[]
  reps: FilterOption[]
}
export type AuditFilters = {
  action: string
  actorUserId: string
  affectedKind: '' | 'USER' | 'REP' | 'LEAD'
  affectedId: string
  fromDate: string
  toDate: string
}

export const EMPTY_AUDIT_FILTERS: AuditFilters = {
  action: '', actorUserId: '', affectedKind: '', affectedId: '', fromDate: '', toDate: '',
}

export function buildAuditListInput(filters: AuditFilters, offset: number): Record<string, unknown> {
  return {
    limit: 50,
    offset,
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
    ...(filters.affectedKind && filters.affectedId
      ? { affected: { kind: filters.affectedKind, id: filters.affectedId } }
      : {}),
    ...(filters.fromDate ? { fromDate: filters.fromDate } : {}),
    ...(filters.toDate ? { toDate: filters.toDate } : {}),
  }
}

export function auditFiltersAreActive(filters: AuditFilters): boolean {
  return !!(
    filters.action
    || filters.actorUserId
    || (filters.affectedKind && filters.affectedId)
    || filters.fromDate
    || filters.toDate
  )
}

function affectedSelectionIsComplete(filters: AuditFilters): boolean {
  return !filters.affectedKind || !!filters.affectedId
}

type FilterRegionProps = {
  staged: AuditFilters
  options: FilterOptions | null
  optionsError: boolean
  busy: boolean
  onChange: (filters: AuditFilters) => void
  onApply: (event: FormEvent<HTMLFormElement>) => void
  onClear: () => void
  onRetryOptions: () => void
}

export function AuditFilterRegion({
  staged,
  options,
  optionsError,
  busy,
  onChange,
  onApply,
  onClear,
  onRetryOptions,
}: FilterRegionProps) {
  const set = (change: Partial<AuditFilters>) => onChange({ ...staged, ...change })
  const affectedOptions = staged.affectedKind === 'USER' ? options?.users : options?.reps

  return <section className="ui-audit-filters" aria-labelledby="audit-filter-title">
    <h3 id="audit-filter-title">Filter audit events</h3>
    {optionsError && <p className="ui-error" role="alert">Couldn’t load filter choices. <button type="button" className="ui-linkbtn" onClick={onRetryOptions}>Retry</button></p>}
    <form onSubmit={onApply}>
      <div className="ui-audit-filter-grid">
        <Field label="Action type">
          <Select value={staged.action} onChange={(event) => set({ action: event.target.value })}>
            <option value="">All action types</option>
            {options?.actions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
        </Field>
        <Field label="Actor">
          <Select value={staged.actorUserId} onChange={(event) => set({ actorUserId: event.target.value })}>
            <option value="">All actors</option>
            {options?.actors.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </Select>
        </Field>
        <Field label="Affected kind">
          <Select value={staged.affectedKind} onChange={(event) => set({
            affectedKind: event.target.value as AuditFilters['affectedKind'],
            affectedId: '',
          })}>
            <option value="">Any affected record</option>
            <option value="USER">User</option>
            <option value="REP">Rep</option>
            <option value="LEAD">Lead</option>
          </Select>
        </Field>
        {(staged.affectedKind === 'USER' || staged.affectedKind === 'REP') && <Field label={staged.affectedKind === 'USER' ? 'Affected user' : 'Affected rep'}>
          <Select required value={staged.affectedId} onChange={(event) => set({ affectedId: event.target.value })}>
            <option value="">Select {staged.affectedKind === 'USER' ? 'a user' : 'a rep'}</option>
            {affectedOptions?.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </Select>
        </Field>}
        {staged.affectedKind === 'LEAD' && <Field label="Lead ID">
          <Input required type="text" inputMode="text" value={staged.affectedId} onChange={(event) => set({ affectedId: event.target.value })} pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}" placeholder="Exact lead UUID" />
        </Field>}
        <Field label="From date">
          <Input type="date" value={staged.fromDate} max={staged.toDate || undefined} onChange={(event) => set({ fromDate: event.target.value })} />
        </Field>
        <Field label="To date">
          <Input type="date" value={staged.toDate} min={staged.fromDate || undefined} onChange={(event) => set({ toDate: event.target.value })} />
        </Field>
      </div>
      <div className="ui-audit-filter-actions">
        <Button type="submit" variant="primary" disabled={busy || !affectedSelectionIsComplete(staged)}>Apply filters</Button>
        <Button type="button" disabled={busy} onClick={onClear}>Clear filters</Button>
      </div>
    </form>
  </section>
}

export function AuditEventCard({ item }: { item: AuditItem }) {
  const actorName = item.actor?.displayName ?? item.actor?.email ?? 'Unknown historic actor'

  return <article className="ui-audit-entry">
    <header className="ui-audit-head">
      <div className="ui-audit-action">
        <strong>{formatAuditAction(item.action)}</strong>
        <span className="ui-card-kicker">{item.action}</span>
      </div>
      <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
    </header>
    <div className="ui-audit-meta">
      <span><strong>{actorName}</strong>{item.actor?.displayName ? ` · ${item.actor.email}` : ''}</span>
      <span>{item.entityDisplay.kind} · {item.entityDisplay.label}</span>
    </div>
    <ul className="ui-audit-summary">
      {summarizeAuditChanges(item.before, item.after, item.referenceLabels).map((change) => <li key={change}>{change}</li>)}
    </ul>
    <details className="ui-audit-details">
      <summary>Technical details</summary>
      <p><strong>Entity type</strong> <code>{item.entityType}</code></p>
      <p><strong>Entity ID</strong> <code>{item.entityId}</code></p>
      <div className="ui-audit-diff">
        <section><strong>Before</strong><pre>{formatAuditValue(item.before, item.after, 'before')}</pre></section>
        <section><strong>After</strong><pre>{formatAuditValue(item.after, item.before, 'after')}</pre></section>
      </div>
    </details>
  </article>
}

export function AuditLog() {
  const [data, setData] = useState<AuditResponse | null>(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [offset, setOffset] = useState(0)
  const [staged, setStaged] = useState<AuditFilters>({ ...EMPTY_AUDIT_FILTERS })
  const [committed, setCommitted] = useState<AuditFilters>({ ...EMPTY_AUDIT_FILTERS })
  const [options, setOptions] = useState<FilterOptions | null>(null)
  const [optionsError, setOptionsError] = useState(false)
  const listGeneration = useRef(0)

  const load = useCallback((filters: AuditFilters, nextOffset: number) => {
    const generation = ++listGeneration.current
    setBusy(true)
    setError(false)
    const input = buildAuditListInput(filters, nextOffset)
    query<AuditResponse>(`audit.list?input=${encodeURIComponent(JSON.stringify(input))}`)
      .then((response) => {
        if (generation === listGeneration.current) setData(response)
      })
      .catch(() => {
        if (generation === listGeneration.current) setError(true)
      })
      .finally(() => {
        if (generation === listGeneration.current) setBusy(false)
      })
  }, [])

  const loadOptions = useCallback(() => {
    setOptionsError(false)
    query<FilterOptions>('audit.filterOptions').then(setOptions).catch(() => setOptionsError(true))
  }, [])

  useEffect(() => {
    load(EMPTY_AUDIT_FILTERS, 0)
    loadOptions()
  }, [load, loadOptions])

  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setCommitted(staged)
    setOffset(0)
    load(staged, 0)
  }
  const clear = () => {
    const empty = { ...EMPTY_AUDIT_FILTERS }
    setStaged(empty)
    setCommitted(empty)
    setOffset(0)
    load(empty, 0)
  }
  const page = (nextOffset: number) => {
    setOffset(nextOffset)
    load(committed, nextOffset)
  }
  const filtersActive = auditFiltersAreActive(committed)

  return <div className="ui-page ui-audit-page">
    <div className="ui-toolbar">
      <div>
        <h2>Audit log</h2>
        <p className="ui-muted">A chronological record of assignments, account changes, activity, and manager decisions.</p>
      </div>
      <span className="ui-toolbar-spacer" />
      <span className="ui-card-kicker">Newest first</span>
    </div>
    <AuditFilterRegion staged={staged} options={options} optionsError={optionsError} busy={busy} onChange={setStaged} onApply={apply} onClear={clear} onRetryOptions={loadOptions} />
    <p className="ui-sr-only" role="status" aria-live="polite">{busy ? 'Updating audit log…' : ''}</p>
    {error && <p className="ui-error" role="alert">Couldn’t update the audit log.{data ? ' Showing the last successful results.' : ''} <button type="button" className="ui-linkbtn" onClick={() => load(committed, offset)} disabled={busy}>Retry</button></p>}
    {!data && busy && <p>Loading…</p>}
    {data && <>
      <div className="ui-audit-results">
        <p className="ui-muted">Showing {data.items.length} events on this page</p>
        {filtersActive && <button type="button" className="ui-linkbtn" onClick={clear} disabled={busy}>Clear filters</button>}
      </div>
      {data.items.length === 0 ? <p className="ui-muted">{filtersActive ? 'No audit events match these filters.' : 'No audit events yet.'}</p> : <div className="ui-audit-list">
        {data.items.map((item) => <AuditEventCard item={item} key={item.id} />)}
      </div>}
      {(offset > 0 || data.hasMore) && <div className="ui-toolbar ui-section-gap"><Button disabled={busy || offset === 0} onClick={() => page(Math.max(0, offset - 50))}>Previous</Button><Button disabled={busy || !data.hasMore} onClick={() => page(offset + 50)}>Next</Button></div>}
    </>}
  </div>
}