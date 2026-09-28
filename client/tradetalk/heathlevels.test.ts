import { describe, expect, test } from 'bun:test'

import type { Candle } from './calendar'
import { atr, heathLevels, isLive, LOOKBACK, originOf, runStart, zoneOf, type HeathLevelSettings } from './heathlevels'
import { emptyText, levelLabel, settingsOf, DEFAULT_PARAMS } from './heathtemplate'

const bar = (open: number, high: number, low: number, close: number): Candle => ({
  timestamp: 0,
  open,
  high,
  low,
  close
})

const dated = (bars: Candle[]): Candle[] => bars.map((b, i) => ({ ...b, timestamp: i * 3_600_000 }))

// `maxRun: 1` keeps every case below on the single last opposite-colour candle, which is what
// the erasure and freshness rules are about; the run is its own describe at the bottom. The
// `minWidth` here is far larger than any fixture's ATR, so the zone is never "wide enough" and
// the cap alone decides the run -- which is what those cases are about.
const SETTINGS: HeathLevelSettings = {
  left: 2,
  right: 2,
  sides: 0,
  freshOnly: false,
  stopLine: false,
  maxRun: 1,
  minWidth: 99
}

// A rally whose last candle closes up, then a sell-off: index 3 is the swing top and its own
// candle is the last up-close one, so the supply line is that candle's open.
const RALLY = dated([
  bar(10, 11, 9.5, 10.5),
  bar(10.5, 11.5, 10.2, 11.2),
  bar(11.2, 12.5, 11, 12.3),
  bar(12.3, 13, 12.2, 12.9),
  bar(12.9, 12.95, 12, 12.1),
  bar(12.1, 12.2, 11.2, 11.3),
  bar(11.3, 11.4, 10.8, 10.9)
])

describe('supply', () => {
  const levels = heathLevels(RALLY, SETTINGS)

  test('is the OPEN of the last up-close candle before the sell-off', () => {
    expect(levels).toHaveLength(1)
    expect(levels[0]).toMatchObject({ side: 'supply', originIndex: 3, turnIndex: 3, price: 12.3, low: 12.3, high: 12.9 })
  })

  test('carries the stop at that candle\'s wick high', () => {
    expect(levels[0].stop).toBe(13)
  })

  test('is knowable only once the swing is confirmed', () => {
    expect(levels[0].confirmIndex).toBe(5)
  })

  test('is not "tested" by the sell-off that created it', () => {
    expect(levels[0].testedIndex).toBeNull()
    expect(levels[0].brokenIndex).toBeNull()
  })

  test('the turn candle need not be the origin candle', () => {
    // The top candle closes DOWN -- it spiked to the high and reversed -- so the last
    // up-close candle is the one before it, and its open is the line.
    const bars = dated([...RALLY])
    bars[3] = { ...bars[3], open: 12.9, close: 12.4 }
    const [level] = heathLevels(bars, SETTINGS)
    expect(level).toMatchObject({ side: 'supply', originIndex: 2, price: 11.2, stop: 12.5 })
  })
})

describe('demand', () => {
  // The mirror: a sell-off into a swing bottom, the last down-close candle, then a rally.
  const bars = dated([
    bar(13, 13.2, 12.5, 12.6),
    bar(12.6, 12.8, 11.8, 11.9),
    bar(11.9, 12, 11, 11.1),
    bar(11.1, 11.2, 10, 10.2),
    bar(10.2, 11.3, 10.1, 11.2),
    bar(11.2, 12, 11.1, 11.9),
    bar(11.9, 12.5, 11.8, 12.4)
  ])
  const levels = heathLevels(bars, SETTINGS)

  test('is the OPEN of the last down-close candle before the rally, stop at its wick low', () => {
    expect(levels).toHaveLength(1)
    expect(levels[0]).toMatchObject({ side: 'demand', originIndex: 3, price: 11.1, low: 10.2, high: 11.1, stop: 10 })
  })

  test('only one side is computed when the parameter asks for one', () => {
    expect(heathLevels(bars, { ...SETTINGS, sides: 1 })).toHaveLength(0)
    expect(heathLevels(bars, { ...SETTINGS, sides: 2 })).toHaveLength(1)
  })
})

