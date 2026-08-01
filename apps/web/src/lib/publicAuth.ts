export function resetTokenFromLocation(search: string): string | null {
  const token = new URLSearchParams(search).get('reset_token')?.trim()
  return token || null
}
