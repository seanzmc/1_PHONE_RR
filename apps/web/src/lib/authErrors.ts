export type AuthErrorContext =
  | 'login'
  | 'change_password'
  | 'request_reset'
  | 'complete_reset'
  | 'manager_reset'

const FALLBACK_COPY: Record<AuthErrorContext, string> = {
  login: 'We couldn’t sign you in. Try again.',
  change_password: 'We couldn’t change your password. Try again.',
  request_reset: 'We couldn’t request a reset link. Try again.',
  complete_reset: 'We couldn’t reset your password. Request a new link and try again.',
  manager_reset: 'We couldn’t update that password. Try again.',
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : ''
}

export function authErrorCopy(error: unknown, context: AuthErrorContext): string {
  const message = messageFrom(error)

  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) {
    return 'Couldn’t contact PhoneUp. Check your connection and try again.'
  }
  if (/invalid credentials/i.test(message)) {
    return 'Email or password didn’t match — passwords are case-sensitive.'
  }
  const loginThrottle = message.match(/too many failed attempts.*?(\d+) minute/i)
  if (loginThrottle) {
    const minutes = Number(loginThrottle[1])
    return `Too many failed attempts — try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
  }
  const recoveryThrottle = message.match(/too many password reset requests.*?(\d+) minute/i)
  if (recoveryThrottle) {
    const minutes = Number(recoveryThrottle[1])
    return `Too many reset requests — try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
  }
  if (/current password is incorrect/i.test(message)) {
    return 'Your current password is incorrect. Try again.'
  }
  if (/CURRENT_PASSWORD_REQUIRED/.test(message)) {
    return 'Enter your current password to make this change.'
  }
  if (/new password must be different/i.test(message)) {
    return 'Choose a password that is different from your current password.'
  }
  if (/RESET_LINK_INVALID_OR_EXPIRED/.test(message)) {
    return 'This reset link is invalid, expired, or already used. Request a new link.'
  }

  return FALLBACK_COPY[context]
}
