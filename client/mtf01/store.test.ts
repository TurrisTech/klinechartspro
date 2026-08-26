import { describe, expect, test } from 'bun:test'
import type { Mtf01Event, Mtf01Trade } from './api'
import { Mtf01Store } from './store'

// One response carries two kinds of row, so one ingest has to place both. The identity
// rules are the interesting part: a row is placed on the bar it became ACTIONABLE on, so
// several arrows land on one bar of a coarse chart, and the server caps the two arrays
// independently -- a page boundary drawn by one overlaps the other and hands rows back
// twice. Identity is therefore the row's OWN candle, never the bar it draws on.

const event = (over: Partial<Mtf01Event> = {}): Mtf01Event =>
  ({ date: 1000, stage: 'htf', interval: '8h', barDate: 1, effective: 1000, p: 0.3, n: 200, bodyLow: 1, accepted: true, reason: null, expiresAt: null, endedAt: null, endReason: null, ...over }) as Mtf01Event

const trade = (over: Partial<Mtf01Trade> = {}): Mtf01Trade =>
  ({ date: 2000, triggeredAt: 2000, ltfInterval: '5m', barDate: 2, outcome: 'target', ...over }) as Mtf01Trade

describe('Mtf01Store', () => {
  test('one ingest places both kinds off one response', () => {
    const s = new Mtf01Store('k')
    s.ingest([event()], { from: 0, to: 5000 }, { trades: [trade()] })
    expect(s.events.get(1000)).toHaveLength(1)
    expect(s.trades.get(2000)).toHaveLength(1)
    expect(s.size).toBe(2)
  })

  test('a response with no trades array is a window with no trades, not a crash', () => {
    const s = new Mtf01Store('k')
    s.ingest([event()], { from: 0, to: 5000 })
    expect(s.events.get(1000)).toHaveLength(1)
    expect(s.trades.size).toBe(0)
  })

  test('a window with only trades still records its coverage', () => {
    // Otherwise the host would keep re-requesting a window it has already read: the gap
    // is closed by the fetch, not by whether `points` happened to be empty.
    const s = new Mtf01Store('k')
    s.ingest([], { from: 0, to: 5000 }, { trades: [trade()] })
    expect(s.trades.get(2000)).toHaveLength(1)
    expect(s.missing({ from: 0, to: 5000 })).toEqual([])
  })

  test('a row handed back by an overlapping page is not duplicated', () => {
    const s = new Mtf01Store('k')
    s.ingest([event()], { from: 0, to: 3000 }, { trades: [trade()] })
    s.ingest([event()], { from: 2000, to: 5000 }, { trades: [trade()] })
    expect(s.events.get(1000)).toHaveLength(1)
    expect(s.trades.get(2000)).toHaveLength(1)
  })

  test('two arrows from different timeframes share one bar of a coarse chart', () => {
    // Identity is the row's own candle, so these are two rows, not one seen twice.
    const s = new Mtf01Store('k')
    s.ingest(
      [event({ interval: '8h', barDate: 1 }), event({ interval: '15m', stage: 'mtf', barDate: 2 })],
      { from: 0, to: 5000 }
    )
    expect(s.events.get(1000)).toHaveLength(2)
  })

  test('coverage merges so panning never refetches a window it holds', () => {
    const s = new Mtf01Store('k')
    s.ingest([], { from: 0, to: 1000 })
    s.ingest([], { from: 1000, to: 2000 })
    expect(s.missing({ from: 0, to: 2000 })).toEqual([])
    expect(s.missing({ from: 0, to: 3000 })).toEqual([{ from: 2000, to: 3000 }])
  })

  test('rev bumps on every change, so the template redraws', () => {
    const s = new Mtf01Store('k')
    const before = s.rev
    s.ingest([event()], { from: 0, to: 5000 }, { trades: [trade()] })
    expect(s.rev).toBeGreaterThan(before)
  })
})
