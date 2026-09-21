import { describe, expect, test } from 'bun:test'

import { mergeSessions, sessionsFromBars, type Candle, type Level, type SessionBar, type SessionClock } from './calendar'
import {
  computeTradeTalk,
  dedupeLevels,
  levelMap,
  inTradingWindow,
  nextTarget,
  pickLevel,
  signalAt,
  unitsFor,
  type Settings,
  type Trade
} from './rules'

const DAY = 86_400_000
const HOUR = 3_600_000
const TICK = 0.01

// Crypto geometry, so a session is a UTC day and a bar's timestamp reads as day + hour.
const CLOCK: SessionClock = { timezone: 'UTC', openOffset: 0, sessionDated: false }

const bar = (day: number, hour: number, open: number, high: number, low: number, close: number): Candle => ({
  timestamp: day * DAY + hour * HOUR,
  open,
  high,
  low,
  close
})

const session = (day: number, open: number, high: number, low: number, close: number): SessionBar => ({ day, open, high, low, close })

// Five sessions, ending in a day with a clean 90 / 110 range. Days 0-3 are one week (1970
// opened on a Thursday), day 4 opens the next one, which puts a known set of levels on day 5:
//   1970 open 50 (the year, quarter and month all opened there and fold onto one line)
//   last week high 99 / low 48 / mid 73.5
//   week open 100 (which is also the previous day's midpoint)
//   prev day high 110 / low 90
const BASE: SessionBar[] = [
  session(0, 50, 52, 48, 51),
  session(1, 51, 60, 50, 59),
  session(2, 59, 80, 58, 79),
  session(3, 79, 99, 78, 98),
  session(4, 100, 110, 90, 105)
]

const SETTINGS: Settings = { rr: 2, bias: 0, window: 0, expiry: 5, minUnit: 'D' }

function run(bars: Candle[], settings: Partial<Settings> = {}, fed: SessionBar[] = BASE) {
  return computeTradeTalk({
    bars,
    sessions: mergeSessions(fed, sessionsFromBars(bars, CLOCK)),
    clock: CLOCK,
    barMs: HOUR,
    tick: TICK,
    settings: { ...SETTINGS, ...settings }
  })
}

// Day 5, hourly. Bar 2 sweeps the previous day's low (90) and closes back above it; bar 3
// takes out bar 2's high, which is the entry; bar 4 reaches the next level above.
const STOP_RUN: Candle[] = [
  bar(5, 0, 103, 104, 102, 103),
  bar(5, 1, 103, 103.5, 95, 96),
  bar(5, 2, 91, 91.5, 89, 90.5),
  bar(5, 3, 90.6, 92, 90.2, 91.8),
  bar(5, 4, 91.8, 101, 91.5, 100.5)
]

describe('the stop-run reclaim', () => {
  const { trades, values } = run(STOP_RUN)

  test('one entry, on the break of the signal candle', () => {
    expect(trades).toHaveLength(1)
    const trade = trades[0] as Trade
    expect(trade.side).toBe('long')
    expect(trade.signalIndex).toBe(2)
    expect(trade.entryIndex).toBe(3)
    expect(trade.entry).toBe(91.5)
    expect(trade.stop).toBe(89)
    expect(trade.level.label).toBe('prev day low')
    expect(trade.level.price).toBe(90)
  })

  test('the target is the next opposing level, and the reward:risk is measured to it', () => {
    const trade = trades[0] as Trade
    expect(trade.target).toMatchObject({ price: 99, label: 'last week high', isLevel: true })
    expect(trade.rr).toBeCloseTo((99 - 91.5) / 2.5, 10)
    expect(trade.halfSize).toBe(false)
  })

  test('the outcome is read forwards', () => {
    expect((trades[0] as Trade).outcome).toBe('target')
    expect((trades[0] as Trade).exitIndex).toBe(4)
  })

  test('the trade is reachable from every bar it spans, and its prices are on the entry bars', () => {
    expect(values[1].trade).toBeUndefined()
    expect(values[2].trade).toBe(trades[0])
    expect(values[4].trade).toBe(trades[0])
    expect(values[2].entry).toBeUndefined()
    expect(values[3].entry).toBe(91.5)
    expect(values[3].stop).toBe(89)
  })

  test('the map is on every bar, and the period in progress does not open a level on its own first bar', () => {
    expect(values[0].levels?.some((level) => level.label === 'day open')).toBe(false)
    expect(values[1].levels?.some((level) => level.label === 'day open')).toBe(true)
    // One line per price: the week's open and the previous day's midpoint are both 100.
    expect(values[1].levels?.filter((level) => level.price === 100).map((level) => level.label)).toEqual(['week open'])
  })
})

