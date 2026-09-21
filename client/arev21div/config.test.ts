import { describe, expect, test } from 'bun:test'
import { DIV_DEFAULTS, DIV_FIELDS, fromStoredDivConfig, normaliseDivConfig, toStoredDivConfig } from './config'

// One pane's settings: complete and drawable whatever arrives, and stored as only what differs.

describe('the defaults', () => {
  test('the published rule, drawn as a thick dotted line in the chart green and red', () => {
    expect(DIV_DEFAULTS).toEqual({
      rule: { left: 10, right: 5, minGap: 5, maxGap: 60, minDp: 0, hidden: false },
      line: { style: 'dotted', width: 3, bullColor: '#26A69A', bearColor: '#EF5350', hiddenOpacity: 0.5 }
    })
  })

  test('the panel edits every setting, by the path it is stored under', () => {
    const keys = DIV_FIELDS.flatMap((f) => (f.kind === 'group' ? f.fields : [f])).map((f) => ('key' in f ? f.key : ''))
    expect(keys.sort()).toEqual(
      [
        'rule.left',
        'rule.right',
        'rule.minGap',
        'rule.maxGap',
        'rule.minDp',
        'rule.hidden',
        'line.style',
        'line.width',
        'line.hiddenOpacity',
        'line.bullColor',
        'line.bearColor'
      ].sort()
    )
  })
})

describe('normalising what the panel commits', () => {
  test('numbers are clamped and whole where they must be; junk falls back to the default', () => {
    const config = normaliseDivConfig({
      rule: { left: 1, right: '7', minGap: 5.4, maxGap: 1e6, minDp: 'x', hidden: true },
      line: { style: 'wavy', width: 40, bullColor: 'green', bearColor: '#123abc', hiddenOpacity: 0 }
    })
    expect(config.rule).toEqual({ left: 2, right: 7, minGap: 5, maxGap: 1000, minDp: 0, hidden: true })
    expect(config.line).toEqual({ style: 'dotted', width: 10, bullColor: '#26A69A', bearColor: '#123abc', hiddenOpacity: 0.1 })
  })

  test('an inverted gap window is widened rather than left to match nothing', () => {
    expect(normaliseDivConfig({ rule: { minGap: 90, maxGap: 20 } }).rule.maxGap).toBe(90)
  })

  test('nothing at all is the defaults, and the defaults are never the same object', () => {
    const config = normaliseDivConfig(undefined)
    expect(config).toEqual(DIV_DEFAULTS)
    expect(config).not.toBe(DIV_DEFAULTS)
  })
})

describe('what a pane stores', () => {
  test('only the differences, and they read back to the same config', () => {
    const config = normaliseDivConfig({ ...DIV_DEFAULTS, line: { ...DIV_DEFAULTS.line, style: 'solid', width: 2, bearColor: '#ff00ff' } })
    const stored = toStoredDivConfig(config)
    expect(stored).toEqual({ 'line.style': 'solid', 'line.width': 2, 'line.bearColor': '#ff00ff' })
    expect(fromStoredDivConfig(JSON.parse(JSON.stringify(stored)))).toEqual(config)
  })

  test('an untouched pane stores nothing', () => {
    expect(toStoredDivConfig(structuredClone(DIV_DEFAULTS))).toBeUndefined()
  })

  test('a stored document from another build: unknown paths ignored, bad values dropped', () => {
    expect(fromStoredDivConfig({ 'line.glow': 3, 'line.width': 'wide' })).toBeUndefined()
    expect(fromStoredDivConfig({ 'rule.hidden': true, 'line.sparkle': 1 })?.rule.hidden).toBe(true)
    expect(fromStoredDivConfig(['line.width', 2])).toBeUndefined()
    expect(fromStoredDivConfig(null)).toBeUndefined()
  })
})
