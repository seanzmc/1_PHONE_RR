import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { canCloseDrawer, Drawer } from './Drawer'

describe('Drawer', () => {
  it('renders one named modal drawer and disables Close while busy', () => {
    const html = renderToStaticMarkup(
      <Drawer open title="Assign lead" busy onClose={() => {}}>
        <p>Drawer body</p>
      </Drawer>,
    )

    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-label="Assign lead"')
    expect(html).toContain('disabled=""')
  })

  it('allows close only while idle', () => {
    expect(canCloseDrawer(false)).toBe(true)
    expect(canCloseDrawer(true)).toBe(false)
  })
})
