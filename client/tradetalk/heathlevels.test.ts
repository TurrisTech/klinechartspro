import { describe, expect, test } from 'bun:test'

import type { Candle } from './calendar'
import { heathLevels, isLive, LOOKBACK, originOf, type HeathLevelSettings } from './heathlevels'
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
    expect(levels[0]).toMatchObject({ side: 'supply', originIndex: 3, turnIndex: 3, price: 12.3 })
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
    expect(levels[0]).toMatchObject({ side: 'demand', originIndex: 3, price: 11.1, stop: 10 })
  })

  test('only one side is computed when the parameter asks for one', () => {
    expect(heathLevels(bars, { ...SETTINGS, sides: 1 })).toHaveLength(0)
    expect(heathLevels(bars, { ...SETTINGS, sides: 2 })).toHaveLength(1)
  })
})

describe('the life of a level', () => {
  test('price coming back to it marks it tested, and it is no longer fresh', () => {
    const bars = dated([
      ...RALLY,
      bar(10.9, 11.5, 10.8, 11.4),
      bar(11.4, 12.4, 11.3, 12.3) // reaches back up to the 12.3 line
    ])
    const [level] = heathLevels(bars, SETTINGS)
    expect(level.testedIndex).toBe(8)
    expect(heathLevels(bars, { ...SETTINGS, freshOnly: true })).toHaveLength(0)
  })

  test('a close beyond the stop finishes it, and nothing is recorded after', () => {
    const bars = dated([
      ...RALLY,
      bar(10.9, 12, 10.8, 11.9),
      bar(11.9, 13.4, 11.8, 13.3), // closes above the origin candle's high of 13
      bar(13.3, 14, 13.2, 13.9)
    ])
    const [level] = heathLevels(bars, SETTINGS)
    expect(level.brokenIndex).toBe(8)
    expect(isLive(level, 7)).toBe(true)
    expect(isLive(level, 8)).toBe(false)
    // The bar that broke it also reached the line, which is the last thing it records.
    expect(level.testedIndex).toBe(8)
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
    expect(settingsOf(DEFAULT_PARAMS)).toEqual({ left: 5, right: 5, sides: 0, freshOnly: false, stopLine: false })
    expect(settingsOf(undefined)).toEqual(settingsOf(DEFAULT_PARAMS))
    expect(settingsOf([0, 999, 7, 1, 1])).toEqual({ left: 1, right: 200, sides: 2, freshOnly: true, stopLine: true })
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
