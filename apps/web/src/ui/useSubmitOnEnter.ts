import { useCallback } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

export type SubmitOnEnterOptions = {
  /**
   * 'single-line' (default): bare Enter submits (Ctrl+Enter also works).
   * 'multiline':  only Ctrl+Enter (or Cmd+Enter) submits, so Enter still inserts a newline.
   */
  mode?: 'single-line' | 'multiline'
  /** When true, Enter does nothing — e.g. a required field is still blank. */
  disabled?: boolean
}

/**
 * Keyboard submission for modal fields, matching the convention already used on
 * AssignScreen: single-line inputs submit on Enter, textareas on Ctrl+Enter.
 * Returns an onKeyDown handler; the modal itself owns Esc.
 */
export function useSubmitOnEnter(
  onSubmit: () => void,
  { mode = 'single-line', disabled = false }: SubmitOnEnterOptions = {},
) {
  return useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key !== 'Enter') return
      const withModifier = e.ctrlKey || e.metaKey
      if (mode === 'multiline' && !withModifier) return

      e.preventDefault()
      e.stopPropagation()
      if (!disabled) onSubmit()
    },
    [onSubmit, mode, disabled],
  )
}
