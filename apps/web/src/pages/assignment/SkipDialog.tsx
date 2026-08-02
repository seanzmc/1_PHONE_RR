import { useEffect, useState } from 'react'
import { Button, Field, Input } from '../../ui'
import { Modal } from '../../ui/Modal'
import { resolveSkipReason, SKIP_PRESETS, type SkipPreset } from './model'

export type SkipDialogProps = {
  open: boolean
  repName: string
  skipping: boolean
  error: string | null
  readOnly: boolean
  onClose: () => void
  onConfirm: (reasonNote: string) => void
}

export function canConfirmSkip(
  preset: SkipPreset | null,
  otherDetail: string,
  skipping: boolean,
  readOnly: boolean,
): boolean {
  return !!resolveSkipReason(preset, otherDetail) && !skipping && !readOnly
}

export function SkipDialog({ open, repName, skipping, error, readOnly, onClose, onConfirm }: SkipDialogProps) {
  const [preset, setPreset] = useState<SkipPreset | null>(null)
  const [otherDetail, setOtherDetail] = useState('')

  useEffect(() => {
    setPreset(null)
    setOtherDetail('')
  }, [open, repName])

  function submit() {
    const reason = resolveSkipReason(preset, otherDetail)
    if (reason) onConfirm(reason)
  }

  return (
    <Modal
      open={open}
      title={`Skip ${repName}?`}
      onClose={onClose}
      onSubmit={submit}
      submitDisabled={!canConfirmSkip(preset, otherDetail, skipping, readOnly)}
      submitLabel={skipping ? 'Skipping…' : 'Skip rep and pass lead'}
      hint="Choose a reason, then click Skip rep and pass lead. Esc cancels."
    >
      <p>The same lead will pass to the next available rep. This rep stays served for the current round.</p>
      <div className="ui-skip-presets" role="group" aria-label="Skip reason">
        {SKIP_PRESETS.map((option) => (
          <Button
            key={option}
            className={option === preset ? 'ui-skip-preset-selected' : 'ui-skip-preset'}
            size="sm"
            aria-pressed={option === preset}
            disabled={skipping || readOnly}
            onClick={() => setPreset(option)}
          >
            {option}
          </Button>
        ))}
      </div>
      {preset === 'Other' && (
        <Field label="Other reason" error={error}>
          <Input
            value={otherDetail}
            onChange={(event) => setOtherDetail(event.target.value)}
            disabled={skipping || readOnly}
            placeholder="Describe the reason"
            autoFocus
          />
        </Field>
      )}
      {preset !== 'Other' && error && <p className="ui-error" role="alert">{error}</p>}
    </Modal>
  )
}