describe('the life of a level', () => {
  test('price coming back INTO the area marks it tested, and it is no longer fresh', () => {
    const bars = dated([
      ...RALLY,
      bar(10.9, 11.5, 10.8, 11.4),
      bar(11.4, 12.4, 11.3, 12.2) // reaches back up into the area, closing under the line
    ])
    const [level] = heathLevels(bars, SETTINGS)
    expect(level.testedIndex).toBe(8)
    expect(level.brokenIndex).toBeNull()
    // Supply only: these bars also put in a swing bottom, whose demand is still fresh.
    expect(heathLevels(bars, { ...SETTINGS, freshOnly: true, sides: 1 })).toHaveLength(0)
  })

  test('one candle passing entirely through the area erases it', () => {
    // The area is the body, 12.3 (open) to 12.9 (close). This candle's RANGE covers all of it.
    const bars = dated([
      ...RALLY,
      bar(10.9, 12, 10.8, 11.9),
      bar(11.9, 13.1, 11.8, 12), // covers 12.3-12.9 with its range, but closes under the line
      bar(12, 12.3, 11.9, 12.1)
    ])
    const [level] = heathLevels(bars, SETTINGS)
    expect(level.brokenIndex).toBe(8)
    expect(level.brokenBy).toBe('through')
    expect(isLive(level, 7)).toBe(true)
    expect(isLive(level, 8)).toBe(false)
    // The candle that erased it also reached into it, which is the last thing recorded.
    expect(level.testedIndex).toBe(8)
  })

  test('a wick covering only part of the area leaves it live', () => {
    // High 12.8 is inside the 12.3-12.9 body, so the candle did not pass through it.
    const bars = dated([
      ...RALLY,
      bar(10.9, 12, 10.8, 11.9),
      bar(11.9, 12.8, 11.8, 12),
      bar(12, 12.5, 11.9, 12.1)
    ])
    const [level] = heathLevels(bars, SETTINGS)
    expect(level.brokenIndex).toBeNull()
    expect(level.testedIndex).toBe(8)
    expect(isLive(level, 9)).toBe(true)
  })

  test('a candle that gaps clean over the area ends it on the close, not the through rule', () => {
    // Its LOW never reached 12.3, so nothing passed through the area -- but it closed well
    // above the line, and a close through the line is the end of the level.
    const bars = dated([
      ...RALLY,
      bar(10.9, 12, 10.8, 11.9),
      bar(13.2, 13.6, 13.1, 13.5)
    ])
    const [level] = heathLevels(bars, SETTINGS)
    expect(level.brokenIndex).toBe(8)
    expect(level.brokenBy).toBe('closed')
  })

  test('the area is the origin candle\'s BODY, and the stop is outside it', () => {
    const [supply] = heathLevels(RALLY, SETTINGS)
    // Origin candle O 12.3 H 13 L 12.2 C 12.9: the body is 12.3-12.9, the stop 13.
    expect(zoneOf(supply)).toEqual({ low: 12.3, high: 12.9 })
    expect(supply.stop).toBe(13)
    expect(supply.stop).toBeGreaterThan(zoneOf(supply).high)
    // And the other wick, 12.2, is what a close has to clear for it to become a zone at all.
    expect(supply.departure).toBe(12.2)
    expect(supply.departure).toBeLessThanOrEqual(zoneOf(supply).low)
    // Demand mirrors it: the body, with the stop below.
    expect(zoneOf({ low: 10.2, high: 11.1 })).toEqual({ low: 10.2, high: 11.1 })
  })

  test('a CLOSE through the line ends it, without ever reaching the far edge', () => {
    // Closes at 12.35, barely through the 12.3 line and nowhere near the 12.9 top of the area.
    const bars = dated([
      ...RALLY,
      bar(10.9, 12, 10.8, 11.9),
      bar(12, 12.5, 11.9, 12.35)
    ])
    const [level] = heathLevels(bars, SETTINGS)
    expect(level.testedIndex).toBe(8)
    expect(level.brokenIndex).toBe(8)
    expect(level.brokenBy).toBe('closed')
  })

  test('an OPEN beyond the area is not a break -- the departure is read off the close', () => {
    // The candle after the origin OPENS above the area's top (12.9) and sells off, closing
    // under the origin candle's low. That close is the departure, not a break.
    const bars = dated([
      RALLY[0], RALLY[1], RALLY[2], RALLY[3],
      bar(12.95, 12.98, 12, 12.1),
      RALLY[5],
      RALLY[6]
    ])
    const [level] = heathLevels(bars, SETTINGS)
    expect(level.armedIndex).toBe(4)
    expect(level.brokenIndex).toBeNull()
  })

  test('the departure is a close beyond the WHOLE candle, not clear of its body', () => {
    // The bar after the origin closes at 12.25: below the 12.3 body but still inside the
    // candle, whose low is 12.2. The chart used to call that established; he does not.
    const bars = dated([
      RALLY[0], RALLY[1], RALLY[2], RALLY[3],
      bar(12.85, 12.9, 12.24, 12.25),
      bar(12.25, 12.3, 12.21, 12.22),
      RALLY[6]
    ])
    const [level] = heathLevels(bars, SETTINGS)
    expect(level.armedIndex).toBe(6) // RALLY[6] closes at 10.9, clear of the 12.2 low
    expect(isLive(level, 5)).toBe(false)
    expect(isLive(level, 6)).toBe(true)
  })

  test('a close beyond the STOP means the candles never become a zone', () => {
    // The turn (index 3) closes DOWN, so the supply is the candle before it -- O 11.2 H 12.5
    // L 11 C 12.3, stop 12.5. Index 4 closes at 12.6, through where the stop goes, before
    // price ever left: there was no departure and there is no level.
    const bars = dated([
      bar(10, 11, 9.5, 10.5),
      bar(10.5, 11.5, 10.2, 11.2),
      bar(11.2, 12.5, 11, 12.3),
      bar(12.9, 13, 12.2, 12.4),
      bar(12.4, 12.7, 12.3, 12.6),
      bar(12.6, 12.65, 11.5, 11.6),
      bar(11.6, 11.7, 11, 11.1)
    ])
    const [level] = heathLevels(bars, SETTINGS)
    expect(level).toMatchObject({ side: 'supply', originIndex: 2, price: 11.2, stop: 12.5 })
    expect(level.armedIndex).toBeNull()
    expect(level.brokenIndex).toBe(4)
    expect(level.brokenBy).toBe('failed')
    // Never established, so never on the chart -- not even before the bar that ended it.
    expect(isLive(level, 3)).toBe(false)
  })

  test('a WICK through the line is not a break, and leaves it live', () => {
    // High 12.5 pokes through the 12.3 line, and the close, 12.2, is back under it.
    const bars = dated([
      ...RALLY,
      bar(10.9, 12, 10.8, 11.9),
      bar(12, 12.5, 11.9, 12.2)
    ])
    const [level] = heathLevels(bars, SETTINGS)
    expect(level.brokenIndex).toBeNull()
    expect(level.testedIndex).toBe(8)
  })

  test('the sell-off away from a supply establishes it rather than ending it', () => {
    const [level] = heathLevels(RALLY, SETTINGS)
    expect(level.armedIndex).toBe(4)
    expect(level.brokenIndex).toBeNull()
  })

  test('a close below a demand\'s line ends it, mirrored', () => {
    const bars = dated([
      bar(13, 13.2, 12.5, 12.6),
      bar(12.6, 12.8, 11.8, 11.9),
      bar(11.9, 12, 11, 11.1),
      bar(11.1, 11.2, 10, 10.2), // demand: body 10.2-11.1, stop 10
      bar(10.2, 11.3, 10.1, 11.2),
      bar(11.2, 12, 11.1, 11.9),
      bar(11.9, 12.5, 11.8, 12.4),
      bar(10.4, 10.5, 9.5, 10.1) // closes at 10.1, through the 11.1 line
    ])
    const [level] = heathLevels(bars, SETTINGS)
    expect(level.side).toBe('demand')
    expect(level.departure).toBe(11.2) // the rally has to close above the candle's HIGH
    expect(level.armedIndex).toBe(5)
    expect(level.brokenIndex).toBe(7)
    expect(level.brokenBy).toBe('closed')
  })

  test('a candle covering the body but not the wick still erases it', () => {
    // High 12.95 clears the 12.9 body top but not the 13 wick: the area is the body, so
    // this candle passed entirely through the level.
    const bars = dated([
      ...RALLY,
      bar(10.9, 12, 10.8, 11.9),
      bar(11.9, 12.95, 11.8, 12)
    ])
    const [level] = heathLevels(bars, SETTINGS)
    expect(level.brokenIndex).toBe(8)
    expect(level.brokenBy).toBe('through')
  })

  test('a level is not on the chart until price has traded away from it', () => {
    const [level] = heathLevels(RALLY, SETTINGS)
    expect(level.armedIndex).toBe(4)
    expect(isLive(level, 3)).toBe(false)
    expect(isLive(level, 4)).toBe(true)
  })
})

