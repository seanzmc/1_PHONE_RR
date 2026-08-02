import { useCallback, useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { Button } from './index'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export type DrawerProps = {
  open: boolean
  title: string
  busy?: boolean
  inactive?: boolean
  initialFocusRef?: Readonly<{ current: HTMLElement | null }>
  restoreFocusRef?: Readonly<{ current: HTMLElement | null }>
  onClose: () => void
  children: ReactNode
  overlays?: ReactNode
}

export function canCloseDrawer(busy: boolean, inactive: boolean): boolean {
  return !busy && !inactive
}

export function focusDrawerInitialElement(panel: HTMLElement | null, initialFocusTarget: HTMLElement | null): void {
  const target = initialFocusTarget ?? panel?.querySelector<HTMLElement>(FOCUSABLE)
  target?.focus()
}

export function restoreDrawerFocus(explicitTarget: HTMLElement | null, capturedTarget: HTMLElement | null): void {
  if (explicitTarget) {
    queueMicrotask(() => explicitTarget.focus())
    return
  }
  capturedTarget?.focus?.()
}

function currentFocusTarget(ref?: Readonly<{ current: HTMLElement | null }>): HTMLElement | null {
  return ref?.current ?? null
}

export function Drawer({
  open,
  title,
  busy = false,
  inactive = false,
  initialFocusRef,
  restoreFocusRef,
  onClose,
  children,
  overlays,
}: DrawerProps) {
  const panelRef = useRef<HTMLElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    previouslyFocused.current = document.activeElement as HTMLElement | null
    focusDrawerInitialElement(panelRef.current, initialFocusRef?.current ?? null)
    return () => restoreDrawerFocus(currentFocusTarget(restoreFocusRef), previouslyFocused.current)
  }, [open, initialFocusRef, restoreFocusRef])

  const requestClose = useCallback(() => {
    if (canCloseDrawer(busy, inactive)) onClose()
  }, [busy, inactive, onClose])

  const handleBackdropMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) requestClose()
    },
    [requestClose],
  )

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        requestClose()
        return
      }
      if (event.key !== 'Tab') return

      const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      if (nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    },
    [requestClose],
  )

  if (!open) return null

  return (
    <>
      <div className="ui-drawer-backdrop" onMouseDown={handleBackdropMouseDown}>
        <section
          className="ui-drawer"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          ref={panelRef}
          onKeyDown={handleKeyDown}
          inert={inactive}
        >
          <header className="ui-drawer-header">
            <h2>{title}</h2>
            <Button aria-label={`Close ${title}`} onClick={requestClose} disabled={busy || inactive}>
              ×
            </Button>
          </header>
          {children}
        </section>
      </div>
      {overlays}
    </>
  )
}
