import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// The Levels settings schema, and what a saved preferences document from before a schema
// change does to it. `client/config.ts` (reached through chartlayers/store.ts) reads
// `window` at import, so the modules under test are loaded after the DOM stub.
installWindow()

const { DEFAULT_LEVELS_CONFIG, LEVELS_FIELDS, LEVELS_INTERVAL_ORDER } = await import('./config')
const { loadLayerConfig } = await import('../chartlayers/store')
const { hasFeature } = await import('../capabilities')

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

describe('loading a saved document from before 1D was dropped', () => {
  // Preferences persist per user, so a document written while 1D was a toggle is still out
  // there. Loading one must neither throw nor bring the toggle back: the stored `1D` keys are
  // to be dropped, and the user's other choices kept. Exercised through the localStorage
  // branch of loadLayerConfig, which is what a server that does not advertise `preferences`
  // (prod) falls back to; the merge is the same function either way.
  const store = new Map<string, string>()
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window
  const hadStorage = 'localStorage' in win
  const priorStorage = win.localStorage

  beforeAll(() => {
    win.localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key)
    }
  })
  afterAll(() => {
    if (hadStorage) win.localStorage = priorStorage
    else delete win.localStorage
  })

  test('drops the stale 1D keys and keeps every other stored choice', async () => {
    // The localStorage branch is the one under test; the preferences branch would go to a
    // server, and no test file installs that feature.
    expect(hasFeature('preferences')).toBe(false)
    store.set(
      'wd.layer.levels',
      JSON.stringify({
        ...DEFAULT_LEVELS_CONFIG,
        intervals: { '1D': true, '1W': false, '1M': true },
        showSpent: true,
        base: {
          ...DEFAULT_LEVELS_CONFIG.base,
          intervalColors: { '1D': '#00BCD4', '1W': '#123456', '1M': '#FFEB3B' }
        }
      })
    )

    const loaded = await loadLayerConfig('levels', DEFAULT_LEVELS_CONFIG)

    expect(Object.keys(loaded.intervals).sort()).toEqual([...LEVELS_INTERVAL_ORDER].sort())
    expect('1D' in loaded.intervals).toBe(false)
    expect('1D' in loaded.base.intervalColors).toBe(false)
    // The choices that still mean something survive the merge.
    expect(loaded.intervals['1W']).toBe(false)
    expect(loaded.intervals['1M']).toBe(true)
    expect(loaded.showSpent).toBe(true)
    expect(loaded.base.intervalColors['1W']).toBe('#123456')
  })

  test('a document with only the old keys yields the defaults for the current ones', async () => {
    store.set('wd.layer.levels', JSON.stringify({ intervals: { '1D': true } }))
    const loaded = await loadLayerConfig('levels', DEFAULT_LEVELS_CONFIG)
    expect(loaded.intervals).toEqual(DEFAULT_LEVELS_CONFIG.intervals)
    expect(loaded.base.intervalColors).toEqual(DEFAULT_LEVELS_CONFIG.base.intervalColors)
  })
})
