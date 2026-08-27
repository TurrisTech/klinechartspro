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

  test('forgetAfter drops the rows a stale clock could not have answered, and their coverage', () => {
    const s = new Mtf01Store('k')
    s.ingest([event({ date: 1000 }), event({ date: 4000, barDate: 9 })], { from: 0, to: 5000 }, { trades: [trade({ date: 2000 }), trade({ date: 4500, barDate: 9 })] })
    s.forgetAfter(3000)
    expect([...s.events.keys()]).toEqual([1000])
    expect([...s.trades.keys()]).toEqual([2000])
    expect(s.missing({ from: 0, to: 5000 })).toEqual([{ from: 3000, to: 5000 }])
  })

  test('a forgotten row comes BACK on the refetch -- its dedup key went with it', () => {
    // The trap this method exists around: `seen` is keyed by the row's own candle, not by
    // the bar it draws on. Leave the key behind and the refetch is deduplicated away, so
    // the row is gone from the chart for good -- worse than the hole being fixed.
    const s = new Mtf01Store('k')
    s.ingest([event({ date: 4000, barDate: 9 })], { from: 0, to: 5000 }, { trades: [trade({ date: 4500, barDate: 9 })] })
    s.forgetAfter(3000)
    s.ingest([event({ date: 4000, barDate: 9 })], { from: 3000, to: 5000 }, { trades: [trade({ date: 4500, barDate: 9 })] })
    expect(s.events.get(4000)).toHaveLength(1)
    expect(s.trades.get(4500)).toHaveLength(1)
    expect(s.missing({ from: 0, to: 5000 })).toEqual([])
  })

  test('forgetAfter keeps a row on a bar that had closed, and every earlier window', () => {
    const s = new Mtf01Store('k')
    s.ingest([event({ date: 1000 })], { from: 0, to: 2000 })
    s.ingest([event({ date: 2500, barDate: 7 })], { from: 2000, to: 5000 })
    const before = s.rev
    s.forgetAfter(2400)
    expect([...s.events.keys()]).toEqual([1000])
    expect(s.missing({ from: 0, to: 2400 })).toEqual([])
    expect(s.rev).toBeGreaterThan(before)
  })

  test('rev bumps on every change, so the template redraws', () => {
    const s = new Mtf01Store('k')
    const before = s.rev
    s.ingest([event()], { from: 0, to: 5000 }, { trades: [trade()] })
    expect(s.rev).toBeGreaterThan(before)
  })
})