describe('originOf', () => {
  test('finds the last candle of the wanted colour at or before the turn', () => {
    expect(originOf(RALLY, 3, 'supply')).toBe(3)
    expect(originOf(RALLY, 6, 'demand')).toBe(6)
    // Walks back past candles of the wrong colour: bar 4 is the first down-close, so a turn
    // at 5 anchors on it only if 5 itself is not one -- it is, so 5.
    expect(originOf(RALLY, 5, 'demand')).toBe(5)
    expect(originOf(RALLY, 5, 'supply')).toBe(3)
    // Nothing of that colour at all before the turn.
    expect(originOf(RALLY, 3, 'demand')).toBe(-1)
  })

  test('gives up rather than reaching arbitrarily far back', () => {
    const flat = dated(Array.from({ length: LOOKBACK + 6 }, () => bar(10, 10.5, 9.5, 9)))
    // Every candle closes down, so there is no up-close candle to anchor a supply line.
    expect(originOf(flat, flat.length - 1, 'supply')).toBe(-1)
    expect(heathLevels(flat, SETTINGS).every((level) => level.side === 'demand')).toBe(true)
  })

  test('a doji is neither colour', () => {
    const bars = dated([bar(10, 11, 9, 10), bar(10, 11, 9, 10)])
    expect(originOf(bars, 1, 'supply')).toBe(-1)
    expect(originOf(bars, 1, 'demand')).toBe(-1)
  })
})

