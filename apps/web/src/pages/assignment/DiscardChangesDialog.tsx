import { Modal } from '../../ui/Modal'

export function DiscardChangesDialog({ open, onKeepEditing, onDiscard, returnFocusRef }: {
  open: boolean
  onKeepEditing: () => void
  onDiscard: () => void
  returnFocusRef?: Readonly<{ current: HTMLElement | null }>
}) {
  return (
    <Modal
      open={open}
      title="Discard unsaved changes?"
      onClose={onKeepEditing}
      onSubmit={onDiscard}
      submitLabel="Discard changes"
      submitTone="danger"
      cancelLabel="Keep editing"
      initialFocus="cancel"
      hint="Keep editing preserves everything in this drawer."
      returnFocusRef={returnFocusRef}
    >
      <p>Closing will clear the information you entered.</p>
    </Modal>
  )
}
