import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Card } from './index'

describe('Card', () => {
  it('passes live-region semantics to the rendered container', () => {
    const html = renderToStaticMarkup(
      createElement(Card, { role: 'status', 'aria-live': 'polite' }, 'Assignment complete'),
    )

    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
  })
})