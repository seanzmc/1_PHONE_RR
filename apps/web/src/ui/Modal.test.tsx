import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Modal } from './Modal'

describe('Modal', () => {
  it('renders a danger submit action and its safe cancel label', () => {
    const html = renderToStaticMarkup(
      <Modal
        open
        title="Discard unsaved changes?"
        onClose={() => {}}
        onSubmit={() => {}}
        submitLabel="Discard changes"
        submitTone="danger"
        cancelLabel="Keep editing"
      >
        <p>Closing will clear the information you entered.</p>
      </Modal>,
    )

    expect(html).toContain('ui-btn-danger')
    expect(html).toContain('Keep editing')
  })
})
