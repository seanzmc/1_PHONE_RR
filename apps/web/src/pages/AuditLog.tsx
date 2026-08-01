import { useCallback, useEffect, useState } from 'react'
import { query } from '../lib/api'
import { Button } from '../ui'

export function formatAuditValue(value: unknown): string {
  return value == null ? '—' : JSON.stringify(value, null, 2)
}

const ACTION_LABELS: Record<string, string> = {
  'activity.import': 'Imported daily activity',
  'activity.metric.edit': 'Corrected activity metrics',
  'lead.note.set': 'Updated lead note',
  'lead.reassign': 'Reassigned lead',
  'lead.skip': 'Skipped rep and passed lead',
  'lead.void': 'Voided lead',
  'policy.set': 'Updated activity policy',
  'rep.days_off.set': 'Changed recurring day off',
  'rep.override': 'Changed rep status',
  'user.changeOwnPassword': 'Changed own password',
  'user.create': 'Created account',
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
  return field
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (letter) => letter.toUpperCase())
}

function displayAuditValue(value: unknown): string {
  if (value == null || value === '') return 'Not set'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
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

export function summarizeAuditChanges(before: unknown, after: unknown): string[] {
  if (!isRecord(before) && isRecord(after)) {
    const fields = Object.keys(after)
    return [`Created with ${fields.length} recorded field${fields.length === 1 ? '' : 's'}`]
  }
  if (isRecord(before) && !isRecord(after)) return ['Record removed']
  if (!isRecord(before) || !isRecord(after)) return ['Technical details changed']

  const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .map(
      (field) =>
        `${labelForField(field)}: ${displayAuditValue(before[field])} → ${displayAuditValue(after[field])}`,
    )
  if (changes.length <= 3) return changes.length ? changes : ['No field-level change recorded']
  return [...changes.slice(0, 3), `+${changes.length - 3} more changes`]
}

type AuditItem = {
  id: string; createdAt: string; actor: { displayName: string | null; email: string } | null
  action: string; entityType: string; entityId: string; before: unknown; after: unknown
}
type AuditResponse = { items: AuditItem[]; hasMore: boolean }

export function AuditLog() {
  const [data, setData] = useState<AuditResponse | null>(null)
  const [error, setError] = useState(false)
  const [offset, setOffset] = useState(0)
  const load = useCallback(() => {
    setError(false)
    query<AuditResponse>(`audit.list?input=${encodeURIComponent(JSON.stringify({ limit: 50, offset }))}`)
      .then(setData).catch(() => setError(true))
  }, [offset])
  useEffect(() => { load() }, [load])

  if (error && !data) return <div className="ui-page"><h2>Audit log</h2><p className="ui-error" role="alert">Couldn’t load the audit log. <button type="button" className="ui-linkbtn" onClick={load}>Retry</button></p></div>
  if (!data) return <div className="ui-page"><h2>Audit log</h2><p>Loading…</p></div>
  return <div className="ui-page">
    <div className="ui-toolbar">
      <div>
        <h2>Audit log</h2>
        <p className="ui-muted">A chronological record of assignments, account changes, activity, and manager decisions.</p>
      </div>
      <span className="ui-toolbar-spacer" />
      <span className="ui-card-kicker">Newest first</span>
    </div>
    {data.items.length === 0 ? <p className="ui-muted">No audit events yet.</p> : <div className="ui-audit-list">
      {data.items.map((item) => {
        const actorName = item.actor?.displayName ?? item.actor?.email ?? 'Unknown historic actor'
        return <article className="ui-audit-entry" key={item.id}>
          <header className="ui-audit-head">
            <div className="ui-audit-action">
              <strong>{formatAuditAction(item.action)}</strong>
              <span className="ui-card-kicker">{item.action}</span>
            </div>
            <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
          </header>
          <div className="ui-audit-meta">
            <span><strong>{actorName}</strong>{item.actor?.displayName ? ` · ${item.actor.email}` : ''}</span>
            <span>{labelForField(item.entityType)} · <code>{item.entityId}</code></span>
          </div>
          <ul className="ui-audit-summary">
            {summarizeAuditChanges(item.before, item.after).map((change) => <li key={change}>{change}</li>)}
          </ul>
          <details className="ui-audit-details">
            <summary>Technical details</summary>
            <div className="ui-audit-diff">
              <section><strong>Before</strong><pre>{formatAuditValue(item.before)}</pre></section>
              <section><strong>After</strong><pre>{formatAuditValue(item.after)}</pre></section>
            </div>
          </details>
        </article>
      })}
    </div>}
    {(offset > 0 || data.hasMore) && <div className="ui-toolbar ui-section-gap"><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</Button><Button disabled={!data.hasMore} onClick={() => setOffset(offset + 50)}>Next</Button></div>}
  </div>
}