describe('what stops a trade being taken', () => {
  test('a candle that opened BELOW the level is a breakout, not a reclaim', () => {
    const bars = [...STOP_RUN]
    bars[2] = bar(5, 2, 89, 91.5, 88, 90.5)
    expect(run(bars).trades).toHaveLength(0)
  })

  test('a reward that does not reach the minimum is not a trade', () => {
    expect(run(STOP_RUN, { rr: 4 }).trades).toHaveLength(0)
  })

  test('price going back to the lows cancels the order -- that was continuation, not a stop run', () => {
    const bars = [...STOP_RUN]
    bars[3] = bar(5, 3, 90.4, 91, 88.5, 89)
    expect(run(bars).trades).toHaveLength(0)
  })

  test('the order only works for so many bars', () => {
    const bars = [
      ...STOP_RUN.slice(0, 3),
      bar(5, 3, 90.6, 91, 90.2, 90.8),
      bar(5, 4, 90.8, 91.2, 90.5, 91),
      bar(5, 5, 91, 95, 90.9, 94)
    ]
    expect(run(bars, { expiry: 5 }).trades).toHaveLength(1)
    expect(run(bars, { expiry: 2 }).trades).toHaveLength(0)
  })

  test('a candle that swept levels on both sides says nothing about which was the stop run', () => {
    const bars = [...STOP_RUN]
    // Takes out 90 below and 99/100 above, and closes back under both -- an outside candle.
    bars[2] = bar(5, 2, 95, 101, 89, 90.5)
    expect(run(bars).trades).toHaveLength(0)
  })

  test('only one position at a time', () => {
    const bars = [
      ...STOP_RUN,
      // A second sweep of the same level while the first trade is still open would be a
      // second entry; the trade above is already closed by bar 4, so this one is taken.
      bar(5, 5, 91, 91.5, 89, 90.5),
      bar(5, 6, 90.6, 92, 90.2, 91.8)
    ]
    expect(run(bars).trades).toHaveLength(2)
  })
})

describe('the filters', () => {
  // 25 sessions of steady decline, so the daily 21 EMA sits above the last close and the
  // bias is down; the last one carries the 90/110 range the day-5 bars sweep.
  const falling: SessionBar[] = Array.from({ length: 24 }, (_, i) => {
    const price = 200 - i * 4
    return session(i, price, price + 2, price - 2, price - 1)
  }).concat([session(24, 100, 110, 90, 105)])
  // The same day-5 bars, moved onto day 25 so they follow those 25 sessions.
  const bars = STOP_RUN.map((candle) => ({ ...candle, timestamp: candle.timestamp + 20 * DAY }))

  test('the daily 21 EMA bias blocks a long in a downtrend, and switching it off allows it', () => {
    expect(run(bars, { bias: 1 }, falling).trades).toHaveLength(0)
    expect(run(bars, { bias: 0 }, falling).trades).toHaveLength(1)
  })

  test('the yearly open blocks a long below it', () => {
    // Every session here is in 1970 and the year opened at 200, far above the entry.
    expect(run(bars, { bias: 2 }, falling).trades).toHaveLength(0)
  })

  test('an entry outside his hours is not taken', () => {
    // The bars sit at 00:00-04:00 UTC, which is the previous evening in New York.
    expect(run(STOP_RUN, { window: 1 }).trades).toHaveLength(0)
    expect(run(STOP_RUN, { window: 0 }).trades).toHaveLength(1)
  })

  test('the hours are the trader\'s own New York clock, weekdays only', () => {
    // 1970-01-06 was a Tuesday. 13:00 UTC is 08:00 New York.
    expect(inTradingWindow(5 * DAY + 13 * HOUR, 1, HOUR)).toBe(true)
    expect(inTradingWindow(5 * DAY + 13 * HOUR, 2, HOUR)).toBe(true)
    // 09:00 UTC is 04:00 New York: inside London, outside the New York window.
    expect(inTradingWindow(5 * DAY + 9 * HOUR, 1, HOUR)).toBe(true)
    expect(inTradingWindow(5 * DAY + 9 * HOUR, 2, HOUR)).toBe(false)
    // 17:00 UTC is 12:00 New York -- after 11:00, so nothing is opened.
    expect(inTradingWindow(5 * DAY + 17 * HOUR, 1, HOUR)).toBe(false)
    // 1970-01-03 was a Saturday.
    expect(inTradingWindow(2 * DAY + 13 * HOUR, 1, HOUR)).toBe(false)
    // A chart coarser than an hour is a swing chart and is never gated.
    expect(inTradingWindow(5 * DAY + 17 * HOUR, 1, 4 * HOUR)).toBe(true)
  })
})

