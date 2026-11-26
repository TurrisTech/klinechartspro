import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

installWindow()
const { chartBarAt, chartOpens } = await import('./shift')
const { CONTINUOUS_DAY, FX_GRID, gridOf } = await import('../replay/timeframes')
import type { KLineData } from 'klinecharts'

// The chart's half of placing a signal: which of the pane's own bars was open at the instant the
// signal became knowable. The instant is the server's (`GET /mtf/graph`: the source candle's
// close); the case that surfaced the live-edge rule (user, 2026-10-01, prod EURUSD): a 2h short
// cast on the 03:00 New York bar (07:00Z), shown by the rank sub-pane, never reached the overlay.

const M = 60_000
const H = 60 * M
const at = (iso: string) => Date.parse(iso)
const bars = (opens: number[]): KLineData[] =>
  opens.map((timestamp) => ({ timestamp, open: 1, high: 1, low: 1, close: 1 }))
const hourly = (from: number, count: number) => Array.from({ length: count }, (_, k) => from + k * H)

describe('chartBarAt', () => {
  const chart = hourly(at('2026-10-01T05:00Z'), 5) // 05:00Z .. 09:00Z, the last one forming

  test('the bar in force at the instant, including the forming last one', () => {
    expect(chartBarAt(at('2026-10-01T09:00Z'), chart, '1h')).toBe(4)
    expect(chartBarAt(at('2026-10-01T07:30Z'), chart, '1h')).toBe(2)
  })

  test('nothing after the last bar has closed, nor before the first opened', () => {
    expect(chartBarAt(at('2026-10-01T10:00:01Z'), chart, '1h')).toBe(-1)
    expect(chartBarAt(at('2026-10-01T11:00Z'), chart, '1h')).toBe(-1)
    expect(chartBarAt(at('2026-10-01T04:00Z'), chart, '1h')).toBe(-1)
  })

  test("the last bar's own close goes to the slot the next bar will take", () => {
    // A replay standing on 10:00Z: the 09:00Z bar has closed and the 10:00Z one has not printed.
    expect(chartBarAt(at('2026-10-01T10:00Z'), chart, '1h')).toBe(5)
  })

  test('an instant in a gap goes to the next bar to open, never the one that closed before it', () => {
    const gapped = [at('2026-10-01T05:00Z'), at('2026-10-01T06:00Z'), at('2026-10-01T08:00Z')]
    expect(chartBarAt(at('2026-10-01T07:00Z'), gapped, '1h')).toBe(2)
  })

  test("a close into the weekend lands on Sunday's first bar, and in the slot it will take until it opens", () => {
    // Friday 2026-10-02 closes 17:00 New York (21:00Z); the week reopens Sunday 21:00Z.
    const friday = [at('2026-10-02T19:00Z'), at('2026-10-02T20:00Z')]
    expect(chartBarAt(at('2026-10-02T21:00Z'), friday, '1h')).toBe(2)
    expect(chartBarAt(at('2026-10-02T21:00Z'), [...friday, at('2026-10-04T21:00Z')], '1h')).toBe(2)
  })
})

describe('a signal at its close, on the chart', () => {
  // The 2h bar that opened 07:00Z closed at 09:00Z: that is when its short became knowable.
  const knownAt = at('2026-10-01T09:00Z')

  test('the 2h 03:00 New York short draws on the 1h bar that opened at its close', () => {
    const chart = hourly(at('2026-10-01T05:00Z'), 5)
    expect(chartBarAt(knownAt, chartOpens('1h', bars(chart), FX_GRID), '1h')).toBe(4)
  })

  test('and in the slot after the last bar while the chart ends at that close', () => {
    const chart = hourly(at('2026-10-01T05:00Z'), 4) // through the 08:00Z bar, closing 09:00Z
    expect(chartBarAt(knownAt, chartOpens('1h', bars(chart), FX_GRID), '1h')).toBe(4)
    // ...and on nothing while it ends before it.
    expect(chartBarAt(knownAt, chartOpens('1h', bars(hourly(at('2026-10-01T05:00Z'), 3)), FX_GRID), '1h')).toBe(-1)
  })

  test('on its own timeframe, one bar forward, onto the forming bar', () => {
    const chart = [at('2026-10-01T03:00Z'), at('2026-10-01T05:00Z'), at('2026-10-01T07:00Z'), at('2026-10-01T09:00Z')]
    expect(chartBarAt(knownAt, chartOpens('2h', bars(chart), FX_GRID), '2h')).toBe(3)
  })
})

describe("on the pane's own schedule", () => {
  const crypto = gridOf({ timezone: 'UTC', day: CONTINUOUS_DAY })
  const days = (from: string, count: number): number[] => Array.from({ length: count }, (_, k) => at(from) + k * 24 * H)

  test('a coinbase daily signal draws on the hourly bar at the next UTC midnight, when it became knowable', () => {
    // The prod case (BTCUSD arev21, 2026-08-28): cast on the day dated 08-28, knowable at its
    // close, 08-29 00:00 UTC. On the forex 7h it drew on 08-28 17:00 -- seven hours before the
    // vote existed.
    const knownAt = crypto.end('1D', crypto.fromWire('1D', at('2026-08-28T00:00Z')))
    expect(knownAt).toBe(at('2026-08-29T00:00Z'))
    const chart = hourly(at('2026-08-28T00:00Z'), 48)
    expect(chart[chartBarAt(knownAt, chartOpens('1h', bars(chart), crypto), '1h')]).toBe(at('2026-08-29T00:00Z'))
  })

  test('a daily signal on a daily chart lands on the next day, on either clock', () => {
    // The chart's wire dates are converted on the pane's own schedule before anything is
    // compared: dated by open on a continuous market (UTC midnight), by session on the FX week
    // (New York midnight, the 17:00 open + 7h).
    for (const [clock, first] of [
      [crypto, '2026-08-27T00:00Z'],
      [FX_GRID, '2026-08-27T04:00Z']
    ] as const) {
      const chart = days(first, 4)
      const knownAt = clock.end('1D', clock.fromWire('1D', chart[1]))
      expect(chart[chartBarAt(knownAt, chartOpens('1D', bars(chart), clock), '1D')]).toBe(chart[2])
    }
  })
})
