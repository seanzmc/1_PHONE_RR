type HistoryLike = Pick<History, 'replaceState'>

export function resetPasswordValidation(newPassword: string, confirmPassword: string) {
  const tooShort = newPassword.length > 0 && newPassword.length < 8
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword
  return {
    valid: newPassword.length >= 8 && newPassword === confirmPassword,
    tooShort,
    mismatch,
  }
}

export function clearResetTokenFromUrl(history: HistoryLike = window.history): void {
  history.replaceState(null, '', '/')
}

export function requestAnotherReset(
  history: HistoryLike,
  openRecovery: () => void,
): void {
  clearResetTokenFromUrl(history)
  openRecovery()
}
