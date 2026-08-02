export type Role = 'ADMIN' | 'MANAGER' | 'BDC' | 'REP'

export type Permission =
  | 'board.view'
  | 'lead.assign'
  | 'lead.skip'
  | 'lead.void'
  | 'lead.assign.override'
  | 'lead.note'
  | 'rep.override'
  | 'rep.view'
  | 'schedule.manage'
  | 'activity.self'
  | 'activity.import'
  | 'activity.edit'
  | 'audit.view'
  | 'user.manage'
  | 'admin.*'

const MATRIX: Record<Role, Permission[]> = {
  ADMIN: [
    'board.view', 'lead.assign', 'lead.skip', 'lead.void', 'lead.assign.override', 'lead.note',
    'rep.override', 'rep.view', 'schedule.manage', 'activity.self', 'activity.import',
    'activity.edit', 'audit.view', 'user.manage', 'admin.*',
  ],
  MANAGER: [
    'board.view', 'lead.assign', 'lead.skip', 'lead.void', 'lead.assign.override', 'lead.note',
    'rep.override', 'rep.view', 'schedule.manage', 'activity.self', 'activity.import',
    'activity.edit', 'audit.view', 'user.manage',
  ],
  // BDC may note their OWN leads — the router enforces ownership, this only gates the route.
  BDC: ['board.view', 'lead.assign', 'lead.skip', 'lead.void', 'lead.note', 'activity.self'],
  REP: ['board.view', 'activity.self'],
}

export function hasPermission(role: Role, perm: Permission): boolean {
  return MATRIX[role].includes(perm)
}