describe('no lookahead', () => {
  // Every trade the full run took must appear, identically, in a run over the bars up to its
  // own entry -- a signal decided from anything later than its own candle would not.
  const bars = [
    ...STOP_RUN,
    bar(5, 5, 100.5, 106, 100, 105),
    bar(5, 6, 105, 105.5, 98, 99.5),
    bar(5, 7, 99.5, 100.2, 97, 98),
    bar(5, 8, 98, 112, 97.8, 111),
    bar(5, 9, 111, 111.5, 108, 109),
    bar(5, 10, 109, 109.5, 104, 105),
    bar(5, 11, 105, 107, 89.5, 106)
  ]
  const full = run(bars)

  test('the full run takes at least one trade', () => {
    expect(full.trades.length).toBeGreaterThan(0)
  })

  test('every prefix agrees with it about the trades it can see', () => {
    for (let n = 1; n <= bars.length; n++) {
      const prefix = run(bars.slice(0, n))
      const visible = full.trades.filter((trade) => trade.entryIndex < n)
      expect(prefix.trades).toHaveLength(visible.length)
      prefix.trades.forEach((trade, i) => {
        const expected = visible[i]
        expect({
          side: trade.side,
          signalIndex: trade.signalIndex,
          entryIndex: trade.entryIndex,
          entry: trade.entry,
          stop: trade.stop,
          target: trade.target.price,
          level: trade.level.label
        }).toEqual({
          side: expected.side,
          signalIndex: expected.signalIndex,
          entryIndex: expected.entryIndex,
          entry: expected.entry,
          stop: expected.stop,
          target: expected.target.price,
          level: expected.level.label
        })
      })
    }
  })

  test('a trade still open at the last bar says so', () => {
    const upTo = run(bars.slice(0, 4))
    expect(upTo.trades[0]?.outcome).toBe('open')
    expect(upTo.trades[0]?.exitIndex).toBeNull()
  })
})

describe('a bar that reaches both', () => {
  test('a fill and a stop in the same candle is read as the stop', () => {
    const bars = [...STOP_RUN]
    bars[3] = bar(5, 3, 90.6, 92, 88.5, 89.5)
    const { trades } = run(bars)
    expect(trades).toHaveLength(1)
    expect(trades[0].outcome).toBe('stop')
    expect(trades[0].exitIndex).toBe(3)
  })

  test('a gap past the order fills at the open, not at the trigger', () => {
    const bars = [...STOP_RUN]
    bars[3] = bar(5, 3, 93, 94, 92.5, 93.5)
    expect(run(bars).trades[0].entry).toBe(93)
  })
})

// -- the pieces, in isolation --------------------------------------------------------------

const level = (price: number, unit: Level['unit'], kind: Level['kind'], label: string): Level => ({
  price,
  unit,
  kind,
  label,
  current: kind === 'open'
})

describe('picking the level', () => {
  test('the coarsest unit names the trade', () => {
    const picked = pickLevel([level(90, 'D', 'low', 'prev day low'), level(91, 'W', 'low', 'last week low')], 92.5)
    expect(picked?.label).toBe('last week low')
  })

  test('one price is one line, kept under the coarser unit', () => {
    const deduped = dedupeLevels([level(100, 'D', 'mid', 'prev day mid'), level(100, 'W', 'open', 'week open')], TICK)
    expect(deduped.map((l) => l.label)).toEqual(['week open'])
  })
})

