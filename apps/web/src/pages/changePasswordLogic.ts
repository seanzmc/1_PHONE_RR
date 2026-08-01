export const VOLUNTARY_PASSWORD_SUCCESS = 'Password changed successfully.'

export function changePasswordFields(forced: boolean): Array<'current' | 'new' | 'confirm'> {
  return forced ? ['new', 'confirm'] : ['current', 'new', 'confirm']
}
