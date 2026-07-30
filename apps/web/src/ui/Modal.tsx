import { useCallback, useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'

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
}

/**
 * The one modal in the app: focus trap, Esc closes, backdrop click closes.
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
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    previouslyFocused.current = document.activeElement as HTMLElement | null
    const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
    return () => previouslyFocused.current?.focus?.()
  }, [open])

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
    <div className="ui-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
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
            <button type="button" className="ui-btn ui-btn-primary" onClick={onSubmit} disabled={submitDisabled}>
              {submitLabel}
            </button>
          )}
          <button type="button" className="ui-btn" onClick={onClose}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
