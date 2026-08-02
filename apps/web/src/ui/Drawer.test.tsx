import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createLifecycleContainer } from '../test/reactLifecycle'
import {
  canCloseDrawer,
  Drawer,
  DrawerCloseRequesterLifecycle,
  DrawerFocusLifecycle,
  focusDrawerInitialElement,
  requestDrawerClose,
  requestDrawerCloseFromBackdrop,
  restoreDrawerFocus,
} from './Drawer'

describe('Drawer', () => {
  it('renders one named modal drawer with one accessible X disabled while busy', () => {
    const html = renderToStaticMarkup(
      <Drawer open title="Assign lead" busy onClose={() => {}}>
        <p>Drawer body</p>
      </Drawer>,
    )

    expect(html.match(/role="dialog"/g)).toHaveLength(1)
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-label="Assign lead"')
    expect(html.match(/aria-label="Close Assign lead"/g)).toHaveLength(1)
    expect(html).toContain('>×</button>')
    expect(html).toContain('disabled=""')
  })

  it('allows close only while neither busy nor inactive', () => {
    expect(canCloseDrawer(false, false)).toBe(true)
    expect(canCloseDrawer(true, false)).toBe(false)
    expect(canCloseDrawer(false, true)).toBe(false)
  })

  it('waits for the completed backdrop click before requesting close', () => {
    const backdrop = {} as HTMLDivElement
    const requestClose = vi.fn()

    requestDrawerCloseFromBackdrop(
      { type: 'mousedown', target: backdrop, currentTarget: backdrop },
      requestClose,
    )
    requestDrawerCloseFromBackdrop(
      { type: 'mouseup', target: backdrop, currentTarget: backdrop },
      requestClose,
    )
    expect(requestClose).not.toHaveBeenCalled()

    requestDrawerCloseFromBackdrop(
      { type: 'click', target: backdrop, currentTarget: backdrop },
      requestClose,
    )
    expect(requestClose).toHaveBeenCalledOnce()
  })

  it('carries the actual X, Escape, and pre-blur backdrop requesters through the shared close', async () => {
    const body = {} as HTMLElement
    const nameInput = {} as HTMLElement
    const closeButton = {} as HTMLElement
    const lifecycle = createLifecycleContainer(nameInput)
    const panel = Object.assign(new EventTarget(), {
      contains: (candidate: unknown) => candidate === nameInput || candidate === closeButton,
    })
    const panelRef = { current: panel as unknown as HTMLElement | null }
    const requesterRef = { current: null as HTMLElement | null }
    const onClose = vi.fn()
    const root = createRoot(lifecycle.container)

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <DrawerCloseRequesterLifecycle panelRef={panelRef} requesterRef={requesterRef} />
          </StrictMode>,
        )
      })

      expect(requesterRef.current).toBe(nameInput)
      const requestClose = () => requestDrawerClose(false, false, requesterRef.current, onClose)
      lifecycle.document.activeElement = body

      const backdrop = {} as HTMLDivElement
      requestDrawerCloseFromBackdrop(
        { type: 'click', target: backdrop, currentTarget: backdrop },
        requestClose,
      )
      expect(onClose).toHaveBeenNthCalledWith(1, nameInput)

      lifecycle.document.activeElement = closeButton
      panel.dispatchEvent(new Event('focusin'))
      requestClose()
      expect(onClose).toHaveBeenNthCalledWith(2, closeButton)

      lifecycle.document.activeElement = nameInput
      panel.dispatchEvent(new Event('focusin'))
      requestClose()
      expect(onClose).toHaveBeenNthCalledWith(3, nameInput)
    } finally {
      await act(async () => root.unmount())
      lifecycle.cleanup()
    }
  })

  it('focuses an explicit initial target while preserving first-focus fallback', () => {
    const fallback = { focus: vi.fn() }
    const preferred = { focus: vi.fn() }
    const panel = { querySelector: vi.fn(() => fallback) }

    focusDrawerInitialElement(panel as unknown as HTMLElement, preferred as unknown as HTMLElement)
    expect(preferred.focus).toHaveBeenCalledOnce()
    expect(panel.querySelector).not.toHaveBeenCalled()

    focusDrawerInitialElement(panel as unknown as HTMLElement, null)
    expect(fallback.focus).toHaveBeenCalledOnce()
  })

  it('renders nested confirmations outside the inert drawer section', () => {
    const html = renderToStaticMarkup(
      <Drawer
        open
        title="Assign lead"
        inactive
        onClose={() => {}}
        overlays={<div role="dialog">Discard unsaved changes?</div>}
      >
        <p>Drawer body</p>
      </Drawer>,
    )

    expect(html).toContain('<section class="ui-drawer"')
    expect(html).toContain('inert=""')
    expect(html.indexOf('Discard unsaved changes?')).toBeGreaterThan(html.indexOf('</section>'))
  })

  it('restores captured focus only after the drawer panel is unmounted', async () => {
    const panel = { focus: vi.fn() }
    const captured = { focus: vi.fn() }
    const panelRef = { current: panel as unknown as HTMLElement | null }

    restoreDrawerFocus(panelRef, captured as unknown as HTMLElement)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(panel.focus).not.toHaveBeenCalled()
    expect(captured.focus).not.toHaveBeenCalled()

    panelRef.current = null
    restoreDrawerFocus(panelRef, captured as unknown as HTMLElement)
    expect(captured.focus).toHaveBeenCalledOnce()
  })

  it('does not replay captured-focus restoration while mounted in Strict Mode', async () => {
    const captured = { focus: vi.fn() }
    const lifecycle = createLifecycleContainer(captured as unknown as HTMLElement)
    const initial = {
      focus: vi.fn(() => {
        lifecycle.document.activeElement = initial as unknown as HTMLElement
      }),
    }
    const panelRef = { current: {} as HTMLElement | null }
    const initialFocusRef = { current: initial as unknown as HTMLElement | null }
    const root = createRoot(lifecycle.container)

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <DrawerFocusLifecycle open panelRef={panelRef} initialFocusRef={initialFocusRef} />
          </StrictMode>,
        )
      })
      expect(initial.focus).toHaveBeenCalledTimes(2)
      expect(captured.focus).not.toHaveBeenCalled()

      panelRef.current = null
      await act(async () => root.unmount())
      expect(captured.focus).toHaveBeenCalledOnce()
    } finally {
      lifecycle.cleanup()
    }
  })
})