describe('no lookahead', () => {
  const bars = dated([
    ...RALLY,
    bar(10.9, 11.6, 10.8, 11.5),
    bar(11.5, 12.6, 11.4, 12.5),
    bar(12.5, 12.7, 11.9, 12),
    bar(12, 12.1, 11, 11.1),
    bar(11.1, 11.3, 10.5, 10.6),
    bar(10.6, 11.9, 10.5, 11.8),
    bar(11.8, 13.6, 11.7, 13.5)
  ])
  const full = heathLevels(bars, SETTINGS)

  test('the fixture produces several levels', () => {
    expect(full.length).toBeGreaterThan(1)
  })

  test('every prefix agrees about the levels it can already see', () => {
    for (let n = 1; n <= bars.length; n++) {
      const prefix = heathLevels(bars.slice(0, n), SETTINGS)
      const visible = full.filter((level) => level.confirmIndex <= n - 1)
      expect(prefix.map((l) => [l.side, l.originIndex, l.price, l.stop])).toEqual(
        visible.map((l) => [l.side, l.originIndex, l.price, l.stop])
      )
    }
  })
})

describe('the chart half', () => {
  test('the defaults are the ones the picker offers', () => {
    expect(settingsOf(DEFAULT_PARAMS)).toEqual({
      left: 5,
      right: 5,
      sides: 0,
      freshOnly: false,
      stopLine: false,
      fill: 12,
      calendar: true,
      maxRun: 3,
      minWidth: 0.5
    })
    expect(settingsOf(undefined)).toEqual(settingsOf(DEFAULT_PARAMS))
    expect(settingsOf([0, 999, 7, 1, 1, 200, 0, 99, 900])).toEqual({
      left: 1,
      right: 200,
      sides: 2,
      freshOnly: true,
      stopLine: true,
      fill: 100,
      calendar: false,
      maxRun: 10,
      minWidth: 5
    })
    // Layouts saved before the shading and calendar parameters existed read their defaults.
    expect(settingsOf([5, 5, 0, 0, 0]).fill).toBe(12)
    expect(settingsOf([5, 5, 0, 0, 0, 12]).calendar).toBe(true)
    expect(settingsOf([5, 5, 0, 0, 0, 12, 1]).maxRun).toBe(3)
    expect(settingsOf([5, 5, 0, 0, 0, 12, 1, 3]).minWidth).toBe(0.5)
  })

  test('a level says whether price has been back to it', () => {
    const [fresh] = heathLevels(RALLY, SETTINGS)
    expect(levelLabel(fresh)).toBe('supply')
    expect(levelLabel({ ...fresh, testedIndex: 9 })).toBe('supply · tested')
  })

  test('an empty pane says why it is empty', () => {
    const settings = settingsOf(DEFAULT_PARAMS)
    expect(emptyText(0, settings)).toContain('no bars')
    expect(emptyText(8, settings)).toContain('needs more than 10 bars')
    expect(emptyText(500, settings)).toContain('no turn in view')
    expect(emptyText(500, { ...settings, freshOnly: true })).toContain('none untested')
  })
})

