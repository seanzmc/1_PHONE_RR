import { describe, expect, it, vi } from 'vitest'
import { createResendPasswordResetSender } from './resend'

describe('createResendPasswordResetSender', () => {
  it('sends plain-text and HTML reset email through the Resend API', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: 'email-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const send = createResendPasswordResetSender(
      { apiKey: 'test-api-key', from: 'PhoneUp <security@example.test>' },
      fetchImpl as typeof fetch,
    )

    await send({
      to: 'active@example.test',
      displayName: 'Active User',
      resetUrl: 'https://phoneup.example/?reset_token=plaintext',
      expiresAt: new Date('2026-08-01T17:30:00.000Z'),
    })

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.resend.com/emails')
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer test-api-key',
        'Content-Type': 'application/json',
        'User-Agent': 'PhoneUp/1.0',
      }),
    })

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(body).toMatchObject({
      from: 'PhoneUp <security@example.test>',
      to: ['active@example.test'],
      subject: 'Reset your PhoneUp password',
    })
    expect(body.text).toContain('Active User')
    expect(body.text).toContain('30 minutes')
    expect(body.text).toContain('https://phoneup.example/?reset_token=plaintext')
    expect(body.html).toContain('https://phoneup.example/?reset_token=plaintext')
  })

  it('escapes account content in the HTML email', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: 'email-2' }), { status: 200 }),
    )
    const send = createResendPasswordResetSender(
      { apiKey: 'test-api-key', from: 'PhoneUp <security@example.test>' },
      fetchImpl as typeof fetch,
    )

    await send({
      to: 'active@example.test',
      displayName: '<script>alert(1)</script>',
      resetUrl: 'https://phoneup.example/?reset_token=a&next=b',
      expiresAt: new Date('2026-08-01T17:30:00.000Z'),
    })

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(body.html).not.toContain('<script>')
    expect(body.html).toContain('&lt;script&gt;')
    expect(body.html).toContain('a&amp;next=b')
  })

  it('throws a sanitized error for a rejected Resend request', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ message: 'recipient active@example.test and test-secret leaked' }), {
        status: 403,
      }),
    )
    const send = createResendPasswordResetSender(
      { apiKey: 'test-secret', from: 'PhoneUp <security@example.test>' },
      fetchImpl as typeof fetch,
    )

    await expect(
      send({
        to: 'active@example.test',
        displayName: null,
        resetUrl: 'https://phoneup.example/?reset_token=plaintext',
        expiresAt: new Date('2026-08-01T17:30:00.000Z'),
      }),
    ).rejects.toThrow('Resend email request failed (403)')

    await expect(
      send({
        to: 'active@example.test',
        displayName: null,
        resetUrl: 'https://phoneup.example/?reset_token=plaintext',
        expiresAt: new Date('2026-08-01T17:30:00.000Z'),
      }),
    ).rejects.not.toThrow(/test-secret|active@example\.test|plaintext/)
  })

  it('rejects missing configuration before making a request', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 200 }),
    )
    const send = createResendPasswordResetSender(
      { apiKey: '', from: '' },
      fetchImpl as typeof fetch,
    )

    await expect(
      send({
        to: 'active@example.test',
        displayName: null,
        resetUrl: 'https://phoneup.example/?reset_token=plaintext',
        expiresAt: new Date('2026-08-01T17:30:00.000Z'),
      }),
    ).rejects.toThrow('Resend email is not configured')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
