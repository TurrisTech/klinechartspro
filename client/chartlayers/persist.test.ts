import { describe, expect, test } from 'bun:test'
import { DEFAULT_LEVELS2_CONFIG, LEVELS2_FIELDS } from '../levels2/config'
import { DEFAULT_LEVELS_CONFIG, LEVELS_FIELDS } from '../levels/config'
import { layerConfigCodec } from './persist'

// What a pane stores for a layer, and what is allowed back in. A stored document may come
// from another build, or from the wall-wide preference the layers kept before they were
// indicators, so nothing reaches the drawing code unchecked.

const levels = layerConfigCodec(DEFAULT_LEVELS_CONFIG, LEVELS_FIELDS)
const zones = layerConfigCodec(DEFAULT_LEVELS2_CONFIG, LEVELS2_FIELDS)

describe('the stored form', () => {
  test('an untouched pane stores nothing', () => {
    expect(levels.toStored(DEFAULT_LEVELS_CONFIG)).toBeUndefined()
    expect(zones.toStored(DEFAULT_LEVELS2_CONFIG)).toBeUndefined()
  })

  test('only what differs, flat by path, and it reads back to the same config', () => {
    const config = structuredClone(DEFAULT_LEVELS_CONFIG)
    config.showSpent = true
    config.intervals['1M'] = false
    config.base.colorMode = 'interval'
    config.base.intervalColors['1W'] = '#123456'
    config.emphasis.age.domain[1] = 365
    const stored = levels.toStored(config)
    expect(stored).toEqual({
      'intervals.1M': false,
      showSpent: true,
      'base.colorMode': 'interval',
      'base.intervalColors.1W': '#123456',
      'emphasis.age.domain.1': 365
    })
    expect(levels.fromStored(JSON.parse(JSON.stringify(stored)))).toEqual(config)
  })

  test('each value is held to its field: clamped, an unknown option or a non-colour dropped', () => {
    const read = levels.fromStored({
      'base.width': 100,
      'base.colorMode': 'rainbow',
      'base.directionColors.support': 'red',
      showSpent: 'yes',
      'emphasis.invalidations.range.1': '2.5'
    })
    expect(read?.base.width).toBe(8)
    expect(read?.base.colorMode).toBe(DEFAULT_LEVELS_CONFIG.base.colorMode)
    expect(read?.base.directionColors.support).toBe(DEFAULT_LEVELS_CONFIG.base.directionColors.support)
    expect(read?.showSpent).toBe(false)
    expect(read?.emphasis.invalidations.range[1]).toBe(2.5)
  })

  test('nothing usable reads as never configured', () => {
    expect(levels.fromStored({ 'base.width': 'thick', 'intervals.1D': true })).toBeUndefined()
    expect(levels.fromStored([1])).toBeUndefined()
    expect(levels.fromStored(null)).toBeUndefined()
  })
})

describe('normalise', () => {
  test("the toolbar-era preference: nested, whole, with a 1D toggle no server serves", () => {
    const legacy = structuredClone(DEFAULT_LEVELS_CONFIG) as unknown as Record<string, unknown>
    ;(legacy.intervals as Record<string, boolean>)['1D'] = true
    ;(legacy.base as Record<string, unknown>).pattern = 'dashed'
    const config = levels.normalise(legacy)
    expect(config.intervals).toEqual({ '1W': true, '1M': true })
    expect(config.base.pattern).toBe('dashed')
  })

  test('is a copy, never the defaults object itself', () => {
    const config = zones.normalise(undefined)
    expect(config).toEqual(DEFAULT_LEVELS2_CONFIG)
    config.base.fillOpacity = 0.9
    expect(DEFAULT_LEVELS2_CONFIG.base.fillOpacity).toBe(0.18)
  })
})
