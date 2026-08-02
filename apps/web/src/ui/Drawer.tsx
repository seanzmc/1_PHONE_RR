import { useCallback, useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { Button } from './index'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export type DrawerProps = {
  open: boolean
  title: string
  busy?: boolean
  inactive?: boolean
  initialFocusRef?: Readonly<{ current: HTMLElement | null }>
  onClose: () => void
  children: ReactNode
  overlays?: ReactNode
}

export function canCloseDrawer(busy: boolean, inactive: boolean): boolean {
  return !busy && !inactive
}

export function requestDrawerCloseFromBackdrop(
  event: Pick<ReactMouseEvent<HTMLDivElement>, 'type' | 'target' | 'currentTarget'>,
  requestClose: () => void,
): void {
  if (event.type === 'click' && event.target === event.currentTarget) requestClose()
}

export function focusDrawerInitialElement(panel: HTMLElement | null, initialFocusTarget: HTMLElement | null): void {
  const target = initialFocusTarget ?? panel?.querySelector<HTMLElement>(FOCUSABLE)
  target?.focus()
}

export function restoreDrawerFocus(
  panelRef: Readonly<{ current: HTMLElement | null }>,
  capturedTarget: HTMLElement | null,
): void {
  if (panelRef.current) return
  capturedTarget?.focus?.()
}

export type DrawerFocusLifecycleProps = {
  open: boolean
  panelRef: Readonly<{ current: HTMLElement | null }>
  initialFocusRef?: Readonly<{ current: HTMLElement | null }>
}

export function DrawerFocusLifecycle({ open, panelRef, initialFocusRef }: DrawerFocusLifecycleProps) {
  const previouslyFocused = useRef<HTMLElement | null>(null)
  const focusCaptured = useRef(false)

  useEffect(() => {
    if (!open) return
    if (!focusCaptured.current) {
      previouslyFocused.current = document.activeElement as HTMLElement | null
      focusCaptured.current = true
    }
    focusDrawerInitialElement(panelRef.current, initialFocusRef?.current ?? null)
    return () => restoreDrawerFocus(panelRef, previouslyFocused.current)
  }, [open, panelRef, initialFocusRef])

  return null
}

export function Drawer({
  open,
  title,
  busy = false,
  inactive = false,
  initialFocusRef,
  onClose,
  children,
  overlays,
}: DrawerProps) {
  const panelRef = useRef<HTMLElement>(null)

  const requestClose = useCallback(() => {
    if (canCloseDrawer(busy, inactive)) onClose()
  }, [busy, inactive, onClose])

  const handleBackdropClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => requestDrawerCloseFromBackdrop(event, requestClose),
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
      <DrawerFocusLifecycle open={open} panelRef={panelRef} initialFocusRef={initialFocusRef} />
      <div className="ui-drawer-backdrop" onClick={handleBackdropClick}>
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
