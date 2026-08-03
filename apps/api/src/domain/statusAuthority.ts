type ExistingStatus = {
  status: 'ELIGIBLE' | 'INELIGIBLE' | 'CONFIGURATION_ERROR'
  decidedBy: 'SYSTEM' | 'MANAGER_OVERRIDE'
} | undefined

export function managerStatusSkipsActivityEvaluation(existing: ExistingStatus): boolean {
  return existing?.decidedBy === 'MANAGER_OVERRIDE' && existing.status === 'INELIGIBLE'
}

export function managerStatusBlocksSystemWrite(
  existing: ExistingStatus,
  incomingStatus: 'ELIGIBLE' | 'INELIGIBLE' | 'CONFIGURATION_ERROR',
  source: 'ACTIVITY' | 'OTHER',
): boolean {
  if (existing?.decidedBy !== 'MANAGER_OVERRIDE') return false
  if (existing.status === 'INELIGIBLE') return true
  return !(source === 'ACTIVITY' && incomingStatus === 'INELIGIBLE')
}
