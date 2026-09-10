import { afterAll, describe, expect, test } from 'bun:test'
import type { PaneSnapshot } from '../src'

// `window` does not exist under bun, and client/config.ts reads it at MODULE LOAD -- this
// module reaches it through ./symbols. Installed before the dynamic import rather than at the
// top of the file, for the reason client/preferences.test.ts spells out: a static import is
// hoisted above it and crashes on load.
const hadWindow = 'window' in globalThis
;(globalThis as Record<string, unknown>).window = {
  location: { href: 'http://localhost/', origin: 'http://localhost' },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
}

const { defaultLayout, isPersistedLayout, toPersistedLayout } = await import('./layout')

afterAll(() => {
  if (!hadWindow) delete (globalThis as Record<string, unknown>).window
})

// A persisted layout outlives the code that wrote it: every sync switch was added after some
// documents were already stored, so an older one must still validate and read as "that switch
// was off" rather than dropping the whole workspace.

const OLD_DOCUMENT = {
  version: 1,
  preset: '2h',
  active: 0,
  panes: [{ s: 'EURUSD', p: '1h' }, { s: 'GBPUSD', p: '1h' }],
  sync: { crosshair: true, time: true }
}

const PANE: PaneSnapshot = {
  id: 'p1',
  symbol: { ticker: 'EURUSD', exchange: 'oanda' },
  period: { multiplier: 1, timespan: 'hour', text: '1h' },
  mainIndicators: ['MA'],
  subIndicators: ['VOL'],
  indicatorParams: {},
  view: null
}

describe('isPersistedLayout', () => {
  test('a document written before auto/symbol/period sync existed still validates', () => {
    expect(isPersistedLayout(OLD_DOCUMENT)).toBe(true)
    expect(isPersistedLayout({ ...OLD_DOCUMENT, sync: { crosshair: true, time: false, auto: true } }))
      .toBe(true)
    expect(
      isPersistedLayout({
        ...OLD_DOCUMENT,
        sync: { crosshair: true, time: true, auto: false, symbol: true, period: true }
      })
    ).toBe(true)
  })

  test('a switch stated as anything but a boolean is not a layout', () => {
    for (const key of ['auto', 'symbol', 'period']) {
      const sync = { crosshair: true, time: true, [key]: 'yes' }
      expect(isPersistedLayout({ ...OLD_DOCUMENT, sync })).toBe(false)
    }
    // The two that were always required stay required.
    expect(isPersistedLayout({ ...OLD_DOCUMENT, sync: { time: true } })).toBe(false)
  })
})

describe('a round trip through the document', () => {
  test('a new workspace opens with both wall-wide switches off', () => {
    expect(defaultLayout('EURUSD').sync).toMatchObject({ symbol: false, period: false })
  })

  test('the live wall writes every switch, whatever it was hydrated from', () => {
    const sync = { crosshair: false, time: true, auto: true, symbol: true, period: false }
    const written = toPersistedLayout('2h', [PANE, { ...PANE, id: 'p2' }], 1, sync)
    expect(written.sync).toEqual(sync)
    expect(isPersistedLayout(written)).toBe(true)
  })
})
