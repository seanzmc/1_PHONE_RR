import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { query } from '../lib/api'
import { useBoardRealtime } from '../lib/useBoardRealtime'
import { Dashboard, DashboardSummary } from './Dashboard'
import * as DashboardModule from './Dashboard'

vi.mock('../lib/api', () => ({ query: vi.fn() }))
vi.mock('../lib/useBoardRealtime', () => ({ useBoardRealtime: vi.fn() }))

const populatedSummary = {
  periodKey: '2026-08',
  totals: {
    assignmentsMtd: 12,
    reassignmentsMtd: 3,
    deactivationsMtd: 2,
    salesMtd: 4,
  },
  upsPerRep: [
    { repId: 'rep-taylor', repName: 'Taylor Morgan', ups: 5 },
    { repId: 'rep-alex', repName: 'Alex Kim', ups: 7 },
  ],
  cycleProgress: { served: 2, totalReps: 3 },
  disqualifiedCount: 1,
  overrideCount: 6,
}

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

describe('Dashboard metric definitions and rep drill-down', () => {
  it('keeps the metric values and order while showing every exact definition', () => {
    const markup = renderToStaticMarkup(createElement(DashboardSummary, { summary: populatedSummary }))
    const expectedInOrder = [
      ['Phone-ups assigned', '12', 'Phone-ups currently credited this month; voided assignments are removed.'],
      ['CRM sales', '4', 'Sum of the CRM Sold values imported for active reps this month.'],
      ['Reassignments', '3', 'Lead reassignments completed this month.'],
      ['Call-rule deactivations', '2', 'One per weekly call-rule suspension, not one per inactive day.'],
      ['Cycle progress', '2 / 3', 'Active reps served in the current rotation cycle; the cycle restarts after everyone is served.'],
      ['Ineligible today', '1', 'Active reps out of rotation today, for any reason.'],
      ['Overrides today', '6', 'Manager status changes recorded for today.'],
    ]

    let previousIndex = -1
    for (const [label, value, hint] of expectedInOrder) {
      const labelIndex = markup.indexOf(label)
      expect(labelIndex).toBeGreaterThan(previousIndex)
      expect(markup.indexOf(value, labelIndex)).toBeGreaterThan(labelIndex)
      expect(markup).toContain(hint)
      previousIndex = labelIndex
    }

    expect(markup.indexOf('Alex Kim')).toBeLessThan(markup.indexOf('Taylor Morgan'))
  })

  it('renders authorized rep names as specific native link buttons with visible arrows', () => {
    const markup = renderToStaticMarkup(
      createElement(DashboardSummary, { summary: populatedSummary, onOpenRep: () => {} }),
    )

    expect(markup).toContain('Select a rep name to view their leads, activity, and status for the month.')
    expect(markup).toContain('<button type="button" class="ui-linkbtn" aria-label="View Alex Kim&#x27;s rep details">')
    expect(markup).toContain('Alex Kim <span aria-hidden="true">→</span>')
    expect(markup).toContain('aria-label="View Taylor Morgan&#x27;s rep details"')
  })

  it('renders plain rep names without dead-end drill-down affordances when unauthorized', () => {
    const markup = renderToStaticMarkup(createElement(DashboardSummary, { summary: populatedSummary }))

    expect(markup).not.toContain('Select a rep name')
    expect(markup).not.toContain('<button')
    expect(markup).not.toContain('→')
    expect(markup).toContain('Alex Kim')
    expect(markup).toContain('Taylor Morgan')
  })
})
