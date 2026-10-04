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

const { defaultLayout, hydrateLayout, isPersistedLayout, overlayPaneState, toPaneOptions, toPersistedLayout } =
  await import('./layout')
const { LAB_DEFAULTS, fromStoredLabConfig } = await import('./arevlab/config')
const { MTF_DEFAULTS, fromStoredMtfConfig } = await import('./mtf/config')
const { DIV_DEFAULTS, fromStoredDivConfig } = await import('./arev21div/config')
const { VP_DEFAULTS, fromStoredVpConfig } = await import('./volprofile/config')

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

  test("each pane carries its own plugins' settings, and a pane on the defaults carries none", () => {
    const sync = { crosshair: true, time: true, auto: false, symbol: false, period: false }
    const lab = structuredClone(LAB_DEFAULTS)
    lab.generations.arev19.enabled = true
    lab.generations.arev19.signals = 'rank'
    const mtf = structuredClone(MTF_DEFAULTS)
    mtf.timeframes['4h'].enabled = !mtf.timeframes['4h'].enabled
    const written = toPersistedLayout('3h', [PANE, { ...PANE, id: 'p2' }, { ...PANE, id: 'p3' }], 0, sync, {
      mtf: { 0: mtf },
      arevlab: { 0: lab, 1: structuredClone(LAB_DEFAULTS) }
    })
    expect(written.panes[0].al).toEqual({ arev19: { enabled: true, signals: 'rank' } })
    expect(written.panes[0].mtf).toBeDefined()
    expect('al' in written.panes[1]).toBe(false)
    expect('al' in written.panes[2]).toBe(false)
    expect(isPersistedLayout(written)).toBe(true)
    // What hydrateLayout does with the field, minus the symbol lookup it needs a server for.
    expect(fromStoredLabConfig(JSON.parse(JSON.stringify(written.panes[0].al)))).toEqual(lab)
  })

  test("the AREV21 divergence's settings ride in `dv`, only what differs from the defaults", () => {
    const sync = { crosshair: true, time: true, auto: false, symbol: false, period: false }
    const div = structuredClone(DIV_DEFAULTS)
    div.line.style = 'dashed'
    div.line.bullColor = '#00ff88'
    div.rule.hidden = true
    const written = toPersistedLayout('2h', [PANE, { ...PANE, id: 'p2' }], 0, sync, {
      arev21div: { 0: div, 1: structuredClone(DIV_DEFAULTS) }
    })
    expect(written.panes[0].dv).toEqual({ 'rule.hidden': true, 'line.style': 'dashed', 'line.bullColor': '#00ff88' })
    expect('dv' in written.panes[1]).toBe(false)
    expect(isPersistedLayout(written)).toBe(true)
    expect(fromStoredDivConfig(JSON.parse(JSON.stringify(written.panes[0].dv)))).toEqual(div)
  })

  test("the volume profile's settings ride in `vp`, only what differs from the defaults", () => {
    const sync = { crosshair: true, time: true, auto: false, symbol: false, period: false }
    const vp = structuredClone(VP_DEFAULTS)
    vp.mode = 'session'
    vp.draw.showPoc = false
    const written = toPersistedLayout('2h', [PANE, { ...PANE, id: 'p2' }], 0, sync, {
      volprofile: { 0: vp, 1: structuredClone(VP_DEFAULTS) }
    })
    expect(written.panes[0].vp).toEqual({ mode: 'session', 'draw.showPoc': false })
    expect('vp' in written.panes[1]).toBe(false)
    expect(isPersistedLayout(written)).toBe(true)
    expect(fromStoredVpConfig(JSON.parse(JSON.stringify(written.panes[0].vp)))).toEqual(vp)
  })

  test("Levels' and Zones' settings ride in `ly`, by layer id, as the layers stored them", () => {
    const sync = { crosshair: true, time: true, auto: false, symbol: false, period: false }
    const written = toPersistedLayout('2h', [PANE, { ...PANE, id: 'p2' }, { ...PANE, id: 'p3' }], 0, sync, {
      levels: {
        0: { levels: { showSpent: true }, levels2: { 'intervals.4h': true } },
        // Nothing usable: the pane writes no `ly` at all rather than an empty record.
        2: { levels: {}, levels2: [] as unknown as Record<string, unknown> }
      }
    })
    expect(written.panes[0].ly).toEqual({ levels: { showSpent: true }, levels2: { 'intervals.4h': true } })
    expect('ly' in written.panes[1]).toBe(false)
    expect('ly' in written.panes[2]).toBe(false)
    expect(isPersistedLayout(written)).toBe(true)
  })

  test("the outlier MTF overlays' settings ride in `mx`, by plugin id, apart from AREV21 MTF's", () => {
    const sync = { crosshair: true, time: true, auto: false, symbol: false, period: false }
    const r90 = structuredClone(MTF_DEFAULTS)
    r90.timeframes['1D'].color = '#123456'
    const written = toPersistedLayout('2h', [PANE, { ...PANE, id: 'p2' }], 0, sync, {
      mtf: { 0: structuredClone(MTF_DEFAULTS) },
      mtf_arev21_outlier_rank_90: { 1: r90 },
      mtf_arev21_outlier_rank_85: { 0: structuredClone(MTF_DEFAULTS) }
    })
    // Defaults store nothing, whichever overlay they belong to.
    expect('mx' in written.panes[0]).toBe(false)
    expect('mtf' in written.panes[0]).toBe(false)
    expect(written.panes[1].mx).toEqual({ mtf_arev21_outlier_rank_90: { '1D': { color: '#123456' } } })
    expect('mtf' in written.panes[1]).toBe(false)
    expect(isPersistedLayout(written)).toBe(true)
    // And back: what hydrateLayout files per pane, turned round into the host's shape.
    const back = fromStoredMtfConfig(JSON.parse(JSON.stringify(written.panes[1].mx?.mtf_arev21_outlier_rank_90)))
    expect(back).toEqual(r90)
    const panes = [{}, { mtfOverlayConfigs: { mtf_arev21_outlier_rank_90: r90 } }] as never
    expect(overlayPaneState(panes)).toEqual({ mtf_arev21_outlier_rank_90: { 1: r90 } })
  })
})

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

