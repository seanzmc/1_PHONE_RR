import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createLifecycleContainer } from '../test/reactLifecycle'
import { Modal, ModalFocusLifecycle, requestModalCloseFromBackdrop } from './Modal'

describe('Modal', () => {
  it('renders a danger submit action and its safe cancel label', () => {
    const html = renderToStaticMarkup(
      <Modal
        open
        title="Discard unsaved changes?"
        onClose={() => {}}
        onSubmit={() => {}}
        submitLabel="Discard changes"
        submitTone="danger"
        cancelLabel="Keep editing"
      >
        <p>Closing will clear the information you entered.</p>
      </Modal>,
    )

    expect(html).toContain('ui-btn-danger')
    expect(html).toContain('Keep editing')
  })

  it('waits for the completed backdrop click before closing', () => {
    const backdrop = {} as HTMLDivElement
    const onClose = vi.fn()

    requestModalCloseFromBackdrop(
      { type: 'mousedown', target: backdrop, currentTarget: backdrop },
      onClose,
    )
    requestModalCloseFromBackdrop(
      { type: 'mouseup', target: backdrop, currentTarget: backdrop },
      onClose,
    )
    expect(onClose).not.toHaveBeenCalled()

    requestModalCloseFromBackdrop(
      { type: 'click', target: backdrop, currentTarget: backdrop },
      onClose,
    )
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('restores the pre-inert requester only after actual unmount under Strict Mode', async () => {
    let drawerInert = true
    const requester = {
      isConnected: true,
      closest: vi.fn(() => (drawerInert ? {} : null)),
      focus: vi.fn(),
    }
    const body = { focus: vi.fn() }
    const initial = { focus: vi.fn() }
    const lifecycle = createLifecycleContainer(body as unknown as HTMLElement)
    const panelRef = { current: {} as HTMLElement | null }
    const initialFocusRef = { current: initial as unknown as HTMLElement | null }
    const returnFocusRef = { current: requester as unknown as HTMLElement | null }
    const root = createRoot(lifecycle.container)

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <ModalFocusLifecycle
              panelRef={panelRef}
              initialFocusRef={initialFocusRef}
              returnFocusRef={returnFocusRef}
            />
          </StrictMode>,
        )
      })
      expect(initial.focus).toHaveBeenCalledTimes(2)
      expect(requester.focus).not.toHaveBeenCalled()

      returnFocusRef.current = initial as unknown as HTMLElement
      drawerInert = false
      panelRef.current = null
      await act(async () => root.unmount())

      expect(requester.closest).toHaveBeenCalledWith('[inert]')
      expect(requester.focus).toHaveBeenCalledOnce()
      expect(body.focus).not.toHaveBeenCalled()
      expect(initial.focus).toHaveBeenCalledTimes(2)
    } finally {
      lifecycle.cleanup()
    }
  })
})
