import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { query } from '../lib/api'
import { useBoardRealtime } from '../lib/useBoardRealtime'
import { Dashboard } from './Dashboard'
import * as DashboardModule from './Dashboard'

vi.mock('../lib/api', () => ({ query: vi.fn() }))
vi.mock('../lib/useBoardRealtime', () => ({ useBoardRealtime: vi.fn() }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

type LoadLatest = <T>(input: {
  generation: { current: number }
  request: () => Promise<T>
  onSuccess: (value: T) => void
  onFailure: () => void
}) => Promise<void>

function loadLatest(): LoadLatest {
  const candidate = (DashboardModule as unknown as { loadLatestDashboard?: LoadLatest }).loadLatestDashboard
  expect(candidate).toBeTypeOf('function')
  return candidate!
}

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

describe('Dashboard latest request authority', () => {
  it('ignores an older success that resolves after the latest response', async () => {
    const run = loadLatest()
    const generation = { current: 0 }
    const older = deferred<string>()
    const newer = deferred<string>()
    let visible = 'baseline'

    const olderLoad = run({
      generation,
      request: () => older.promise,
      onSuccess: (value) => { visible = value },
      onFailure: () => {},
    })
    const newerLoad = run({
      generation,
      request: () => newer.promise,
      onSuccess: (value) => { visible = value },
      onFailure: () => {},
    })

    newer.resolve('newest summary')
    await newerLoad
    older.resolve('stale summary')
    await olderLoad

    expect(visible).toBe('newest summary')
  })

  it('ignores an older failure after a newer success', async () => {
    const run = loadLatest()
    const generation = { current: 0 }
    const older = deferred<string>()
    const newer = deferred<string>()
    let visible = 'baseline'
    let failed = false

    const olderLoad = run({
      generation,
      request: () => older.promise,
      onSuccess: (value) => { visible = value },
      onFailure: () => { failed = true },
    })
    const newerLoad = run({
      generation,
      request: () => newer.promise,
      onSuccess: (value) => { visible = value },
      onFailure: () => { failed = true },
    })

    newer.resolve('newest summary')
    await newerLoad
    older.reject(new Error('stale failure'))
    await olderLoad

    expect(visible).toBe('newest summary')
    expect(failed).toBe(false)
  })

  it('preserves the last summary on the latest failure and clears the warning after Retry', async () => {
    const run = loadLatest()
    const generation = { current: 0 }
    const failure = deferred<string>()
    const retry = deferred<string>()
    let visible = 'last good summary'
    let failed = false

    const failedLoad = run({
      generation,
      request: () => failure.promise,
      onSuccess: (value) => { visible = value; failed = false },
      onFailure: () => { failed = true },
    })
    failure.reject(new Error('latest failure'))
    await failedLoad

    expect(visible).toBe('last good summary')
    expect(failed).toBe(true)

    const retryLoad = run({
      generation,
      request: () => retry.promise,
      onSuccess: (value) => { visible = value; failed = false },
      onFailure: () => { failed = true },
    })
    retry.resolve('retried summary')
    await retryLoad

    expect(visible).toBe('retried summary')
    expect(failed).toBe(false)
  })
})

describe('Dashboard stale-data alert', () => {
  it('offers Retry without replacing the existing dashboard content', () => {
    const Alert = (DashboardModule as unknown as {
      DashboardLoadAlert?: (props: { onRetry: () => void }) => ReturnType<typeof createElement>
    }).DashboardLoadAlert
    expect(Alert).toBeTypeOf('function')

    const markup = renderToStaticMarkup(createElement(Alert!, { onRetry: () => {} }))
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Showing the last dashboard update')
    expect(markup).toContain('>Retry</button>')
  })
})
