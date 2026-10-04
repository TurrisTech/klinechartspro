import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

installWindow()
const { chartBarAt, knowableSignals, shiftSignals } = await import('./shift')
const { CONTINUOUS_DAY, FX_GRID, gridOf } = await import('../replay/timeframes')
import type { KLineData } from 'klinecharts'
import type { ArevPoint } from '../arev/api'

// The live edge of the shift. The grid is `/getbars`, which serves CLOSED bars only, so the
// bar after the newest vote -- the one forming -- is never in it. The case that surfaced it
// (user, 2026-10-01, prod EURUSD): a 2h short cast on the 03:00 New York bar (07:00Z), shown
// by the rank sub-pane, never reached the MTF overlay.

const M = 60_000
const H = 60 * M
const at = (iso: string) => Date.parse(iso)
const vote = (date: number, signal: 'long' | 'short' | null = 'short'): ArevPoint =>
  ({ date, p: signal === 'long' ? 0.6 : 0.41, n: 200, signal }) as unknown as ArevPoint
const bars = (opens: number[]): KLineData[] =>
  opens.map((timestamp) => ({ timestamp, open: 1, high: 1, low: 1, close: 1 }))
const hourly = (from: number, count: number) => Array.from({ length: count }, (_, k) => from + k * H)

describe('knowableSignals', () => {
  test('a vote with a successor in the grid is knowable at the successor\'s open', () => {
    const grid = [at('2026-10-01T05:00Z'), at('2026-10-01T07:00Z')]
    expect(knowableSignals('2h', [vote(grid[0])], grid, FX_GRID).map((s) => s.knownAt)).toEqual([grid[1]])
  })

  test('the newest vote, its successor still forming, is knowable at its own close', () => {
    const grid = [at('2026-10-01T05:00Z'), at('2026-10-01T07:00Z')]
    const [signal] = knowableSignals('2h', [vote(grid[1])], grid, FX_GRID)
    expect(signal.knownAt).toBe(at('2026-10-01T09:00Z'))
    expect(signal.up).toBe(false)
  })

  test('a daily vote is knowable at its session close, on the absolute clock', () => {
    // Wire date 2026-10-01 is the session that opened 17:00 New York on 09-30 (21:00Z).
    const wire = at('2026-10-01T04:00Z')
    expect(knowableSignals('1D', [vote(wire)], [wire], FX_GRID).map((s) => s.knownAt)).toEqual([at('2026-10-01T21:00Z')])
  })

  test('no grid, nothing placed', () => {
    expect(knowableSignals('2h', [vote(at('2026-10-01T07:00Z'))], [], FX_GRID)).toEqual([])
  })
})

describe('chartBarAt', () => {
  const chart = hourly(at('2026-10-01T05:00Z'), 5) // 05:00Z .. 09:00Z, the last one forming

  test('the bar in force at the instant, including the forming last one', () => {
    expect(chartBarAt(at('2026-10-01T09:00Z'), chart, '1h')).toBe(4)
    expect(chartBarAt(at('2026-10-01T07:30Z'), chart, '1h')).toBe(2)
  })

  test('nothing once the last bar has closed, nor before the first opened', () => {
    expect(chartBarAt(at('2026-10-01T10:00Z'), chart, '1h')).toBe(-1)
    expect(chartBarAt(at('2026-10-01T04:00Z'), chart, '1h')).toBe(-1)
  })

  test('an instant in a gap goes to the next bar to open, never the one that closed before it', () => {
    const gapped = [at('2026-10-01T05:00Z'), at('2026-10-01T06:00Z'), at('2026-10-01T08:00Z')]
    expect(chartBarAt(at('2026-10-01T07:00Z'), gapped, '1h')).toBe(2)
  })

  test("a close into the weekend lands on Sunday's first bar, and on nothing until it opens", () => {
    // Friday 2026-10-02 closes 17:00 New York (21:00Z); the week reopens Sunday 21:00Z.
    const friday = [at('2026-10-02T19:00Z'), at('2026-10-02T20:00Z')]
    expect(chartBarAt(at('2026-10-02T21:00Z'), friday, '1h')).toBe(-1)
    expect(chartBarAt(at('2026-10-02T21:00Z'), [...friday, at('2026-10-04T21:00Z')], '1h')).toBe(2)
  })
})

