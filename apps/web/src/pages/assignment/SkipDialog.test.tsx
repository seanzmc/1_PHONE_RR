import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { canConfirmSkip, SkipDialog } from './SkipDialog'

describe('SkipDialog', () => {
  it('renders every static preset and requires Other detail before confirmation', () => {
    const html = renderToStaticMarkup(createElement(SkipDialog, {
      open: true,
      repName: 'Jamie Smith',
      skipping: false,
      error: null,
      readOnly: false,
      onClose: () => {},
      onConfirm: () => {},
    }))

    expect(html).toContain('Rep unavailable')
    expect(html).toContain('Rep already assisting a customer')
    expect(html).toContain('Customer requested another rep')
    expect(html).toContain('Manager-directed pass')
    expect(html).toContain('Other')
    expect(canConfirmSkip('Other', '', false, false)).toBe(false)
    expect(canConfirmSkip('Other', 'Rep is in training', false, false)).toBe(true)
    expect(canConfirmSkip('Rep unavailable', '', true, false)).toBe(false)
  })

  it('renders one disabled explicit confirmation control before a reason is selected', () => {
    const html = renderToStaticMarkup(createElement(SkipDialog, {
      open: true,
      repName: 'Jamie Smith',
      skipping: false,
      error: null,
      readOnly: false,
      onClose: () => {},
      onConfirm: () => {},
    }))

    expect(html).toContain('Skip Jamie Smith?')
    expect(html).toContain('Skip rep and pass lead')
    expect(html).toContain('disabled=""')
  })
})
