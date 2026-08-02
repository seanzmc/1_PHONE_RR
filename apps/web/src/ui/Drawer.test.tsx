import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { canCloseDrawer, Drawer, focusDrawerInitialElement } from './Drawer'

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

  it('focuses an explicit initial target while preserving first-focus fallback', () => {
    const fallback = { focus: vi.fn() }
    const preferred = { focus: vi.fn() }
    const panel = { querySelector: vi.fn(() => fallback) }

    focusDrawerInitialElement(panel as unknown as HTMLElement, preferred as unknown as HTMLElement)
    expect(preferred.focus).toHaveBeenCalledOnce()
    expect(panel.querySelector).not.toHaveBeenCalled()

    focusDrawerInitialElement(panel as unknown as HTMLElement, null)
    expect(fallback.focus).toHaveBeenCalledOnce()
  })

  it('renders nested confirmations outside the inert drawer section', () => {
    const html = renderToStaticMarkup(
      <Drawer
        open
        title="Assign lead"
        inactive
        onClose={() => {}}
        overlays={<div role="dialog">Discard unsaved changes?</div>}
      >
        <p>Drawer body</p>
      </Drawer>,
    )

    expect(html).toContain('<section class="ui-drawer"')
    expect(html).toContain('inert=""')
    expect(html.indexOf('Discard unsaved changes?')).toBeGreaterThan(html.indexOf('</section>'))
  })
})
