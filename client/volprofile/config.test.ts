import { describe, expect, test } from 'bun:test'
import { fromStoredVpConfig, normaliseVpConfig, toStoredVpConfig, VP_DEFAULTS, VP_FIELDS } from './config'

// One pane's settings: complete and drawable whatever arrives, and stored as only what differs.

describe('the defaults', () => {
  test('the visible range at 40 rows, a 70% value area, the source chosen automatically', () => {
    expect(VP_DEFAULTS).toMatchObject({ mode: 'visible', session: 'D', rows: 40, valueArea: 70, source: 'auto' })
  })

  test('the panel edits every setting, by the path it is stored under', () => {
    const keys = VP_FIELDS.flatMap((f) => (f.kind === 'group' ? f.fields : [f])).map((f) => ('key' in f ? f.key : ''))
    expect(keys.sort()).toEqual(
      [
        'mode',
        'session',
        'rows',
        'valueArea',
        'source',
        'draw.width',
        'draw.opacity',
        'draw.showPoc',
        'draw.showValueArea',
        'draw.upColor',
        'draw.downColor',
        'draw.pocColor'
      ].sort()
    )
  })

  test('the session period is offered only in session mode', () => {
    const session = VP_FIELDS.flatMap((f) => (f.kind === 'group' ? f.fields : [f])).find((f) => 'key' in f && f.key === 'session')
    expect(session?.when).toEqual({ key: 'mode', is: ['session'] })
  })
})

describe('normalising what the panel commits', () => {
  test('numbers are clamped and whole where they must be; junk falls back to the default', () => {
    const config = normaliseVpConfig({
      mode: 'session',
      session: 'Q',
      rows: 3.7,
      valueArea: '99',
      source: '5s',
      draw: { width: 250, opacity: 0.333, showPoc: 'yes', upColor: 'green', pocColor: '#123abc' }
    })
    expect(config).toMatchObject({ mode: 'session', session: 'D', rows: 10, valueArea: 95, source: 'auto' })
    expect(config.draw).toMatchObject({ width: 100, opacity: 0.333, showPoc: true, upColor: '#26A69A', pocColor: '#123abc' })
  })

  test('anything that is not an object is the defaults', () => {
    expect(normaliseVpConfig(null)).toEqual(VP_DEFAULTS)
    expect(normaliseVpConfig('x')).toEqual(VP_DEFAULTS)
  })
})

describe('storing a pane', () => {
  test('only what differs, flat by path, and it reads back to the same config', () => {
    const config = structuredClone(VP_DEFAULTS)
    config.mode = 'session'
    config.rows = 60
    config.draw.pocColor = '#ffffff'
    const stored = toStoredVpConfig(config)
    expect(stored).toEqual({ mode: 'session', rows: 60, 'draw.pocColor': '#ffffff' })
    expect(fromStoredVpConfig(JSON.parse(JSON.stringify(stored)))).toEqual(config)
  })

  test('an untouched pane stores nothing, and nothing usable reads as never configured', () => {
    expect(toStoredVpConfig(VP_DEFAULTS)).toBeUndefined()
    expect(fromStoredVpConfig({ rows: 'many', future: 1 })).toBeUndefined()
    expect(fromStoredVpConfig([1])).toBeUndefined()
  })
})
