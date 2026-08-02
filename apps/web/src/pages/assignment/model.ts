import type { RepRankInput } from '@phoneup/core'

export type RosterEntry = RepRankInput & {
  displayName: string
  decidedBy: 'SYSTEM' | 'MANAGER_OVERRIDE' | null
  servedAt: string | null
  skippedThisCycle: boolean
}

export type AssignResult = {
  leadId: string
  assignedRepId: string | null
  queueSnapshot: RepRankInput[]
  duplicatePhone: boolean
  customerName: string
  assignedAt: string
}

export function sortServedForDisplay(entries: RosterEntry[]): RosterEntry[] {
  return [...entries].sort((a, b) => {
    if (a.skippedThisCycle !== b.skippedThisCycle) return a.skippedThisCycle ? -1 : 1
    const timeOrder = (a.servedAt ?? '').localeCompare(b.servedAt ?? '')
    return timeOrder || a.repId.localeCompare(b.repId)
  })
}

export function bucketRoster(roster: RosterEntry[]) {
  const eligible = roster.filter((entry) => entry.isEligible)
  const unserved = eligible.filter((entry) => !entry.servedThisCycle)
  const [nextUp, ...onDeck] = unserved
  return {
    nextUp: nextUp ?? null,
    onDeck,
    served: sortServedForDisplay(eligible.filter((entry) => entry.servedThisCycle)),
    unavailable: roster.filter((entry) => !entry.isEligible),
  }
}

export function assignFormErrors(name: string, phone: string): { name?: string; phone?: string } {
  const errors: { name?: string; phone?: string } = {}
  if (!name.trim()) errors.name = "Enter the customer's name."
  const digits = phone.replace(/\D/g, '')
  if (!(digits.length === 10 || (digits.length === 11 && digits.startsWith('1')))) {
    errors.phone = 'Enter the 10-digit phone number — we add the +1 for you.'
  }
  return errors
}

export function assignEnterAction(field: 'name' | 'phone' | 'notes'): 'phone' | 'notes' | 'assign' {
  if (field === 'name') return 'phone'
  if (field === 'phone') return 'notes'
  return 'assign'
}

export function canSubmitWithRoster(
  formValid: boolean,
  hasLoadedRoster: boolean,
  assigning = false,
  readOnly = false,
): boolean {
  return formValid && hasLoadedRoster && !assigning && !readOnly
}

export function canSubmitSkip(reason: string, skipping: boolean, readOnly: boolean): boolean {
  return !!reason.trim() && !skipping && !readOnly
}

export function formatAssignmentTime(assignedAt: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  }).format(new Date(assignedAt))
}

export function formatPhone(phoneE164: string): string {
  const digits = phoneE164.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  if (digits.length !== 10) return phoneE164
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
}

export function resultGuidance(result: Pick<AssignResult, 'assignedRepId' | 'duplicatePhone'>): string[] {
  const guidance: string[] = []
  if (!result.assignedRepId) {
    guidance.push('The lead is saved in the unassigned queue. Keep the customer on the line and contact a Manager.')
  }
  if (result.duplicatePhone) {
    guidance.push('Confirm the customer details and tell the rep this may be a duplicate before continuing.')
  }
  return guidance
}

export const SKIP_PRESETS = [
  'Rep unavailable',
  'Rep already assisting a customer',
  'Customer requested another rep',
  'Manager-directed pass',
  'Other',
] as const

export type SkipPreset = typeof SKIP_PRESETS[number]

export function hasAssignmentDraft(name: string, phone: string, notes: string): boolean {
  return [name, phone, notes].some((value) => value.trim().length > 0)
}

export function hasSkipDraft(open: boolean, preset: SkipPreset | null, otherDetail: string): boolean {
  return open && (!!preset || otherDetail.trim().length > 0)
}

export function shouldConfirmDrawerClose(input: {
  formActive: boolean
  name: string
  phone: string
  notes: string
  skipOpen: boolean
  skipPreset: SkipPreset | null
  skipOtherDetail: string
}): boolean {
  return (input.formActive && hasAssignmentDraft(input.name, input.phone, input.notes))
    || hasSkipDraft(input.skipOpen, input.skipPreset, input.skipOtherDetail)
}

export function resolveSkipReason(preset: SkipPreset | null, otherDetail: string): string | null {
  if (!preset) return null
  if (preset !== 'Other') return preset
  const detail = otherDetail.trim()
  return detail ? `Other: ${detail}` : null
}