describe('signalAt', () => {
  const levels = [level(100, 'W', 'open', 'week open'), level(91, 'W', 'low', 'last week low'), level(90, 'D', 'low', 'prev day low')]
  const ctx = {
    tick: TICK,
    half: TICK / 2,
    settings: { ...SETTINGS, rr: 1 },
    bias: null,
    yearOpen: null,
    dayHigh: 93,
    dayLow: 88,
    intraday: true
  }

  test('the coarser level names the trade, and the one left inside the candle halves the size', () => {
    // 92 -> 93, wicking to 89: it sweeps the previous day's low AND last week's, reclaims
    // both, and is named for the week. The daily line then sits between entry and stop.
    const { order } = signalAt(bar(5, 2, 92, 93, 89, 92.5), levels, ctx)
    expect(order?.level.label).toBe('last week low')
    expect(order?.halfSize).toBe(true)
    expect(order?.target).toMatchObject({ price: 100, label: 'week open' })
  })

  test('a sweep that is refused says which rule refused it', () => {
    const candle = bar(5, 2, 92, 93, 89, 92.5)
    expect(signalAt(candle, levels, { ...ctx, settings: { ...ctx.settings, rr: 5 } })).toEqual({ order: null, skip: 'rr' })
    expect(signalAt(candle, levels, { ...ctx, settings: { ...ctx.settings, bias: 1 }, bias: 'down' })).toEqual({
      order: null,
      skip: 'bias'
    })
    // A candle that swept nothing is not a refusal; there was no setup to refuse.
    expect(signalAt(bar(5, 2, 95, 96, 94, 95.5), levels, ctx)).toEqual({ order: null, skip: null })
  })

  test('the day high is a target when it is nearer than any level', () => {
    const target = nextTarget('long', 93, 1, levels, { ...ctx, dayHigh: 95 })
    expect(target).toEqual({ price: 95, label: 'day high', isLevel: true })
  })

  test('with nothing above, the minimum reward stands in and says so', () => {
    const target = nextTarget('long', 101, 2, [], { ...ctx, intraday: false })
    expect(target).toEqual({ price: 101 + 2 * ctx.settings.rr, label: 'no level', isLevel: false })
  })

  test('a zero-range candle cannot be traded', () => {
    expect(signalAt(bar(5, 2, 90.5, 90.5, 90.5, 90.5), levels, ctx).order).toBeNull()
  })
})

describe('which units a chart can draw', () => {
  test('nothing finer than the parameter, and nothing finer than the chart bar', () => {
    expect(unitsFor('D', HOUR)).toEqual(['Y', 'Q', 'M', 'W', 'D'])
    expect(unitsFor('W', HOUR)).toEqual(['Y', 'Q', 'M', 'W'])
    // A daily chart still has the previous day's high and low -- they are the previous BAR's.
    expect(unitsFor('D', DAY)).toEqual(['Y', 'Q', 'M', 'W', 'D'])
    // A weekly chart has nothing to say about a level inside a day.
    expect(unitsFor('D', 7 * DAY)).toEqual(['Y', 'Q', 'M', 'W'])
  })
})

describe('the skip counters', () => {
  test('a setup the hours refused is counted, and the pane can say so', () => {
    const { trades, skips } = run(STOP_RUN, { window: 1 })
    expect(trades).toHaveLength(0)
    expect(skips.hours).toBe(1)
  })

  test('a setup the reward refused is counted', () => {
    expect(run(STOP_RUN, { rr: 4 }).skips.rr).toBe(1)
  })

  test('an order price went back through is counted as invalidated', () => {
    const bars = [...STOP_RUN]
    bars[3] = bar(5, 3, 90.4, 91, 88.5, 89)
    expect(run(bars).skips.invalidated).toBe(1)
  })
})

describe('the level map both indicators draw', () => {
  const sessions = mergeSessions(BASE, sessionsFromBars(STOP_RUN, CLOCK))

  test('is exactly the map the entries indicator trades from', () => {
    const map = levelMap(STOP_RUN, sessions, CLOCK, HOUR, TICK, 'D')
    const { values } = run(STOP_RUN)
    const drawn = values.map((v) => (v.levels ?? []).map((l) => l.label))
    expect(map?.levels.map((levels) => levels.map((l) => l.label))).toEqual(drawn)
  })

  test('bars sharing a map share the array, which is what a drawer groups runs by', () => {
    const map = levelMap(STOP_RUN, sessions, CLOCK, HOUR, TICK, 'D')
    // Bar 0 opens the day, so its map lacks the day's own open; bars 1-4 share one.
    expect(map?.levels[0]).not.toBe(map?.levels[1])
    expect(map?.levels[1]).toBe(map?.levels[4])
  })

  test('is null when there is nothing to draw it from', () => {
    expect(levelMap([], sessions, CLOCK, HOUR, TICK, 'D')).toBeNull()
    expect(levelMap(STOP_RUN, [], CLOCK, HOUR, TICK, 'D')).toBeNull()
    // No calendar unit is as long as a 400-day bar.
    expect(levelMap(STOP_RUN, sessions, CLOCK, 400 * DAY, TICK, 'D')).toBeNull()
  })
})

describe('with no daily bars at all', () => {
  test('nothing is drawn and nothing is claimed', () => {
    const empty = computeTradeTalk({
      bars: STOP_RUN,
      sessions: [],
      clock: CLOCK,
      barMs: HOUR,
      tick: TICK,
      settings: SETTINGS
    })
    expect(empty.trades).toHaveLength(0)
    expect(empty.values.every((value) => value.levels === undefined)).toBe(true)
  })
})
