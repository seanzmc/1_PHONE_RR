import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelPhoneCopyFeedback,
  copyButtonPresentation,
  formatStatusReason,
  PhoneCopyNotice,
  RepDetail,
  reassignTargets,
  startPhoneCopy,
  todayStatusMessage,
  WritableLeadNote,
  type CopyFeedback,
  type PhoneCopyAuthority,
} from './RepDetail'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function copyHarness(writeText: (value: string) => Promise<void>) {
  const authority: PhoneCopyAuthority = { generation: 0, successTimer: null }
  let feedback: CopyFeedback = { status: 'idle' }
  const history: CopyFeedback[] = []
  const setFeedback = (next: CopyFeedback) => {
    feedback = next
    history.push(next)
  }
  const start = (leadId: string, phone: string) => startPhoneCopy({
    authority,
    leadId,
    phone,
    writeText,
    setFeedback,
  })
  return { authority, get feedback() { return feedback }, history, start }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('formatStatusReason', () => {
  it('labels bare shift-kind reasons', () => {
    expect(formatStatusReason('off')).toBe('Scheduled day off')
    expect(formatStatusReason('pto')).toBe('PTO day')
    expect(formatStatusReason('sick')).toBe('Sick day')
  })

  it('translates the WEEK_DQ prefix but keeps the numbers', () => {
    expect(formatStatusReason('WEEK_DQ: 3 calls on 2026-07-30, 10 required')).toBe(
      'Below the call minimum: 3 calls on 2026-07-30, 10 required',
    )
  })

  it('capitalizes anything else without mangling it', () => {
    expect(formatStatusReason('no schedule found for today')).toBe('No schedule found for today')
  })
})

describe('todayStatusMessage', () => {
  it('tells an eligible rep they are in the rotation', () => {
    expect(todayStatusMessage({ isEligible: true, reason: null }, true)).toContain("You're in today's rotation")
    expect(todayStatusMessage({ isEligible: true, reason: null }, false)).toContain("In today's rotation")
  })

  it('points a suspended rep at their manager and names Saturday', () => {
    const msg = todayStatusMessage(
      { isEligible: false, reason: 'WEEK_DQ: 3 calls on 2026-07-30, 10 required' },
      true,
    )
    expect(msg).toContain('suspended through Saturday')
    expect(msg).toContain('Talk to your manager')
  })

  it('points a manager at the Staff List instead', () => {
    const msg = todayStatusMessage(
      { isEligible: false, reason: 'WEEK_DQ: 3 calls on 2026-07-30, 10 required' },
      false,
    )
    expect(msg).toContain('Staff List')
  })

  it('keeps non-DQ absences informational — no false alarm, no Saturday line', () => {
    const msg = todayStatusMessage({ isEligible: false, reason: 'off' }, true)
    expect(msg).toBe('Scheduled day off.')
    expect(msg).not.toContain('Saturday')
  })

  it('has a fallback when no status row exists for today', () => {
    expect(todayStatusMessage({ isEligible: false, reason: null }, true)).toBe('Not evaluated for today yet.')
  })
})

describe('reassignTargets', () => {
  it('excludes the rep who already owns the lead', () => {
    expect(
      reassignTargets(
        [
          { repId: 'source', displayName: 'Source' },
          { repId: 'target', displayName: 'Target' },
        ],
        'source',
      ).map((row) => row.repId),
    ).toEqual(['target'])
  })
})

describe('Rep Detail guidance', () => {
  it('explains when empty lead and activity sections will populate', () => {
    const markup = renderToStaticMarkup(createElement(RepDetail))

    expect(markup).toContain("No ups yet this month — new phone-ups appear here as they&#x27;re assigned.")
    expect(markup).toContain('Call numbers appear here after the daily CRM import.')
  })

  it('uses the note prompt only as a writable textarea placeholder', () => {
    const markup = renderToStaticMarkup(createElement(WritableLeadNote, {
      value: '',
      isDirty: false,
      onChange: () => {},
      onSave: () => {},
    }))

    expect(markup).toContain('placeholder="Note for this lead…"')
    expect(markup).toContain('<textarea')
    expect(markup).not.toContain('>Note for this lead…</textarea>')
    expect(markup).not.toContain('>Save</button>')
  })
})

describe('Rep Detail phone copy feedback', () => {
  it('renders the pending, success announcement, and exact visible failure states', () => {
    expect(copyButtonPresentation({ status: 'pending', leadId: 'lead-1' }, 'lead-1')).toEqual({
      label: 'Copying…',
      disabled: true,
    })
    expect(copyButtonPresentation({ status: 'success', leadId: 'lead-1' }, 'lead-1')).toEqual({
      label: 'Copied',
      disabled: false,
    })
    expect(copyButtonPresentation({ status: 'failure', leadId: 'lead-1' }, 'lead-1')).toEqual({
      label: 'Copy',
      disabled: false,
    })

    const success = renderToStaticMarkup(createElement(PhoneCopyNotice, {
      feedback: { status: 'success', leadId: 'lead-1' },
    }))
    expect(success).toContain('role="status"')
    expect(success).toContain('Phone number copied.')

    const failure = renderToStaticMarkup(createElement(PhoneCopyNotice, {
      feedback: { status: 'failure', leadId: 'lead-1' },
    }))
    expect(failure).toContain('role="alert"')
    expect(failure).toContain("Couldn&#x27;t copy the phone number. Select the number and copy it manually.")
    expect(failure).not.toContain('Phone number copied.')
  })

  it('stays pending until digits-only clipboard writing resolves, then resets success after two seconds', async () => {
    vi.useFakeTimers()
    const write = deferred<void>()
    const writeText = vi.fn(() => write.promise)
    const copy = copyHarness(writeText)

    const attempt = copy.start('lead-1', '+1 (555) 123-4567')
    expect(copy.feedback).toEqual({ status: 'pending', leadId: 'lead-1' })
    expect(writeText).toHaveBeenCalledWith('5551234567')
    expect(copy.history).not.toContainEqual({ status: 'success', leadId: 'lead-1' })

    write.resolve()
    await attempt
    expect(copy.feedback).toEqual({ status: 'success', leadId: 'lead-1' })

    vi.advanceTimersByTime(1_999)
    expect(copy.feedback).toEqual({ status: 'success', leadId: 'lead-1' })
    vi.advanceTimersByTime(1)
    expect(copy.feedback).toEqual({ status: 'idle' })
  })

  it('shows failure without success and permits a truthful retry', async () => {
    const writeText = vi.fn()
      .mockRejectedValueOnce(new Error('clipboard denied'))
      .mockResolvedValueOnce(undefined)
    const copy = copyHarness(writeText)

    await copy.start('lead-1', '+15551234567')
    expect(copy.feedback).toEqual({ status: 'failure', leadId: 'lead-1' })
    expect(copy.history).not.toContainEqual({ status: 'success', leadId: 'lead-1' })

    await copy.start('lead-1', '+15551234567')
    expect(copy.history.at(-2)).toEqual({ status: 'pending', leadId: 'lead-1' })
    expect(copy.feedback).toEqual({ status: 'success', leadId: 'lead-1' })
    cancelPhoneCopyFeedback(copy.authority)
  })

  it.each(['resolve', 'reject'] as const)(
    'does not let an older late %s replace the latest attempt',
    async (olderSettlement) => {
    const older = deferred<void>()
    const newer = deferred<void>()
    const writeText = vi.fn()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise)
    const copy = copyHarness(writeText)

    const olderAttempt = copy.start('lead-old', '+15550000001')
    const newerAttempt = copy.start('lead-new', '+15550000002')
    newer.resolve()
    await newerAttempt
    expect(copy.feedback).toEqual({ status: 'success', leadId: 'lead-new' })

    if (olderSettlement === 'resolve') older.resolve()
    else older.reject(new Error('late rejection'))
    await olderAttempt
    expect(copy.feedback).toEqual({ status: 'success', leadId: 'lead-new' })
    cancelPhoneCopyFeedback(copy.authority)
    },
  )

  it('replaces the old success timer and cancels pending feedback work on cleanup', async () => {
    vi.useFakeTimers()
    const copy = copyHarness(() => Promise.resolve())

    await copy.start('lead-1', '+15550000001')
    vi.advanceTimersByTime(1_000)
    await copy.start('lead-2', '+15550000002')
    vi.advanceTimersByTime(1_000)
    expect(copy.feedback).toEqual({ status: 'success', leadId: 'lead-2' })

    cancelPhoneCopyFeedback(copy.authority)
    vi.runAllTimers()
    expect(copy.feedback).toEqual({ status: 'success', leadId: 'lead-2' })
  })
})
