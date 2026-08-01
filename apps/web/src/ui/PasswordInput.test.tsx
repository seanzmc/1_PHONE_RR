import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PasswordInput } from './PasswordInput'
import { passwordVisibilityLabel } from './passwordVisibility'

describe('PasswordInput', () => {
  it('starts masked with a field-specific accessible Show control', () => {
    const html = renderToStaticMarkup(
      createElement(PasswordInput, {
        label: 'Login password',
        value: 'secret-value',
        readOnly: true,
      }),
    )

    expect(html).toContain('type="password"')
    expect(html).toContain('aria-label="Login password"')
    expect(html).toContain('aria-label="Show Login password"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('>Show<')
  })

  it('describes both visibility states without ambiguous icon-only copy', () => {
    expect(passwordVisibilityLabel('New password', false)).toBe('Show New password')
    expect(passwordVisibilityLabel('New password', true)).toBe('Hide New password')
  })
})
