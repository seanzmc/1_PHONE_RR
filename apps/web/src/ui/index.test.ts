import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Card, Table } from './index'

describe('Card', () => {
  it('passes live-region semantics to the rendered container', () => {
    const html = renderToStaticMarkup(
      createElement(Card, { role: 'status', 'aria-live': 'polite' }, 'Assignment complete'),
    )

    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
  })
})

describe('Table', () => {
  it('renders metadata header sort state alongside plain headers', () => {
    const html = renderToStaticMarkup(
      createElement(Table, {
        headers: [
          {
            content: createElement('button', { 'aria-label': 'Sort by Name' }, 'Name ↑'),
            ariaSort: 'ascending',
          },
          'Actions',
        ],
        children: createElement('tr', null, createElement('td', null, 'Taylor')),
      }),
    )

    expect(html).toContain('<th aria-sort="ascending">')
    expect(html).toContain('aria-label="Sort by Name"')
    expect(html).toContain('<th>Actions</th>')
  })
})
