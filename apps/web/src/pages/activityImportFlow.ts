export type ImportPhase =
  | 'idle'
  | 'reading'
  | 'previewing'
  | 'decision'
  | 'committing'
  | 'done'

export type SaveDecision = 'LOG_ONLY' | 'LOG_AND_DEACTIVATE'
export type DecisionAction = SaveDecision | 'CANCEL'

export const MAX_ACTIVITY_IMPORT_FILE_BYTES = 5_000_000

export function activityImportFileSizeAllowed(size: number): boolean {
  return size <= MAX_ACTIVITY_IMPORT_FILE_BYTES
}

/** Prior calendar date in the store's timezone, independent of the browser's timezone. */
export function priorEasternBusinessDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value)
  const easternDate = new Date(Date.UTC(value('year'), value('month') - 1, value('day')))
  easternDate.setUTCDate(easternDate.getUTCDate() - 1)
  return easternDate.toISOString().slice(0, 10)
}

export function decisionActions(ineligibleCount: number): Array<{ id: DecisionAction; label: string }> {
  return [
    {
      id: 'LOG_AND_DEACTIVATE',
      label: `Yes — log numbers & deactivate ${ineligibleCount}`,
    },
    { id: 'LOG_ONLY', label: 'No — log numbers only' },
    { id: 'CANCEL', label: 'Cancel entire import' },
  ]
}

/**
 * Progress is determinate only when we know a real boundary. Server parse/DB work is one
 * opaque request, so those phases use the native indeterminate bar rather than a fake 63%.
 */
export function progressForPhase(
  phase: ImportPhase,
  decision?: SaveDecision,
): { value: number | undefined; label: string } {
  switch (phase) {
    case 'reading':
      return { value: 15, label: 'Reading report…' }
    case 'previewing':
      return { value: undefined, label: 'Matching reps and calculating eligibility…' }
    case 'decision':
      return { value: 100, label: 'Review ready — nothing saved yet' }
    case 'committing':
      return decision === 'LOG_AND_DEACTIVATE'
        ? { value: undefined, label: 'Saving activity and applying deactivations…' }
        : { value: undefined, label: 'Saving activity numbers…' }
    case 'done':
      return { value: 100, label: 'Complete' }
    default:
      return { value: 0, label: 'Ready' }
  }
}
