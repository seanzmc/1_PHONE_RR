import { describe, expect, it } from 'vitest'
import { mutationErrorMessage } from './mutationError'

describe('mutationErrorMessage', () => {
  it('translates connection failures into a retryable action', () => {
    expect(mutationErrorMessage(new Error('Failed to fetch'), 'The assignment could not be completed.')).toBe(
      'Connection lost. Check your network and try again.',
    )
  })

  it('translates known assignment conflicts', () => {
    expect(mutationErrorMessage(new Error('assignment changed; refresh and try again'), 'Skip failed.')).toBe(
      'This lead was already changed. Refresh the roster before trying again.',
    )
    expect(mutationErrorMessage(new Error('void window has closed for this business day'), 'Void failed.')).toBe(
      'This assignment can no longer be voided. Ask a Manager or Admin for help.',
    )
  })

  it('does not expose validation JSON or unknown server internals', () => {
    const fallback = 'The assignment could not be completed. Try again.'
    expect(mutationErrorMessage(new Error('[{"code":"too_small","path":["reasonNote"]}]'), fallback)).toBe(fallback)
    expect(mutationErrorMessage(new Error('source rep counter is missing'), fallback)).toBe(fallback)
  })
})
