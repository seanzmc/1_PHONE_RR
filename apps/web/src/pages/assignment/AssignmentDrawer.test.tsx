import { StrictMode, act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createLifecycleContainer } from '../../test/reactLifecycle'
import {
  AssignmentFocusLifecycle,
  AssignmentResult,
  assignmentButtonLabel,
  canNavigateToRep,
  canOpenVoidShortcut,
  freshAssignmentTargetName,
  isAssignmentBusy,
  loadLatestRoster,
} from './AssignmentDrawer'
import type { AssignResult, RosterEntry } from './model'

const assignedResult: AssignResult = {
  leadId: 'lead-1',
  assignedRepId: 'rep-raul',
  queueSnapshot: [],
  duplicatePhone: false,
  customerName: 'Kev Tom',
  assignedAt: '2026-08-02T15:00:00.000Z',
}

describe('AssignmentDrawer', () => {
  it('renders a rep-first saved result and no clipboard affordance', () => {
    const html = renderToStaticMarkup(createElement(AssignmentResult, {
      result: assignedResult,
      repName: 'Raul Valle',
      phoneE164: '+13015550142',
      canSkip: true,
      canVoid: true,
      busy: false,
      skipEditorOpen: true,
      onSkip: () => {},
      onVoid: () => {},
    }, createElement('p', null, 'Inline Skip editor')))

    expect(html).toContain('ui-assignment-result-rep')
    expect(html.indexOf('Raul Valle')).toBeLessThan(html.indexOf('Kev Tom'))
    expect(html.indexOf('Kev Tom')).toBeLessThan(html.indexOf('(301) 555-0142'))
    expect(html.indexOf('(301) 555-0142')).toBeLessThan(html.indexOf('Assigned at 11:00 AM'))
    expect(html).toContain('Inline Skip editor')
    expect(html).not.toContain('Void (Alt+V)')
    expect(html).not.toContain('Copy phone')
    expect(html).not.toContain('Alt+C')
  })

  it('names only a fresh current Next Up target in the Assign action', () => {
    const nextUp = { displayName: 'Frederick Tellis' }
    expect(freshAssignmentTargetName(nextUp, true, false, false)).toBe('Frederick Tellis')
    expect(freshAssignmentTargetName(nextUp, false, true, false)).toBeNull()
    expect(freshAssignmentTargetName(nextUp, true, true, false)).toBeNull()
    expect(freshAssignmentTargetName(nextUp, true, false, true)).toBeNull()
    expect(freshAssignmentTargetName(null, true, false, false)).toBeNull()
    expect(assignmentButtonLabel(false, 'Frederick Tellis')).toBe('Assign to Frederick Tellis (Ctrl+Enter)')
    expect(assignmentButtonLabel(false, null)).toBe('Assign (Ctrl+Enter)')
    expect(assignmentButtonLabel(true, 'Frederick Tellis')).toBe('Assigning…')
  })

  it('ignores an older roster response that resolves after the latest refresh', async () => {
    let resolveOlder!: (rows: RosterEntry[]) => void
    let resolveLatest!: (rows: RosterEntry[]) => void
    const olderRequest = new Promise<RosterEntry[]>((resolve) => { resolveOlder = resolve })
    const latestRequest = new Promise<RosterEntry[]>((resolve) => { resolveLatest = resolve })
    const latestRequestRef = { current: 1 }
    const onSuccess = vi.fn()
    const onError = vi.fn()
    const onSettled = vi.fn()

    const olderRun = loadLatestRoster(
      () => olderRequest,
      1,
      latestRequestRef,
      { onSuccess, onError, onSettled },
    )
    latestRequestRef.current = 2
    const latestRun = loadLatestRoster(
      () => latestRequest,
      2,
      latestRequestRef,
      { onSuccess, onError, onSettled },
    )
    const latestRows = [{ displayName: 'Fresh Rep' }] as RosterEntry[]
    resolveLatest(latestRows)
    await latestRun
    resolveOlder([{ displayName: 'Stale Rep' }] as RosterEntry[])
    await olderRun

    expect(onSuccess).toHaveBeenCalledOnce()
    expect(onSuccess).toHaveBeenCalledWith(latestRows)
    expect(onError).not.toHaveBeenCalled()
    expect(onSettled).toHaveBeenCalledOnce()
  })

  it('moves focus through committed Assign and Skip transitions under Strict Mode', async () => {
    const lifecycle = createLifecycleContainer(null)
    const form = { focus: vi.fn() }
    const result = { focus: vi.fn() }
    const editor = { focus: vi.fn() }
    const skipTrigger = { focus: vi.fn() }
    const refs = {
      formRef: { current: form as unknown as HTMLElement | null },
      resultRef: { current: result as unknown as HTMLElement | null },
      skipEditorRef: { current: editor as unknown as HTMLElement | null },
      skipTriggerRef: { current: skipTrigger as unknown as HTMLElement | null },
    }
    const root = createRoot(lifecycle.container)

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <AssignmentFocusLifecycle focusTarget="form" {...refs} />
          </StrictMode>,
        )
      })
      expect(form.focus).toHaveBeenCalledTimes(2)

      await act(async () => {
        root.render(
          <StrictMode>
            <AssignmentFocusLifecycle focusTarget="result" {...refs} />
          </StrictMode>,
        )
      })
      expect(result.focus).toHaveBeenCalledOnce()

      await act(async () => {
        root.render(
          <StrictMode>
            <AssignmentFocusLifecycle focusTarget="skip-editor" {...refs} />
          </StrictMode>,
        )
      })
      expect(editor.focus).toHaveBeenCalledOnce()

      await act(async () => {
        root.render(
          <StrictMode>
            <AssignmentFocusLifecycle focusTarget="skip-trigger" {...refs} />
          </StrictMode>,
        )
      })
      expect(skipTrigger.focus).toHaveBeenCalledOnce()

      await act(async () => {
        root.render(
          <StrictMode>
            <AssignmentFocusLifecycle focusTarget="result" {...refs} />
          </StrictMode>,
        )
      })
      expect(result.focus).toHaveBeenCalledTimes(2)
    } finally {
      await act(async () => root.unmount())
      lifecycle.cleanup()
    }
  })

  it('focuses the committed form after a successful Void transition', async () => {
    const lifecycle = createLifecycleContainer(null)
    const form = { focus: vi.fn() }
    const result = { focus: vi.fn() }
    const noop = { focus: vi.fn() }
    const refs = {
      formRef: { current: form as unknown as HTMLElement | null },
      resultRef: { current: result as unknown as HTMLElement | null },
      skipEditorRef: { current: noop as unknown as HTMLElement | null },
      skipTriggerRef: { current: noop as unknown as HTMLElement | null },
    }
    const root = createRoot(lifecycle.container)

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <AssignmentFocusLifecycle focusTarget="result" {...refs} />
          </StrictMode>,
        )
      })
      expect(result.focus).toHaveBeenCalledTimes(2)

      await act(async () => {
        root.render(
          <StrictMode>
            <AssignmentFocusLifecycle focusTarget="form" {...refs} />
          </StrictMode>,
        )
      })
      expect(form.focus).toHaveBeenCalledOnce()
    } finally {
      await act(async () => root.unmount())
      lifecycle.cleanup()
    }
  })

  it('treats every assignment mutation as close-blocking', () => {
    expect(isAssignmentBusy(true, false, false)).toBe(true)
    expect(isAssignmentBusy(false, true, false)).toBe(true)
    expect(isAssignmentBusy(false, false, true)).toBe(true)
    expect(isAssignmentBusy(false, false, false)).toBe(false)
  })

  it('does not open Void from Alt+V while a nested confirmation owns focus', () => {
    expect(canOpenVoidShortcut(false, false, false)).toBe(true)
    expect(canOpenVoidShortcut(false, true, false)).toBe(false)
    expect(canOpenVoidShortcut(false, false, true)).toBe(false)
    expect(canOpenVoidShortcut(false, false, false, true)).toBe(false)
    expect(canOpenVoidShortcut(true, false, false)).toBe(false)
  })

  it('keeps rep navigation unavailable while drawer closure needs confirmation', () => {
    expect(canNavigateToRep(false, false)).toBe(true)
    expect(canNavigateToRep(false, true)).toBe(false)
    expect(canNavigateToRep(true, false)).toBe(false)
  })
})
