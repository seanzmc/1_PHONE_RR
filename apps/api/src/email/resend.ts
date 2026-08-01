export type PasswordResetEmail = {
  to: string
  displayName: string | null
  resetUrl: string
  expiresAt: Date
}

export type PasswordResetEmailSender = (email: PasswordResetEmail) => Promise<void>

type ResendConfig = {
  apiKey: string
  from: string
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function emailBody(email: PasswordResetEmail): { text: string; html: string } {
  const greeting = email.displayName ? `Hi ${email.displayName},` : 'Hello,'
  const expiresAt = email.expiresAt.toISOString()
  const text = [
    greeting,
    '',
    'Someone requested a password reset for your PhoneUp account.',
    'Use the link below to choose a new password. This single-use link expires in 30 minutes.',
    '',
    email.resetUrl,
    '',
    `Expires at ${expiresAt}.`,
    'If you did not request this, you can ignore this email and your password will stay the same.',
  ].join('\n')

  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    '<p>Someone requested a password reset for your PhoneUp account.</p>',
    '<p>Use the link below to choose a new password. This single-use link expires in 30 minutes.</p>',
    `<p><a href="${escapeHtml(email.resetUrl)}">Reset your PhoneUp password</a></p>`,
    `<p>Expires at ${escapeHtml(expiresAt)}.</p>`,
    '<p>If you did not request this, you can ignore this email and your password will stay the same.</p>',
  ].join('')

  return { text, html }
}

export function createResendPasswordResetSender(
  config: ResendConfig,
  fetchImpl: typeof fetch = fetch,
): PasswordResetEmailSender {
  return async (email) => {
    if (!config.apiKey.trim() || !config.from.trim()) {
      throw new Error('Resend email is not configured')
    }

    const body = emailBody(email)
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'PhoneUp/1.0',
      },
      body: JSON.stringify({
        from: config.from,
        to: [email.to],
        subject: 'Reset your PhoneUp password',
        text: body.text,
        html: body.html,
      }),
    })

    if (!response.ok) {
      throw new Error(`Resend email request failed (${response.status})`)
    }
  }
}
