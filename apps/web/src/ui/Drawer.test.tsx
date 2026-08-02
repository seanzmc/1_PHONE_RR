import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { canCloseDrawer, Drawer } from './Drawer'

describe('Drawer', () => {
  it('renders one named modal drawer with one accessible X disabled while busy', () => {
    const html = renderToStaticMarkup(
      <Drawer open title="Assign lead" busy onClose={() => {}}>
        <p>Drawer body</p>
      </Drawer>,
    )

    expect(html.match(/role="dialog"/g)).toHaveLength(1)
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-label="Assign lead"')
    expect(html.match(/aria-label="Close Assign lead"/g)).toHaveLength(1)
    expect(html).toContain('>×</button>')
    expect(html).toContain('disabled=""')
  })

  it('allows close only while neither busy nor inactive', () => {
    expect(canCloseDrawer(false, false)).toBe(true)
    expect(canCloseDrawer(true, false)).toBe(false)
    expect(canCloseDrawer(false, true)).toBe(false)
  })
})
