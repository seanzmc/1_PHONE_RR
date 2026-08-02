import { useCallback, useEffect, useRef } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export type ModalProps = {
  open: boolean
  title: string
  onClose: () => void
  onSubmit?: () => void
  /** Disables the confirm button (e.g. a required reason is still blank). */
  submitDisabled?: boolean
  submitLabel?: string
  cancelLabel?: string
  children: ReactNode
  /** Hint line under the body, defaults to a keyboard summary. */
  hint?: string
  initialFocus?: 'submit' | 'cancel'
  submitTone?: 'primary' | 'danger'
  returnFocusRef?: Readonly<{ current: HTMLElement | null }>
}

export function requestModalCloseFromBackdrop(
  event: Pick<ReactMouseEvent<HTMLDivElement>, 'type' | 'target' | 'currentTarget'>,
  onClose: () => void,
): void {
  if (event.type === 'click' && event.target === event.currentTarget) onClose()
}

export function restoreModalFocus(
  panelRef: Readonly<{ current: HTMLElement | null }>,
  requester: HTMLElement | null,
): void {
  if (
    panelRef.current
    || !requester
    || requester.isConnected === false
    || requester.closest('[inert]')
  ) return
  requester.focus()
}

export type ModalFocusLifecycleProps = {
  panelRef: Readonly<{ current: HTMLElement | null }>
  initialFocusRef?: Readonly<{ current: HTMLElement | null }>
  returnFocusRef?: Readonly<{ current: HTMLElement | null }>
}

export function ModalFocusLifecycle({
  panelRef,
  initialFocusRef,
  returnFocusRef,
}: ModalFocusLifecycleProps) {
  const previouslyFocused = useRef<HTMLElement | null>(null)
  const focusCaptured = useRef(false)

  useEffect(() => {
    if (!focusCaptured.current) {
      previouslyFocused.current = returnFocusRef?.current ?? document.activeElement as HTMLElement | null
      focusCaptured.current = true
    }
    const target = initialFocusRef?.current ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)
    target?.focus()
    return () => restoreModalFocus(panelRef, previouslyFocused.current)
  }, [panelRef, initialFocusRef, returnFocusRef])

  return null
}

/**
 * Shared confirmation primitive: focus trap, Esc closes, backdrop click closes.
 * Enter/Ctrl+Enter submission lives in `useSubmitOnEnter`, applied to the fields
 * themselves so a single-line input submits on Enter while a textarea needs Ctrl+Enter.
 */
export function Modal({
  open,
  title,
  onClose,
  onSubmit,
  submitDisabled = false,
  submitLabel = 'Confirm',
  cancelLabel = 'Cancel',
  children,
  hint,
  initialFocus,
  submitTone = 'primary',
  returnFocusRef,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const submitRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const initialFocusRef = initialFocus === 'submit'
    ? submitRef
    : initialFocus === 'cancel'
      ? cancelRef
      : undefined

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return

      // focus trap
      const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      if (nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    },
    [onClose],
  )

  if (!open) return null

  return (
    <div
      className="ui-modal-backdrop"
      onClick={(event) => requestModalCloseFromBackdrop(event, onClose)}
    >
      <ModalFocusLifecycle
        panelRef={panelRef}
        initialFocusRef={initialFocusRef}
        returnFocusRef={returnFocusRef}
      />
      <div
        className="ui-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panelRef}
        onKeyDown={handleKeyDown}
      >
        <h3 className="ui-modal-title">{title}</h3>
        <div className="ui-modal-body">{children}</div>
        <p className="ui-modal-hint">{hint ?? 'Enter to confirm, Esc to cancel'}</p>
        <div className="ui-modal-actions">
          {onSubmit && (
            <button
              type="button"
              className={`ui-btn ${submitTone === 'danger' ? 'ui-btn-danger' : 'ui-btn-primary'}`}
              onClick={onSubmit}
              disabled={submitDisabled}
              ref={submitRef}
            >
              {submitLabel}
            </button>
          )}
          <button type="button" className="ui-btn" onClick={onClose} ref={cancelRef}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
