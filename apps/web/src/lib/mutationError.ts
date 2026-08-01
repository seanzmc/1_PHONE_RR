const KNOWN_MESSAGES: Array<[RegExp, string]> = [
  [/failed to fetch|networkerror|network request failed/i, 'Connection lost. Check your network and try again.'],
  [/assignment changed/i, 'This lead was already changed. Refresh the roster before trying again.'],
  [/void window has closed/i, 'This assignment can no longer be voided. Ask a Manager or Admin for help.'],
  [/can only void your own leads/i, 'You can only void assignments you created. Ask a Manager or Admin for help.'],
  [/target rep is already assigned/i, 'Choose a different rep; this lead is already assigned to that person.'],
  [/target rep account is disabled or missing/i, 'That rep is no longer available. Refresh and choose another rep.'],
  [/only assigned leads can be reassigned/i, 'This lead is no longer assigned. Refresh the page before trying again.'],
  [/reason is required|reasonnote/i, 'Enter a reason before continuing.'],
  [/unauthorized|not logged in/i, 'Your session expired. Sign in again, then retry.'],
  [/forbidden/i, 'You do not have permission to complete this action.'],
]

/** Keep raw validation payloads and server internals out of the BDC hot path. */
export function mutationErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const trimmed = message.trimStart()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return fallback
  for (const [pattern, copy] of KNOWN_MESSAGES) {
    if (pattern.test(message)) return copy
  }
  return fallback
}