// "One or more candles": bars 1-3 all close up into the swing top at 3, and bar 0 closes down,
// so the run is 1-3 and its length is whatever `maxRun` allows.
const RUN = dated([
  bar(10, 10.5, 9.4, 9.8),
  bar(9.8, 10.3, 9.7, 10.2),
  bar(10.2, 11.5, 10.1, 11.3),
  bar(11.3, 12.6, 11.2, 12.4),
  bar(12.4, 12.5, 11.5, 11.6),
  bar(11.6, 11.7, 10.8, 10.9),
  bar(10.9, 11, 10.4, 10.5)
])

describe('one or more candles', () => {
  test('the zone is the union of the run\'s bodies, the line its earliest open', () => {
    const [one] = heathLevels(RUN, { ...SETTINGS, maxRun: 1 })
    expect(one).toMatchObject({ originIndex: 3, originEnd: 3, price: 11.3, low: 11.3, high: 12.4 })

    const [two] = heathLevels(RUN, { ...SETTINGS, maxRun: 2 })
    expect(two).toMatchObject({ originIndex: 2, originEnd: 3, price: 10.2, low: 10.2, high: 12.4 })

    const [three] = heathLevels(RUN, { ...SETTINGS, maxRun: 3 })
    expect(three).toMatchObject({ originIndex: 1, originEnd: 3, price: 9.8, low: 9.8, high: 12.4 })
  })

  test('the stop is the furthest wick of the whole run, still outside the zone', () => {
    const [level] = heathLevels(RUN, { ...SETTINGS, maxRun: 3 })
    expect(level.stop).toBe(12.6)
    expect(level.stop).toBeGreaterThan(level.high)
  })

  test('a candle that closed the other way ends the run, whatever the cap allows', () => {
    // Bar 0 closes down, so nothing beyond it joins however high the cap goes.
    expect(heathLevels(RUN, { ...SETTINGS, maxRun: 10 })[0].originIndex).toBe(1)
    expect(runStart(RUN, 3, 10, 999)).toBe(1)
  })

  test('the turn is unchanged by the run -- only where the level is drawn from', () => {
    for (const maxRun of [1, 2, 3, 10]) {
      expect(heathLevels(RUN, { ...SETTINGS, maxRun })[0]).toMatchObject({ turnIndex: 3, confirmIndex: 5 })
    }
  })

  test('the candles that built the level cannot be what erases it', () => {
    // The run's own bodies fill the zone and the sell-off out of it starts inside, but the
    // life only begins after the run's last candle -- so neither is a test or a break.
    const [level] = heathLevels(RUN, { ...SETTINGS, maxRun: 3 })
    expect(level.testedIndex).toBeNull()
    expect(level.brokenIndex).toBeNull()
    // And the departure is the whole run's low, 9.7, which this sell-off never closes under:
    // price never left, so it is not a zone yet either.
    expect(level.departure).toBe(9.7)
    expect(level.armedIndex).toBeNull()
  })

  test('a run departs when a close clears the WHOLE run, not just the last candle', () => {
    const bars = dated([...RUN, bar(10.5, 10.6, 9.6, 9.65)])
    const [three] = heathLevels(bars, { ...SETTINGS, maxRun: 3 })
    expect(three.armedIndex).toBe(7) // 9.65 is under the run's 9.7 low
    // Read as one candle the same bars depart four bars earlier, off that candle's own 11.2.
    const [one] = heathLevels(bars, { ...SETTINGS, maxRun: 1 })
    expect(one.armedIndex).toBe(5)
  })

  test('every prefix agrees about the runs it can already see', () => {
    const settings = { ...SETTINGS, maxRun: 3 }
    const full = heathLevels(RUN, settings)
    for (let n = 1; n <= RUN.length; n++) {
      const prefix = heathLevels(RUN.slice(0, n), settings)
      const visible = full.filter((level) => level.confirmIndex <= n - 1)
      expect(prefix.map((l) => [l.originIndex, l.price, l.low, l.high, l.stop])).toEqual(
        visible.map((l) => [l.originIndex, l.price, l.low, l.high, l.stop])
      )
    }
  })
})

