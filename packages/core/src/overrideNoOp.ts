/**
 * Whether a status action would accomplish anything the manager can see.
 *
 * One definition, deliberately shared: the Staff List uses it to disable a button and
 * `bulkOverrideStatus` re-checks it inside the transaction against a fresh row. Two copies
 * would drift, and a button reading "Already inactive" for a rep the server would happily
 * have deactivated is worse than no rule at all.
 *
 * The rule is keyed on the status a manager can SEE, not on whether the write would differ.
 * A rep who is ineligible only because it is their scheduled day off therefore cannot be
 * deactivated today — that is done the next day they are in. Accepted in the design.
 */
export type OverrideTarget = 'FORCE_ACTIVE' | 'FORCE_INACTIVE' | 'FOLLOW_SCHEDULE'

/** A rep's status today, normalized from either a `rep_daily_status` row or a roster entry. */
export type CurrentRepStatus = {
  isEligible: boolean
  /** `null` when the rep has no `rep_daily_status` row for today. */
  decidedBy: 'SYSTEM' | 'MANAGER_OVERRIDE' | null
}

export function isOverrideNoOp(target: OverrideTarget, current: CurrentRepStatus): boolean {
  switch (target) {
    case 'FORCE_ACTIVE':
      return current.isEligible
    case 'FORCE_INACTIVE':
      return !current.isEligible
    case 'FOLLOW_SCHEDULE':
      // Following the schedule releases a manager override. With none in place there is
      // nothing to release, whatever today's status happens to be.
      return current.decidedBy !== 'MANAGER_OVERRIDE'
  }
}

/** Hover text for a button disabled by the rule above. A dead button should say why. */
export function noOpReason(target: OverrideTarget): string {
  switch (target) {
    case 'FORCE_ACTIVE':
      return 'Already active'
    case 'FORCE_INACTIVE':
      return 'Already inactive'
    case 'FOLLOW_SCHEDULE':
      return 'No manager override to release'
  }
}