describe('shiftSignals at the live edge', () => {
  const grid = [at('2026-10-01T03:00Z'), at('2026-10-01T05:00Z'), at('2026-10-01T07:00Z')]
  const points = [vote(grid[1], null), vote(grid[2], 'short')]

  test('the 2h 03:00 New York short draws on the 1h bar that opened at its close', () => {
    const chartBars = bars(hourly(at('2026-10-01T05:00Z'), 5))
    const placed = shiftSignals({ clock: FX_GRID, sourceInterval: '2h', chartInterval: '1h', points, grid, chartBars })
    expect([...placed.keys()]).toEqual([at('2026-10-01T09:00Z')])
    expect(placed.get(at('2026-10-01T09:00Z'))?.map((s) => s.sourceDate)).toEqual([grid[2]])
  })

  test('and on nothing while the chart has no bar at or after that close', () => {
    const chartBars = bars(hourly(at('2026-10-01T05:00Z'), 4)) // through the 08:00Z bar
    expect(shiftSignals({ clock: FX_GRID, sourceInterval: '2h', chartInterval: '1h', points, grid, chartBars }).size).toBe(0)
  })

  test('on its own timeframe, one bar forward, onto the forming bar', () => {
    const chartBars = bars([...grid, at('2026-10-01T09:00Z')])
    const placed = shiftSignals({ clock: FX_GRID, sourceInterval: '2h', chartInterval: '2h', points, grid, chartBars })
    expect([...placed.keys()]).toEqual([at('2026-10-01T09:00Z')])
  })
})

describe('on the pane\'s own schedule', () => {
  const crypto = gridOf({ timezone: 'UTC', day: CONTINUOUS_DAY })
  const days = (from: string, count: number): number[] => Array.from({ length: count }, (_, k) => at(from) + k * 24 * H)

  test('a coinbase daily vote draws on the hourly bar at the next UTC midnight, when it became knowable', () => {
    // The prod case (BTCUSD arev21, 2026-08-28): cast on the day dated 08-28, knowable at its
    // close, 08-29 00:00 UTC. On the forex 7h it drew on 08-28 17:00 -- seven hours before the
    // vote existed.
    const grid = days('2026-08-27T00:00Z', 4)
    const chart = bars(hourly(at('2026-08-28T00:00Z'), 48))
    const placed = shiftSignals({ clock: crypto, sourceInterval: '1D', chartInterval: '1h', points: [vote(at('2026-08-28T00:00Z'))], grid, chartBars: chart })
    expect([...placed.keys()]).toEqual([at('2026-08-29T00:00Z')])
    // ...and the forex reading of the same rows is exactly the lookahead the prod chart showed.
    const fx = shiftSignals({ clock: FX_GRID, sourceInterval: '1D', chartInterval: '1h', points: [vote(at('2026-08-28T00:00Z'))], grid, chartBars: chart })
    expect([...fx.keys()]).toEqual([at('2026-08-28T17:00Z')])
  })

  test('a daily vote on a daily chart lands on the next day, on either clock', () => {
    // Both sides are session-dated, so a wrong offset shifts both alike and cancels: the defect
    // was confined to a daily vote on an INTRADAY chart. Pinned so a fix cannot break this one.
    const grid = days('2026-08-27T00:00Z', 4)
    const chart = bars(grid)
    for (const clock of [crypto, FX_GRID]) {
      const placed = shiftSignals({ clock, sourceInterval: '1D', chartInterval: '1D', points: [vote(at('2026-08-28T00:00Z'))], grid, chartBars: chart })
      expect([...placed.keys()]).toEqual([at('2026-08-29T00:00Z')])
    }
  })
})
