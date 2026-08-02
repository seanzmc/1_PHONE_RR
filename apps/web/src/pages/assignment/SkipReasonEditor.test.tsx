import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { canConfirmSkip, SkipReasonEditor } from './SkipReasonEditor'

describe('SkipReasonEditor', () => {
  it('renders the Skip workflow inline without another dialog', () => {
    const html = renderToStaticMarkup(createElement(SkipReasonEditor, {
      repName: 'Raul Valle',
      preset: null,
      otherDetail: '',
      skipping: false,
      error: null,
      readOnly: false,
      onPresetChange: () => {},
      onOtherDetailChange: () => {},
      onCancel: () => {},
      onConfirm: () => {},
    }))

    expect(html).toContain('Skip Raul Valle')
    expect(html).toContain('Rep unavailable')
    expect(html).toContain('Manager-directed pass')
    expect(html).toContain('Skip rep and pass lead')
    expect(html).not.toContain('role="dialog"')
    expect(html).not.toContain('aria-modal="true"')
  })

  it('requires Other detail and blocks confirmation while busy or read-only', () => {
    expect(canConfirmSkip('Other', '', false, false)).toBe(false)
    expect(canConfirmSkip('Other', 'Rep is in training', false, false)).toBe(true)
    expect(canConfirmSkip('Rep unavailable', '', true, false)).toBe(false)
    expect(canConfirmSkip('Rep unavailable', '', false, true)).toBe(false)
  })
})
