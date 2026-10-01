import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'
import { FX_DAY } from '../replay/timeframes'

// client/config.ts reads `window` at module load and this module reaches it through the bar
// fetch; installed before the dynamic import, which a static one would be hoisted above.
installWindow()
const { BarStore, closedBy, pickSource, wireShift } = await import('./source')

// Which bars a profile is built from, and the store that holds them.

const OANDA = ['5s', '1m', '1h', '1D', '1M']
const COINBASE = ['1m', '1h', '1D', '1M']
const SCHWAB = ['1m', '30m', '1D']

describe('picking the source', () => {
  test('about a tenth of the chart interval at 40 rows, from what the vendor stores', () => {
    const picks = Object.fromEntries(['1m', '5m', '15m', '1h', '4h', '1D', '1W', '1M'].map((c) => [c, pickSource(c, OANDA, 'visible', 40)]))
    expect(picks).toEqual({ '1m': null, '5m': '1m', '15m': '1m', '1h': '1m', '4h': '1m', '1D': '1h', '1W': '1h', '1M': '1D' })
  })

  test('never 5s, and never a stored interval the vendor does not keep', () => {
    expect(pickSource('1m', OANDA, 'visible', 200)).toBeNull()
    expect(pickSource('1D', SCHWAB, 'visible', 40)).toBe('30m')
    expect(pickSource('1h', SCHWAB, 'visible', 40)).toBe('1m')
    expect(pickSource('1D', COINBASE, 'visible', 40)).toBe('1h')
  })

  test('one profile per session wants the finest intraday base whatever the chart', () => {
    expect(pickSource('1h', OANDA, 'session', 40)).toBe('1m')
    expect(pickSource('1D', SCHWAB, 'session', 40)).toBe('1m')
  })

  test("coarse enough rows make the chart's own bars the source", () => {
    expect(pickSource('1D', OANDA, 'visible', 10)).toBeNull()
  })

  test('a pinned interval is honoured only if stored and no coarser than the chart', () => {
    expect(pickSource('4h', OANDA, 'visible', 40, '1h')).toBe('1h')
    expect(pickSource('1h', OANDA, 'visible', 40, '1D')).toBe('1m')
    expect(pickSource('4h', OANDA, 'visible', 40, '30m')).toBe('1m')
  })
})

describe('wire dates', () => {
  test('only a session-dated interval is shifted, and only with a schedule', () => {
    const fx = { timezone: 'America/New_York', day: FX_DAY }
    expect(wireShift('1h', null)).toBe(0)
    expect(wireShift('1D', fx)).toBe(7 * 3_600_000)
    expect(wireShift('1D', null)).toBeNull()
  })
})

describe('the replay clamp', () => {
  const fx = { timezone: 'America/New_York', day: FX_DAY }
  test('an intraday bar is in once it has closed', () => {
    expect(closedBy('1m', 0, 60_000, null)).toBe(true)
    expect(closedBy('1m', 0, 59_999, null)).toBe(false)
  })

  test("a daily bar is in once the session forming at the clock is a later one", () => {
    // Wednesday 2026-09-16 12:00 New York (16:00Z): Wednesday's session is forming, Tuesday's
    // has closed. Wire dates are the sessions' New York midnights.
    const clock = Date.UTC(2026, 8, 16, 16)
    const tuesday = Date.UTC(2026, 8, 15, 4)
    const wednesday = Date.UTC(2026, 8, 16, 4)
    expect(closedBy('1D', tuesday, clock, fx)).toBe(true)
    expect(closedBy('1D', wednesday, clock, fx)).toBe(false)
    expect(closedBy('1D', tuesday, clock, null)).toBe(false)
  })
})

function bar(date: number, volume = 1) {
  return { date, open: 1, high: 1, low: 1, close: 1, volume }
}

describe('the bar store', () => {
  test('keeps bars ascending and unique whatever order the pages arrive in', () => {
    const s = new BarStore('k')
    s.ingest([bar(30), bar(40)], { from: 30, to: 50 })
    s.ingest([bar(10), bar(20)], { from: 10, to: 30 })
    s.ingest([bar(25), bar(20, 9)], { from: 20, to: 26 })
    expect(s.bars.map((b) => b.date)).toEqual([10, 20, 25, 30, 40])
    expect(s.bars[1].volume).toBe(9)
    expect(s.missing({ from: 0, to: 60 })).toEqual([
      { from: 0, to: 10 },
      { from: 50, to: 60 }
    ])
  })

  test('a live bar replaces the one at its date', () => {
    const s = new BarStore('k')
    s.ingest([bar(10), bar(20)], { from: 0, to: 30 })
    s.set(bar(20, 5))
    s.set(bar(30, 1))
    expect(s.bars.map((b) => [b.date, b.volume])).toEqual([
      [10, 1],
      [20, 5],
      [30, 1]
    ])
  })

  test('says the earliest date changed since a revision, and everything when it cannot tell', () => {
    const s = new BarStore('k')
    expect(s.changedSince(-1)).toBe(Number.NEGATIVE_INFINITY)
    s.ingest([bar(10), bar(20)], { from: 0, to: 30 })
    const rev = s.rev
    expect(s.changedSince(rev)).toBeNull()
    s.set(bar(20, 2))
    s.set(bar(30, 2))
    expect(s.changedSince(rev)).toBe(20)
    s.setPhase('ready')
    expect(s.changedSince(s.rev)).toBeNull()
    for (let i = 0; i < 300; i++) s.set(bar(40 + i))
    expect(s.changedSince(rev)).toBe(Number.NEGATIVE_INFINITY)
  })

  test('forgetting after a date drops its bars and its coverage', () => {
    const s = new BarStore('k')
    s.ingest([bar(10), bar(20), bar(30)], { from: 0, to: 40 })
    const rev = s.rev
    s.forgetAfter(20)
    expect(s.bars.map((b) => b.date)).toEqual([10])
    expect(s.missing({ from: 0, to: 40 })).toEqual([{ from: 20, to: 40 }])
    expect(s.changedSince(rev)).toBe(20)
  })
})
