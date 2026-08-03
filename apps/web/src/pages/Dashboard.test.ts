import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { query } from '../lib/api'
import { useBoardRealtime } from '../lib/useBoardRealtime'
import { Dashboard } from './Dashboard'

vi.mock('../lib/api', () => ({ query: vi.fn() }))
vi.mock('../lib/useBoardRealtime', () => ({ useBoardRealtime: vi.fn() }))

describe('Dashboard realtime refresh', () => {
  beforeEach(() => {
    vi.mocked(query).mockReset()
    vi.mocked(useBoardRealtime).mockReset()
  })

  it('reloads the dashboard summary when the board publishes an eligibility event', () => {
    let refreshFromBoard: (() => void) | undefined
    vi.mocked(query).mockResolvedValue({
      periodKey: '2026-08',
      totals: {
        assignmentsMtd: 0,
        reassignmentsMtd: 0,
        deactivationsMtd: 0,
        salesMtd: 0,
      },
      upsPerRep: [],
      cycleProgress: { served: 0, totalReps: 3 },
      disqualifiedCount: 0,
      overrideCount: 0,
    })
    vi.mocked(useBoardRealtime).mockImplementation((refresh) => {
      refreshFromBoard = refresh
    })

    renderToStaticMarkup(createElement(Dashboard))
    expect(refreshFromBoard).toBeTypeOf('function')

    refreshFromBoard?.()

    expect(query).toHaveBeenCalledOnce()
    expect(query).toHaveBeenCalledWith('board.dashboardSummary')
  })
})
