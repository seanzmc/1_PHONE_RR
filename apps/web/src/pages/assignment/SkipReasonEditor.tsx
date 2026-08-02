import { Button, Field, Input } from '../../ui'
import { resolveSkipReason, SKIP_PRESETS, type SkipPreset } from './model'

export type SkipReasonEditorProps = {
  repName: string
  preset: SkipPreset | null
  otherDetail: string
  skipping: boolean
  error: string | null
  readOnly: boolean
  onPresetChange: (preset: SkipPreset) => void
  onOtherDetailChange: (detail: string) => void
  onCancel: () => void
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

export function SkipReasonEditor({
  repName,
  preset,
  otherDetail,
  skipping,
  error,
  readOnly,
  onPresetChange,
  onOtherDetailChange,
  onCancel,
  onConfirm,
}: SkipReasonEditorProps) {
  return (
    <section className="ui-skip-editor ui-stack" aria-labelledby="skip-editor-title">
      <div className="ui-skip-editor-head">
        <div>
          <p className="ui-eyebrow">Pass this lead</p>
          <h3 id="skip-editor-title">Skip {repName}</h3>
        </div>
        <Button size="sm" onClick={onCancel} disabled={skipping}>Cancel</Button>
      </div>
      <p>The same lead will pass to the next available rep. This rep stays served for the current round.</p>
      <div className="ui-skip-presets" role="group" aria-label="Skip reason">
        {SKIP_PRESETS.map((option) => (
          <Button
            key={option}
            className={option === preset ? 'ui-skip-preset-selected' : 'ui-skip-preset'}
            size="sm"
            aria-pressed={option === preset}
            disabled={skipping || readOnly}
            onClick={() => onPresetChange(option)}
          >
            {option}
          </Button>
        ))}
      </div>
      {preset === 'Other' && (
        <Field label="Other reason" error={error}>
          <Input
            value={otherDetail}
            onChange={(event) => onOtherDetailChange(event.target.value)}
            disabled={skipping || readOnly}
            placeholder="Describe the reason"
          />
        </Field>
      )}
      {preset !== 'Other' && error && <p className="ui-error" role="alert">{error}</p>}
      <Button
        variant="primary"
        onClick={() => {
          const reason = resolveSkipReason(preset, otherDetail)
          if (reason) onConfirm(reason)
        }}
        disabled={!canConfirmSkip(preset, otherDetail, skipping, readOnly)}
      >
        {skipping ? 'Skipping…' : 'Skip rep and pass lead'}
      </Button>
    </section>
  )
}