describe('the zone widens only while it is too small', () => {
  // Three up-close candles, each body 0.2 tall, stepping up. The run walks back from index 2.
  const steps = dated([
    bar(10, 10.25, 9.95, 10.2),
    bar(10.2, 10.45, 10.15, 10.4),
    bar(10.4, 10.65, 10.35, 10.6)
  ])

  test('a candle wide enough on its own is the whole zone', () => {
    // Its body is 0.2, more than the 0.15 asked for. (The thresholds here stay off the exact
    // body heights: 10.6 - 10.4 is 0.19999999999999929 in floating point, and a comparison
    // sitting on the boundary would turn on that.)
    expect(runStart(steps, 2, 5, 0.15)).toBe(2)
    expect(runStart(steps, 2, 5, 0)).toBe(2)
  })

  test('a small one pulls in the candle before it, and stops as soon as it is enough', () => {
    // Needs 0.3: index 2 alone gives 0.2, and 1-2 gives 0.4, so it stops at two candles even
    // though a third is available and the cap allows it.
    expect(runStart(steps, 2, 5, 0.3)).toBe(1)
    // Needs 0.5: two candles give 0.4, three give 0.6.
    expect(runStart(steps, 2, 5, 0.5)).toBe(0)
  })

  test('the cap and the colour still bound it, and a zone that stays small is still a zone', () => {
    expect(runStart(steps, 2, 2, 999)).toBe(1) // the cap stops it one short
    const broken = dated([bar(10.4, 10.5, 10.1, 10.15), steps[1], steps[2]]) // index 0 closes down
    expect(runStart(broken, 2, 5, 999)).toBe(1) // the colour stops it
    expect(runStart(steps, 2, 5, 999)).toBe(0) // nothing left to add, and it returns anyway
  })

  test('the threshold is ATR-relative, so the same setting means the same thing anywhere', () => {
    // RUN's zone at index 3 is 11.3-12.4 (1.1 tall) against an ATR around 1.0, so a 0.5x
    // threshold is already met by the one candle and a 3x one reaches for the whole run.
    expect(heathLevels(RUN, { ...SETTINGS, maxRun: 3, minWidth: 0.5 })[0].originIndex).toBe(3)
    expect(heathLevels(RUN, { ...SETTINGS, maxRun: 3, minWidth: 3 })[0].originIndex).toBe(1)
    // 0 is "always the single last candle", whatever the cap allows.
    expect(heathLevels(RUN, { ...SETTINGS, maxRun: 3, minWidth: 0 })[0].originIndex).toBe(3)
  })
})

describe('ATR', () => {
  const bars = dated([
    bar(10, 11, 9, 10.5),
    bar(10.5, 12, 10, 11.5),
    bar(11.5, 11.8, 10.2, 10.4)
  ])

  test('the first bar is its own range, and later ones take the gap into account', () => {
    const values = atr(bars, 14)
    expect(values[0]).toBe(2) // 11 - 9
    expect(values[1]).toBe((2 + 2) / 2) // max(2, |12-10.5|, |10-10.5|) = 2
    expect(values[2]).toBeCloseTo((2 + 2 + 1.6) / 3, 10)
  })

  test('is causal -- a prefix gives the same values as the whole series', () => {
    const full = atr(bars, 2)
    for (let n = 1; n <= bars.length; n++) {
      expect(atr(bars.slice(0, n), 2)).toEqual(full.slice(0, n))
    }
  })
})
