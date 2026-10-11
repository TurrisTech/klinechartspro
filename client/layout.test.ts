import { afterAll, describe, expect, test } from 'bun:test'
import type { PaneSnapshot, PaneStyleOverrides } from '../src'

// `window` does not exist under bun, and client/config.ts reads it at MODULE LOAD -- this
// module reaches it through ./symbols. Installed before the dynamic import rather than at the
// top of the file, for the reason client/preferences.test.ts spells out: a static import is
// hoisted above it and crashes on load.
const hadWindow = 'window' in globalThis
;(globalThis as Record<string, unknown>).window = {
  location: { href: 'http://localhost/', origin: 'http://localhost' },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  // klinecharts sniffs the platform at import; the golden test reaches it through the plugins.
  navigator: { userAgent: 'test' }
}

const { defaultLayout, hydrateLayout, isPersistedLayout, layoutSettingsSignature, toPaneOptions, toPersistedLayout } =
  await import('./layout')
const { PaneConfigStore } = await import('./plugins/paneconfig')
const { builtinPlugins } = await import('./plugins/registry')
const { createLevelsIndicators } = await import('./levels/indicator')
const golden = (await import('./plugins/fixtures/panedocs-golden.json')).default

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
  view: null,
  styleOverrides: {}
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

  test("each pane carries its plugins' settings through untouched: read into `plugins`, written from the host's", async () => {
    const sync = { crosshair: true, time: true, auto: false, symbol: false, period: false }
    const hydrated = await hydrateOffline({
      ...OLD_DOCUMENT,
      panes: [
        { s: 'EURUSD', p: '1h', mtf: { '4h': { color: '#123456' } }, ly: { levels: { showSpent: true } } },
        // Nothing usable: no `plugins` at all rather than an empty record.
        { s: 'GBPUSD', p: '1h', dv: {}, al: 'junk', vp: [1] }
      ]
    } as never)
    expect(hydrated.panes[0].plugins).toEqual({ mtf: { '4h': { color: '#123456' } }, ly: { levels: { showSpent: true } } })
    expect(hydrated.panes[1].plugins).toBeUndefined()
    const written = toPersistedLayout('2h', [PANE, { ...PANE, id: 'p2' }], 0, sync, { 1: { al: { arev19: { enabled: true } } } })
    expect('al' in written.panes[0]).toBe(false)
    expect(written.panes[1].al).toEqual({ arev19: { enabled: true } })
    expect(isPersistedLayout(written)).toBe(true)
  })

  test("a plugin's field never overwrites the pane's own, and an empty one is not written", () => {
    const sync = { crosshair: true, time: true, auto: false, symbol: false, period: false }
    const written = toPersistedLayout('1', [PANE], 0, sync, { 0: { s: { not: 'a ticker' }, ly: {}, vp: { rows: 60 } } })
    expect(written.panes[0].s).toBe('EURUSD')
    expect('ly' in written.panes[0]).toBe(false)
    expect(written.panes[0].vp).toEqual({ rows: 60 })
  })

  test('every plugin field reads and writes exactly as it did before the host owned them', async () => {
    // golden.json was written by main at c212b64, each plugin keeping its own settings: the
    // document handed to every plugin as client/index.ts did, and written back -- then again
    // after panes 1 and 2 swap places. mtf's legacy `graph.from`, a divergence window wider
    // than its gap, invalid values and an overlay no build declares are all in it.
    const configs = builtinPlugins(createLevelsIndicators().plugin).flatMap((plugin) => plugin.paneConfigs ?? [])
    const store = new PaneConfigStore(configs)
    const hydrated = await hydrateOffline(structuredClone(golden.document) as never)
    store.hydrate(Object.fromEntries(hydrated.panes.map((pane, index) => [index, pane.plugins])))
    const sync = { crosshair: true, time: true, auto: false, symbol: false, period: false }
    const snapshots = hydrated.panes.map((pane, index) => ({ ...PANE, id: `p${index + 1}`, symbol: pane.symbol, period: pane.period }))
    const fields = (docs: Record<number, Record<string, unknown>>) =>
      canonical(
        toPersistedLayout('3', snapshots, 0, sync, docs).panes.map((pane) =>
          Object.fromEntries(Object.entries(pane).filter(([key]) => ['mtf', 'mx', 'al', 'dv', 'vp', 'ly'].includes(key)))
        )
      )
    expect(fields(store.snapshot())).toEqual(golden.written)
    store.reorder([1, 0, 2])
    expect(fields(store.snapshot())).toEqual(golden.swapped)
  })

  test("the settings dialog's styles ride in `st`, and a pane drawing as the app says writes none", () => {
    const sync = { crosshair: true, time: true, auto: false, symbol: false, period: false }
    const styled = { ...PANE, styleOverrides: { 'candle.type': 'area', 'grid.show': false } }
    const written = toPersistedLayout('2h', [styled, { ...PANE, id: 'p2' }], 0, sync)
    expect(written.panes[0].st).toEqual({ 'candle.type': 'area', 'grid.show': false })
    expect('st' in written.panes[1]).toBe(false)
    expect(isPersistedLayout(written)).toBe(true)
  })

  test('and come back on the pane they were set on', async () => {
    const sync = { crosshair: true, time: true, auto: false, symbol: false, period: false }
    const written = toPersistedLayout(
      '2h',
      [{ ...PANE, styleOverrides: { 'candle.type': 'ohlc' } }, { ...PANE, id: 'p2' }],
      0,
      sync
    )
    const hydrated = await hydrateOffline(JSON.parse(JSON.stringify(written)))
    expect(hydrated.panes[0].styleOverrides).toEqual({ 'candle.type': 'ohlc' })
    expect(hydrated.panes[1].styleOverrides).toBeUndefined()
    expect(toPaneOptions(hydrated.panes[0]).styleOverrides).toEqual({ 'candle.type': 'ohlc' })
    // A pane that was never styled seeds no record at all rather than an empty one.
    expect('styleOverrides' in toPaneOptions(hydrated.panes[1])).toBe(false)
  })

  test('a style that is not a style field\'s shape is dropped, and an empty `st` reads as never styled', async () => {
    const hydrated = await hydrateOffline({
      ...OLD_DOCUMENT,
      panes: [
        { s: 'EURUSD', p: '1h', st: { 'candle.type': 'area', 'grid.show': 3 as unknown as boolean } },
        { s: 'EURUSD', p: '1h', st: {} },
        { s: 'EURUSD', p: '1h', st: ['candle.type'] as unknown as PaneStyleOverrides },
        { s: 'EURUSD', p: '1h', st: 'area' as unknown as PaneStyleOverrides }
      ]
    })
    // The shape is all this file judges; which PATHS exist, and what each may be set to, is
    // the library's call as it seeds the pane (src/config/settings.ts settingStyleValue).
    expect(hydrated.panes[0].styleOverrides).toEqual({ 'candle.type': 'area' })
    expect(hydrated.panes.slice(1).map((pane) => pane.styleOverrides)).toEqual([
      undefined,
      undefined,
      undefined
    ])
  })

  test('a styled pane is unsaved WORK, unlike a pan: it changes the settings signature', () => {
    const sync = { crosshair: true, time: true, auto: false, symbol: false, period: false }
    const plain = toPersistedLayout('1', [PANE], 0, sync)
    const styled = toPersistedLayout('1', [{ ...PANE, styleOverrides: { 'grid.show': false } }], 0, sync)
    expect(layoutSettingsSignature(styled)).not.toEqual(layoutSettingsSignature(plain))
  })
})

