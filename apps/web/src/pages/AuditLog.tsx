import { useCallback, useEffect, useState } from 'react'
import { query } from '../lib/api'

export function formatAuditValue(value: unknown): string {
  return value == null ? '—' : JSON.stringify(value, null, 2)
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

  if (error && !data) return <div className="ui-page"><p className="ui-error">Couldn’t load the audit log. <button type="button" className="ui-linkbtn" onClick={load}>Retry</button></p></div>
  if (!data) return <div className="ui-page">Loading…</div>
  return <div className="ui-page">
    <h2>Audit log</h2>
    {data.items.length === 0 ? <p className="ui-muted">No audit events yet.</p> : <div className="ui-stack">
      {data.items.map((item) => <article className="ui-card" key={item.id}>
        <div className="ui-toolbar"><strong>{item.action}</strong><span className="ui-toolbar-spacer" /><time>{new Date(item.createdAt).toLocaleString()}</time></div>
        <p><strong>Actor:</strong> {item.actor ? `${item.actor.displayName ?? item.actor.email} (${item.actor.email})` : 'Unknown historic actor'}</p>
        <p><strong>Entity:</strong> {item.entityType} / {item.entityId}</p>
        <div className="ui-toolbar"><div><strong>Before</strong><pre>{formatAuditValue(item.before)}</pre></div><div><strong>After</strong><pre>{formatAuditValue(item.after)}</pre></div></div>
      </article>)}
    </div>}
    {(offset > 0 || data.hasMore) && <div className="ui-toolbar"><button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button><button type="button" disabled={!data.hasMore} onClick={() => setOffset(offset + 50)}>Next</button></div>}
  </div>
}
