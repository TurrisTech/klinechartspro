import { describe, expect, test } from 'bun:test'

import type { Candle } from './calendar'
import { heathLevels, isLive, LOOKBACK, originOf, zoneOf, type HeathLevelSettings } from './heathlevels'
import { emptyText, levelLabel, settingsOf, DEFAULT_PARAMS } from './heathtemplate'

const bar = (open: number, high: number, low: number, close: number): Candle => ({
  timestamp: 0,
  open,
  high,
  low,
  close
})

const dated = (bars: Candle[]): Candle[] => bars.map((b, i) => ({ ...b, timestamp: i * 3_600_000 }))

const SETTINGS: HeathLevelSettings = { left: 2, right: 2, sides: 0, freshOnly: false, stopLine: false }

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
    expect(levels[0]).toMatchObject({ side: 'supply', originIndex: 3, turnIndex: 3, price: 12.3, close: 12.9 })
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
    expect(levels[0]).toMatchObject({ side: 'demand', originIndex: 3, price: 11.1, close: 10.2, stop: 10 })
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
      bar(11.4, 12.4, 11.3, 12.3) // reaches back up past the 12.3 edge, not through the area
    ])
    const [level] = heathLevels(bars, SETTINGS)
    expect(level.testedIndex).toBe(8)
    expect(heathLevels(bars, { ...SETTINGS, freshOnly: true })).toHaveLength(0)
  })

  test('one candle passing entirely through the area erases it', () => {
    // The area is the body, 12.3 (open) to 12.9 (close). This candle's RANGE covers all of it.
    const bars = dated([
      ...RALLY,
      bar(10.9, 12, 10.8, 11.9),
      bar(11.9, 13.1, 11.8, 12.6),
      bar(12.6, 13, 12.5, 12.9)
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

  test('a candle that gaps clean over the area ends it by the body rule, not the through rule', () => {
    // Its LOW never reached 12.3, so nothing passed through the area -- but its body sits
    // above it, and a body beyond the level is the end of the level.
    const bars = dated([
      ...RALLY,
      bar(10.9, 12, 10.8, 11.9),
      bar(13.2, 13.6, 13.1, 13.5)
    ])
    const [level] = heathLevels(bars, SETTINGS)
    expect(level.brokenIndex).toBe(8)
    expect(level.brokenBy).toBe('crossed')
  })

  test('the area is the origin candle\'s BODY, and the stop is outside it', () => {
    const [supply] = heathLevels(RALLY, SETTINGS)
    // Origin candle O 12.3 H 13 L 12.2 C 12.9: the body is 12.3-12.9, the stop 13.
    expect(zoneOf(supply)).toEqual({ low: 12.3, high: 12.9 })
    expect(supply.stop).toBe(13)
    expect(supply.stop).toBeGreaterThan(zoneOf(supply).high)
    // Demand mirrors it: the body, with the stop below.
    expect(zoneOf({ price: 11.1, close: 10.2 })).toEqual({ low: 10.2, high: 11.1 })
  })

  test('a BODY across the top of a supply ends it, even reaching only part way over', () => {
    // Body 12.5-12.95: its low is still inside the 12.3-12.9 area, but it crossed the top.
    const bars = dated([
      ...RALLY,
      bar(10.9, 12, 10.8, 11.9),
      bar(12.5, 13.05, 12.4, 12.95)
    ])
    const [level] = heathLevels(bars, SETTINGS)
    expect(level.brokenIndex).toBe(8)
    expect(level.brokenBy).toBe('crossed')
  })

  test('the move that CREATES a level cannot destroy it on its way out', () => {
    // The candle after the origin opens above the area's top (12.9) and sells off. Its body
    // crosses the edge, but the level is not established yet, and it did not CLOSE past it.
    const bars = dated([
      RALLY[0], RALLY[1], RALLY[2], RALLY[3],
      bar(12.95, 12.98, 12, 12.1),
      RALLY[5],
      RALLY[6]
    ])
    const [level] = heathLevels(bars, SETTINGS)
    expect(level?.brokenIndex ?? null).toBeNull()
  })

  test('but a CLOSE past the far edge ends it even before it is established', () => {
    // Never departs: the bar after the origin CLOSES above the area's top (12.9), while its
    // high stays under the swing high so the top is still a top.
    const bars = dated([
      RALLY[0], RALLY[1], RALLY[2], RALLY[3],
      bar(12.85, 12.99, 12.8, 12.95),
      RALLY[5],
      RALLY[6]
    ])
    const [level] = heathLevels(bars, SETTINGS)
    expect(level.brokenIndex).toBe(4)
    expect(level.brokenBy).toBe('crossed')
  })

  test('a WICK across the edge is not a body, and leaves it live', () => {
    // High 13.05 pokes above the area but the body, 12.5-12.7, is still inside it.
    const bars = dated([
      ...RALLY,
      bar(10.9, 12, 10.8, 11.9),
      bar(12.5, 13.05, 12.4, 12.7)
    ])
    const [level] = heathLevels(bars, SETTINGS)
    expect(level.brokenIndex).toBeNull()
    expect(level.testedIndex).toBe(8)
  })

  test('the sell-off away from a supply leaves it live -- only the top edge matters', () => {
    const [level] = heathLevels(RALLY, SETTINGS)
    expect(level.brokenIndex).toBeNull()
  })

  test('a body below a demand ends it, mirrored', () => {
    const bars = dated([
      bar(13, 13.2, 12.5, 12.6),
      bar(12.6, 12.8, 11.8, 11.9),
      bar(11.9, 12, 11, 11.1),
      bar(11.1, 11.2, 10, 10.2), // demand: body 10.2-11.1, stop 10
      bar(10.2, 11.3, 10.1, 11.2),
      bar(11.2, 12, 11.1, 11.9),
      bar(11.9, 12.5, 11.8, 12.4),
      bar(10.4, 10.5, 9.5, 10.1) // body 10.1-10.4 crosses the area's bottom edge, 10.2
    ])
    const [level] = heathLevels(bars, SETTINGS)
    expect(level.side).toBe('demand')
    expect(level.brokenIndex).toBe(7)
    expect(level.brokenBy).toBe('crossed')
  })

  test('a candle covering the body but not the wick still erases it', () => {
    // High 12.95 clears the 12.9 body top but not the 13 wick: the area is the body, so
    // this candle passed entirely through the level.
    const bars = dated([
      ...RALLY,
      bar(10.9, 12, 10.8, 11.9),
      bar(11.9, 12.95, 11.8, 12.6)
    ])
    const [level] = heathLevels(bars, SETTINGS)
    expect(level.brokenIndex).toBe(8)
  })

  test('a level is not on the chart before its own candle', () => {
    const [level] = heathLevels(RALLY, SETTINGS)
    expect(isLive(level, level.originIndex - 1)).toBe(false)
    expect(isLive(level, level.originIndex)).toBe(true)
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
    expect(settingsOf(DEFAULT_PARAMS)).toEqual({ left: 5, right: 5, sides: 0, freshOnly: false, stopLine: false, fill: 12 })
    expect(settingsOf(undefined)).toEqual(settingsOf(DEFAULT_PARAMS))
    expect(settingsOf([0, 999, 7, 1, 1, 200])).toEqual({ left: 1, right: 200, sides: 2, freshOnly: true, stopLine: true, fill: 100 })
    // A layout saved before the shading parameter existed reads its default, not zero.
    expect(settingsOf([5, 5, 0, 0, 0]).fill).toBe(12)
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