/** JSON with every object's keys sorted, as the golden file is written. */
function canonical(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
        : item
    )
  )
}

// Symbols are looked up while hydrating; offline, a lookup reads as "no configuration" rather
// than failing, which is all these tests need -- and says so, which they do not.
async function hydrateOffline(layout: Parameters<typeof hydrateLayout>[0]) {
  const realFetch = globalThis.fetch
  const realWarn = console.warn
  globalThis.fetch = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch
  console.warn = () => {}
  try {
    return await hydrateLayout(layout)
  } finally {
    globalThis.fetch = realFetch
    console.warn = realWarn
  }
}

describe('the order of the panes', () => {
  const sync = { crosshair: true, time: true, auto: false, symbol: false, period: false }

  test('sub-panes above the price pane ride in `sa`, and a pane with none above writes nothing', () => {
    const raised = { ...PANE, subIndicators: ['RSI', 'VOL', 'MACD'], subIndicatorsAbove: 2 }
    const written = toPersistedLayout('2h', [raised, { ...PANE, id: 'p2' }], 0, sync)
    expect(written.panes[0]).toMatchObject({ si: ['RSI', 'VOL', 'MACD'], sa: 2 })
    expect('sa' in written.panes[1]).toBe(false)
    expect(isPersistedLayout(written)).toBe(true)
  })

  test('and come back above it', async () => {
    const written = toPersistedLayout('1', [{ ...PANE, subIndicators: ['RSI', 'VOL'], subIndicatorsAbove: 1 }], 0, sync)
    const hydrated = await hydrateOffline(JSON.parse(JSON.stringify(written)))
    expect(hydrated.panes[0]).toMatchObject({ subIndicators: ['RSI', 'VOL'], subIndicatorsAbove: 1 })
    expect(toPaneOptions(hydrated.panes[0])).toMatchObject({ subIndicators: ['RSI', 'VOL'], subIndicatorsAbove: 1 })
  })

  test('a document without `sa`, or with one that is not a count, has the price pane on top', async () => {
    const hydrated = await hydrateOffline({
      ...OLD_DOCUMENT,
      panes: [
        { s: 'EURUSD', p: '1h', si: ['VOL'] },
        { s: 'EURUSD', p: '1h', si: ['VOL'], sa: -1 },
        { s: 'EURUSD', p: '1h', si: ['VOL'], sa: 1.5 },
        { s: 'EURUSD', p: '1h', si: ['VOL'], sa: 9 }
      ]
    })
    expect(hydrated.panes.map((pane) => pane.subIndicatorsAbove)).toEqual([0, 0, 0, 1])
  })

  test('a retired template that sat above the price pane does not pull the next one up', async () => {
    const hydrated = await hydrateOffline({
      ...OLD_DOCUMENT,
      panes: [{ s: 'EURUSD', p: '1h', si: ['KREV:krev01', 'RSI', 'VOL'], sa: 1 }]
    })
    expect(hydrated.panes[0]).toMatchObject({ subIndicators: ['RSI', 'VOL'], subIndicatorsAbove: 0 })
  })
})

