export type Role = 'ADMIN' | 'MANAGER' | 'BDC' | 'REP'

export type Permission =
  | 'board.view'
  | 'lead.assign'
  | 'lead.void'
  | 'lead.assign.override'
  | 'rep.override'
  | 'schedule.manage'
  | 'activity.self'
  | 'reactivation.review'
  | 'reactivation.self'
  | 'audit.view'
  | 'user.manage'
  | 'admin.*'

const MATRIX: Record<Role, Permission[]> = {
  ADMIN: [
    'board.view', 'lead.assign', 'lead.void', 'lead.assign.override', 'rep.override',
    'schedule.manage', 'activity.self', 'reactivation.review', 'reactivation.self',
    'audit.view', 'user.manage', 'admin.*',
  ],
  MANAGER: [
    'board.view', 'lead.assign', 'lead.void', 'lead.assign.override', 'rep.override',
    'schedule.manage', 'activity.self', 'reactivation.review', 'audit.view', 'user.manage',
  ],
  BDC: ['board.view', 'lead.assign', 'lead.void', 'activity.self'],
  REP: ['board.view', 'activity.self', 'reactivation.self'],
}

export function hasPermission(role: Role, perm: Permission): boolean {
  return MATRIX[role].includes(perm)
}
