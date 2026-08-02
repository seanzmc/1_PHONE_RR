import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DiscardChangesDialog } from './DiscardChangesDialog'

describe('DiscardChangesDialog', () => {
  it('warns before discarding an active drawer draft', () => {
    const html = renderToStaticMarkup(
      <DiscardChangesDialog open onKeepEditing={() => {}} onDiscard={() => {}} />,
    )

    expect(html).toContain('Discard unsaved changes?')
    expect(html).toContain('Closing will clear the information you entered.')
    expect(html).toContain('Keep editing')
    expect(html).toContain('Discard changes')
  })
})
