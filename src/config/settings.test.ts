import { describe, expect, test } from 'bun:test'

import { getOptions, STYLE_SETTING_KEYS, settingStyleValue } from './settings'

// A pane's style settings are a stored document (PaneOptions.styleOverrides, the wall
// document's `st`), handed back to whatever build of the chart reads it next. settingStyleValue
// is the one gate between that document and klinecharts' style tree, so what it refuses
// matters as much as what it passes.

describe('STYLE_SETTING_KEYS', () => {
  test('is every settings-dialog option except the two the price axis takes', () => {
    expect([...STYLE_SETTING_KEYS]).toEqual([
      'candle.type',
      'candle.priceMark.last.show',
      'candle.priceMark.high.show',
      'candle.priceMark.low.show',
      'indicator.lastValueMark.show',
      'grid.show'
    ])
    // The y-axis pair is a PaneViewState field (overrideYAxis), not a style -- and the dialog
    // still offers both, so their absence here is the split and not an omission.
    const offered = getOptions('en-US').map((option) => option.key)
    expect(offered).toContain('yAxis.type')
    expect(offered).toContain('yAxis.reverse')
    expect(offered.filter((key) => !key.startsWith('yAxis.'))).toEqual([...STYLE_SETTING_KEYS])
  })
})

describe('settingStyleValue', () => {
  test('passes a switch its boolean and a select one of its own options', () => {
    expect(settingStyleValue('grid.show', false)).toBe(false)
    expect(settingStyleValue('candle.priceMark.last.show', true)).toBe(true)
    expect(settingStyleValue('candle.type', 'area')).toBe('area')
    expect(settingStyleValue('candle.type', 'ohlc')).toBe('ohlc')
  })

  test('refuses a value of the wrong kind, however plausible it reads', () => {
    // What a document round-tripped through a form, or a hand-edited one, looks like.
    expect(settingStyleValue('grid.show', 'true')).toBeUndefined()
    expect(settingStyleValue('grid.show', 1)).toBeUndefined()
    expect(settingStyleValue('grid.show', null)).toBeUndefined()
    expect(settingStyleValue('candle.type', true)).toBeUndefined()
    // A candle type klinecharts does not draw: it would be merged into the style tree and
    // stay there, with nothing in the dialog able to show or clear it.
    expect(settingStyleValue('candle.type', 'candlestick')).toBeUndefined()
  })

  test('refuses a path the dialog does not offer, the price axis included', () => {
    expect(settingStyleValue('yAxis.type', 'logarithm')).toBeUndefined()
    expect(settingStyleValue('yAxis.reverse', true)).toBeUndefined()
    expect(settingStyleValue('candle.bar.upColor', '#00ff00')).toBeUndefined()
    expect(settingStyleValue('', false)).toBeUndefined()
  })
})
