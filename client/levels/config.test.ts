import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// The Levels settings schema. Modules under it read `window` at import, so they are loaded
// after the DOM stub.
installWindow()

const { DEFAULT_LEVELS_CONFIG, LEVELS_FIELDS, LEVELS_INTERVAL_ORDER } = await import('./config')

/** Every `key` in a field tree, groups flattened. */
function fieldKeys(fields: typeof LEVELS_FIELDS): string[] {
  return fields.flatMap((field) => (field.kind === 'group' ? fieldKeys(field.fields) : [field.key]))
}

describe('interval schema', () => {
  // Levels are computed on 1W and 1M only (wdashboard-server levels.py:
  // LEVELS_INTERVAL_ALLOWLIST). A 1D toggle used to sit here, asking the server for an
  // interval it silently ignored; this pins that it stays gone from everything the order
  // list derives -- the defaults, the switches and the per-interval colour pickers.
  test('lists exactly the intervals the server computes', () => {
    expect(LEVELS_INTERVAL_ORDER).toEqual(['1W', '1M'])
  })

  test('defaults carry a toggle and a colour for each listed interval and nothing else', () => {
    expect(Object.keys(DEFAULT_LEVELS_CONFIG.intervals).sort()).toEqual([...LEVELS_INTERVAL_ORDER].sort())
    expect(Object.keys(DEFAULT_LEVELS_CONFIG.base.intervalColors).sort()).toEqual(
      [...LEVELS_INTERVAL_ORDER].sort()
    )
    for (const code of LEVELS_INTERVAL_ORDER) expect(DEFAULT_LEVELS_CONFIG.intervals[code]).toBe(true)
  })

  test('the settings panel offers a switch and a colour per listed interval and no 1D field', () => {
    const keys = fieldKeys(LEVELS_FIELDS)
    for (const code of LEVELS_INTERVAL_ORDER) {
      expect(keys).toContain(`intervals.${code}`)
      expect(keys).toContain(`base.intervalColors.${code}`)
    }
    expect(keys.filter((key) => key.includes('1D'))).toEqual([])
  })
})

describe('alerts', () => {
  test('the default zone of a new alert is a setting of its own, near the top of the panel', () => {
    expect(DEFAULT_LEVELS_CONFIG.alerts.zonePips).toBe(3)
    const index = LEVELS_FIELDS.findIndex((field) => field.kind === 'group' && field.label === 'Alerts')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(index).toBeLessThanOrEqual(2)
    expect(fieldKeys([LEVELS_FIELDS[index]])).toEqual(['alerts.zonePips'])
  })
})
